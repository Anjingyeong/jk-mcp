import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectRegistryEntry } from "../types.js";
import { DomainError, ErrorCode } from "../types.js";

export const EXECUTOR_HEARTBEAT_TTL_MS = 35_000;
const EXECUTOR_STATE_VERSION = 1;
const EXECUTOR_STATE_FILE = "executors.json";
const DEFAULT_JOB_TIMEOUT_MS = 60_000;

export type ExecutorToolName =
  | "project_status"
  | "project_rules"
  | "repo_status"
  | "repo_diff_summary"
  | "code_search"
  | "file_read_slice"
  | "file_apply_patch"
  | "file_create"
  | "command_list"
  | "command_run"
  | "local_shell_run"
  | "executor_restart";

export interface ExecutorProjectSnapshot {
  projectId: string;
  name: string;
  root: string;
  aliases: string[];
  branch?: string;
  dirty?: boolean;
  hasAgentsMd?: boolean;
  hasCodeBrain?: boolean;
  packageHints?: string[];
  lastSeenAt?: string;
}

export interface ExecutorHeartbeat {
  executorId: string;
  label?: string;
  platform: string;
  workspaceRoot: string;
  projects: ExecutorProjectSnapshot[];
  capabilities?: ExecutorToolName[];
}

export interface ExecutorStatus extends ExecutorHeartbeat {
  lastSeenAtMs: number;
  online: boolean;
}

interface StoredExecutor extends ExecutorHeartbeat {
  lastSeenAtMs: number;
}

interface ExecutorStateFile {
  version: number;
  updatedAt: number;
  executors: Record<string, StoredExecutor>;
  routes: Record<string, string>;
}

export interface ExecutorJob {
  jobId: string;
  executorId: string;
  tool: ExecutorToolName;
  payload: Record<string, unknown>;
  createdAt: number;
}

interface PendingJob {
  job: ExecutorJob;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const queues = new Map<string, ExecutorJob[]>();
const waiters = new Map<string, Array<(job: ExecutorJob | null) => void>>();
const pending = new Map<string, PendingJob>();

function statePath(stateDir: string): string {
  return path.join(stateDir, EXECUTOR_STATE_FILE);
}

function emptyState(): ExecutorStateFile {
  return { version: EXECUTOR_STATE_VERSION, updatedAt: Date.now(), executors: {}, routes: {} };
}

async function loadState(stateDir: string): Promise<ExecutorStateFile> {
  try {
    const parsed = JSON.parse(await readFile(statePath(stateDir), "utf8")) as Partial<ExecutorStateFile>;
    return {
      version: EXECUTOR_STATE_VERSION,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      executors: parsed.executors && typeof parsed.executors === "object" ? parsed.executors as Record<string, StoredExecutor> : {},
      routes: parsed.routes && typeof parsed.routes === "object" ? parsed.routes as Record<string, string> : {},
    };
  } catch {
    return emptyState();
  }
}

async function saveState(stateDir: string, state: ExecutorStateFile): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = statePath(stateDir);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify({ ...state, version: EXECUTOR_STATE_VERSION, updatedAt: Date.now() }, null, 2)}\n`;
  await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

function validateExecutorId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid executor id", { executorId: value });
  }
  return id;
}

export async function recordExecutorHeartbeat(stateDir: string, heartbeat: ExecutorHeartbeat): Promise<ExecutorStatus> {
  const executorId = validateExecutorId(heartbeat.executorId);
  const now = Date.now();
  const state = await loadState(stateDir);
  const stored: StoredExecutor = {
    executorId,
    label: heartbeat.label?.trim() || executorId,
    platform: heartbeat.platform,
    workspaceRoot: heartbeat.workspaceRoot,
    projects: heartbeat.projects,
    capabilities: heartbeat.capabilities,
    lastSeenAtMs: now,
  };
  state.executors[executorId] = stored;
  await saveState(stateDir, state);
  return { ...stored, online: true };
}

export async function listExecutorStatus(stateDir: string, now = Date.now()): Promise<ExecutorStatus[]> {
  const state = await loadState(stateDir);
  return Object.values(state.executors)
    .map((executor) => ({ ...executor, online: now - executor.lastSeenAtMs <= EXECUTOR_HEARTBEAT_TTL_MS }))
    .sort((a, b) => a.executorId.localeCompare(b.executorId));
}

export async function setProjectExecutorRoute(stateDir: string, projectId: string, executorId: string | null): Promise<void> {
  const state = await loadState(stateDir);
  if (executorId === null || executorId === "local") {
    state.routes[projectId] = "local";
  } else {
    const id = validateExecutorId(executorId);
    if (!state.executors[id]) {
      throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Executor not registered: ${id}`, { executorId: id });
    }
    state.routes[projectId] = id;
  }
  await saveState(stateDir, state);
}

export async function getProjectExecutorRoutes(stateDir: string): Promise<Record<string, string>> {
  return { ...(await loadState(stateDir)).routes };
}

export async function getExecutorProjectRegistry(
  stateDir: string,
  localProjects: ProjectRegistryEntry[],
): Promise<ProjectRegistryEntry[]> {
  const now = Date.now();
  const state = await loadState(stateDir);
  const localById = new Map(localProjects.map((project) => [project.projectId, project]));
  const remote: ProjectRegistryEntry[] = [];

  for (const executor of Object.values(state.executors)) {
    if (now - executor.lastSeenAtMs > EXECUTOR_HEARTBEAT_TTL_MS) continue;
    for (const project of executor.projects) {
      const hasLocalCollision = localById.has(project.projectId)
        || project.aliases.some((alias) => localById.has(alias));
      const projectId = hasLocalCollision
        ? `${executor.executorId}::${project.projectId}`
        : project.projectId;
      remote.push({
        ...project,
        projectId,
        aliases: Array.from(new Set([
          ...project.aliases,
          project.name,
          project.projectId,
          `${executor.executorId}:${project.name}`,
        ])),
        executorId: executor.executorId,
        executorKind: "remote",
        executorOnline: true,
        sourceProjectId: project.projectId,
      });
    }
  }

  return remote;
}

export async function resolveRoutedLocalProject(
  stateDir: string,
  localProject: ProjectRegistryEntry,
): Promise<ProjectRegistryEntry> {
  const state = await loadState(stateDir);
  const route = state.routes[localProject.projectId];
  if (!route || route === "local") return localProject;
  const executor = state.executors[route];
  if (!executor || Date.now() - executor.lastSeenAtMs > EXECUTOR_HEARTBEAT_TTL_MS) return localProject;
  const remote = executor.projects.find((project) =>
    project.projectId === localProject.projectId || project.aliases.includes(localProject.projectId),
  );
  if (!remote) return localProject;
  return {
    ...remote,
    projectId: localProject.projectId,
    aliases: Array.from(new Set([...localProject.aliases, ...remote.aliases, remote.name])),
    executorId: route,
    executorKind: "remote",
    executorOnline: true,
    sourceProjectId: remote.projectId,
  };
}

function deliverQueuedJob(executorId: string, job: ExecutorJob): void {
  const executorWaiters = waiters.get(executorId);
  const waiter = executorWaiters?.shift();
  if (waiter) {
    waiter(job);
    if (executorWaiters?.length === 0) waiters.delete(executorId);
    return;
  }
  const queue = queues.get(executorId) ?? [];
  queue.push(job);
  queues.set(executorId, queue);
}

export async function dispatchExecutorJob<T = unknown>(
  stateDir: string,
  executorId: string,
  tool: ExecutorToolName,
  payload: Record<string, unknown>,
  timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
): Promise<T> {
  const statuses = await listExecutorStatus(stateDir);
  const executor = statuses.find((candidate) => candidate.executorId === executorId);
  if (!executor?.online) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Executor is offline: ${executorId}`, { executorId });
  }
  if (executor.capabilities?.length && !executor.capabilities.includes(tool)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Executor does not support ${tool}`, { executorId, tool });
  }

  const job: ExecutorJob = { jobId: randomUUID(), executorId, tool, payload, createdAt: Date.now() };
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(job.jobId);
      reject(new DomainError(ErrorCode.TIMEOUT, `Executor job timed out: ${tool}`, { executorId, tool }));
    }, Math.max(1_000, timeoutMs));
    pending.set(job.jobId, {
      job,
      resolve: (result) => resolve(result as T),
      reject,
      timeout,
    });
    deliverQueuedJob(executorId, job);
  });
}

export async function pollExecutorJob(executorId: string, waitMs = 20_000): Promise<ExecutorJob | null> {
  const id = validateExecutorId(executorId);
  const queue = queues.get(id);
  const queued = queue?.shift();
  if (queued) {
    if (queue?.length === 0) queues.delete(id);
    return queued;
  }
  const effectiveWaitMs = Math.min(Math.max(waitMs, 0), 25_000);
  if (effectiveWaitMs === 0) return null;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (job: ExecutorJob | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(job);
    };
    const timer = setTimeout(() => {
      const executorWaiters = waiters.get(id) ?? [];
      const index = executorWaiters.indexOf(finish);
      if (index >= 0) executorWaiters.splice(index, 1);
      if (executorWaiters.length === 0) waiters.delete(id);
      finish(null);
    }, effectiveWaitMs);
    const executorWaiters = waiters.get(id) ?? [];
    executorWaiters.push(finish);
    waiters.set(id, executorWaiters);
  });
}

export function completeExecutorJob(jobId: string, result: unknown, error?: string, executorId?: string): boolean {
  const item = pending.get(jobId);
  if (!item) return false;
  if (executorId && item.job.executorId !== executorId) return false;
  pending.delete(jobId);
  clearTimeout(item.timeout);
  if (error) item.reject(new Error(error));
  else item.resolve(result);
  return true;
}
