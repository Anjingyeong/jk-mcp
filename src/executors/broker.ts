import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { renameWithRetry } from "../util/fs-retry.js";
import path from "node:path";
import { z } from "zod";
import type { ProjectRegistryEntry } from "../types.js";
import { DomainError, ErrorCode } from "../types.js";
import {
  EXECUTOR_PROTOCOL_VERSION, RuntimeIdentitySchema, ExecutionTargetSchema, DURABLE_RESULT_CAPABILITY, EXECUTOR_CONTROL_CAPABILITY,
  DurableResultSubmissionSchema, type DurableDeliveryOffer, type DurableResultAck, type DurableResultSubmission,
  deriveLocalExecutionTarget, deriveRemoteExecutionTarget, sameExecutionTarget, sameRuntimeIdentity,
  type ExecutionTarget, type RuntimeIdentity, type ExecutorControl,
} from "./target-protocol.js";

import {
  createJobDeliveryClaim, offerJobDeliveryClaim, recordJobDeliveryReceipt, normalizeDeliveryJson,
  JobDeliveryError, type JobDeliveryClaim, type JobDeliveryOwnerBinding,
} from "./job-delivery-store.js";

export const EXECUTOR_HEARTBEAT_TTL_MS = 35_000;
const EXECUTOR_STATE_VERSION = 1;
const EXECUTOR_STATE_FILE = "executors.json";
const DEFAULT_JOB_TIMEOUT_MS = 60_000;

export type ExecutorToolName =
  | "project_status"
  | "project_rules"
  | "repo_status"
  | "repo_diff_summary"
  | "git_sync_start"
  | "code_search"
  | "file_read_slice"
  | "file_apply_patch"
  | "file_create"
  | "command_list"
  | "command_run"
  | "local_shell_run"
  | "list_images"
  | "retrieve_image"
  | "e2e_screenshot"
  | "computer_screenshot"
  | "computer_action"
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

export interface ExecutorHeartbeat extends RuntimeIdentity {
  label?: string;
  platform: string;
  workspaceRoot: string;
  projects: ExecutorProjectSnapshot[];
  startedAtMs?: number;
}

export interface ExecutorStatus extends StoredExecutor {
  lastSeenAtMs: number;
  online: boolean;
  compatible: boolean;
}

type StoredExecutor = z.infer<typeof StoredExecutorSchema>;

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
  protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION;
  runtime: RuntimeIdentity;
  executionTarget?: ExecutionTarget;
  delivery?: DurableDeliveryOffer;
}

interface PendingJob {
  stateDir: string;
  job: ExecutorJob;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingRestartControl {
  stateDir: string;
  executorId: string;
  instanceId: string;
  requestId: string;
  reason: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingJobCancelControl {
  stateDir: string;
  executorId: string;
  instanceId: string;
  jobId: string;
  reason: string;
  timeout: NodeJS.Timeout;
}

const queues = new Map<string, ExecutorJob[]>();
const waiters = new Map<string, Array<(job: ExecutorJob | null) => void>>();
const pending = new Map<string, PendingJob>();
const restartControls = new Map<string, PendingRestartControl>();
const jobCancelControls = new Map<string, PendingJobCancelControl>();

const ProjectSnapshotSchema = z.object({
  projectId: z.string().min(1), name: z.string().min(1),
  root: ExecutionTargetSchema.shape.projectRoot, aliases: z.array(z.string()),
  branch: z.string().optional(), dirty: z.boolean().optional(), hasAgentsMd: z.boolean().optional(),
  hasCodeBrain: z.boolean().optional(), packageHints: z.array(z.string()).optional(), lastSeenAt: z.string().optional(),
}).passthrough();
const HeartbeatSchema = RuntimeIdentitySchema.extend({
  role: z.literal("worker"), platform: z.string().min(1), projects: z.array(ProjectSnapshotSchema),
  label: z.string().optional(), startedAtMs: z.number().optional(),
});
// Legacy persisted workers remain visible as incompatible, never executable.
const StoredExecutorSchema = HeartbeatSchema.partial({
  role: true, instanceId: true, os: true, arch: true,
}).extend({
  protocolVersion: z.number().optional(), capabilities: z.array(z.string()).optional(),
  lastSeenAtMs: z.number(),
});

function denied(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message, details);
}

function queueKey(stateDir: string, executorId: string, instanceId: string): string {
  return JSON.stringify([path.resolve(stateDir), executorId, instanceId]);
}

function controlKey(stateDir: string, executorId: string, instanceId: string): string {
  return queueKey(stateDir, executorId, instanceId);
}

function discardRestartControl(item: PendingRestartControl, error: Error): void {
  const key = controlKey(item.stateDir, item.executorId, item.instanceId);
  if (restartControls.get(key) === item) restartControls.delete(key);
  clearTimeout(item.timeout);
  item.reject(error);
}

function discardJobCancelControl(item: PendingJobCancelControl): void {
  const key = controlKey(item.stateDir, item.executorId, item.instanceId);
  if (jobCancelControls.get(key) === item) jobCancelControls.delete(key);
  clearTimeout(item.timeout);
}

function requestJobCancellation(item: PendingJob, reason: string): void {
  if (!item.job.runtime.capabilities.includes(EXECUTOR_CONTROL_CAPABILITY)) return;
  const key = controlKey(item.stateDir, item.job.executorId, item.job.runtime.instanceId);
  const queued = queues.get(key)?.some((job) => job.jobId === item.job.jobId) ?? false;
  if (queued) return;
  const previous = jobCancelControls.get(key);
  if (previous) discardJobCancelControl(previous);
  const control: PendingJobCancelControl = {
    stateDir: item.stateDir,
    executorId: item.job.executorId,
    instanceId: item.job.runtime.instanceId,
    jobId: item.job.jobId,
    reason: reason.slice(0, 240),
    timeout: undefined as unknown as NodeJS.Timeout,
  };
  control.timeout = setTimeout(() => discardJobCancelControl(control), 60_000);
  control.timeout.unref?.();
  jobCancelControls.set(key, control);
}

function discardJob(item: PendingJob, error: Error): void {
  pending.delete(item.job.jobId);
  clearTimeout(item.timeout);
  const key = queueKey(item.stateDir, item.job.executorId, item.job.runtime.instanceId);
  const queue = queues.get(key);
  const index = queue?.findIndex((job) => job.jobId === item.job.jobId) ?? -1;
  if (queue && index >= 0) queue.splice(index, 1);
  if (queue?.length === 0) queues.delete(key);
  item.reject(error);
}

function statePath(stateDir: string): string {
  return path.join(stateDir, EXECUTOR_STATE_FILE);
}

function emptyState(): ExecutorStateFile {
  return { version: EXECUTOR_STATE_VERSION, updatedAt: Date.now(), executors: {}, routes: {} };
}

const stateAccess = new Map<string, Promise<void>>();

async function withStateAccess<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(stateDir);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const result = (stateAccess.get(key) ?? Promise.resolve()).then(operation);
  // The ordering tail always settles successfully; the caller still receives the original error.
  const settled = result.then(() => undefined, () => undefined);
  stateAccess.set(key, settled);
  try {
    return await result;
  } finally {
    if (stateAccess.get(key) === settled) stateAccess.delete(key);
  }
}

function loadState(stateDir: string): Promise<ExecutorStateFile> {
  return withStateAccess(stateDir, () => readState(stateDir));
}

// Call only inside withStateAccess: readers must not overlap Windows atomic replacement.
async function readState(stateDir: string): Promise<ExecutorStateFile> {
  try {
    const parsed = z.object({
      version: z.literal(EXECUTOR_STATE_VERSION), updatedAt: z.number(),
      executors: z.record(StoredExecutorSchema),
      routes: z.record(z.string().min(1)),
    }).parse(JSON.parse(await readFile(statePath(stateDir), "utf8")));
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw denied("Cannot read executor route state; refusing local fallback", {
      stateDir, cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function saveState(stateDir: string, state: ExecutorStateFile): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = statePath(stateDir);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify({ ...state, version: EXECUTOR_STATE_VERSION, updatedAt: Date.now() }, null, 2)}\n`;
  await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  await renameWithRetry(temp, target);
}

function validateExecutorId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid executor id", { executorId: value });
  }
  return id;
}

export async function recordExecutorHeartbeat(stateDir: string, heartbeat: ExecutorHeartbeat): Promise<ExecutorStatus> {
  const validated = HeartbeatSchema.safeParse(heartbeat);
  if (!validated.success) throw denied("Invalid or incompatible executor protocol identity", { issues: validated.error.issues });
  const executorId = validateExecutorId(heartbeat.executorId);
  return await withStateAccess(stateDir, async () => {
    const now = Date.now();
    const state = await readState(stateDir);
    const stored = {
      ...validated.data,
      executorId,
      label: heartbeat.label?.trim() || executorId,
      lastSeenAtMs: now,
    };
    const previous = state.executors[executorId];
    const previousIdentity = RuntimeIdentitySchema.safeParse(previous);
    state.executors[executorId] = stored;
    await saveState(stateDir, state);
    if (previous && (!previousIdentity.success || !sameRuntimeIdentity(previousIdentity.data, stored))) {
      if (previous.instanceId) {
        const key = queueKey(stateDir, executorId, previous.instanceId);
        for (const waiter of waiters.get(key) ?? []) waiter(null);
        waiters.delete(key);
      }
      for (const item of pending.values()) {
        if (path.resolve(item.stateDir) === path.resolve(stateDir) && item.job.executorId === executorId
          && !sameRuntimeIdentity(item.job.runtime, stored)) {
          discardJob(item, denied("Executor instance changed", { executorId, instanceId: item.job.runtime.instanceId }));
        }
      }
      for (const item of restartControls.values()) {
        if (path.resolve(item.stateDir) === path.resolve(stateDir) && item.executorId === executorId
          && item.instanceId !== stored.instanceId) {
          discardRestartControl(item, denied("Executor instance changed", { executorId, instanceId: item.instanceId }));
        }
      }
      for (const item of jobCancelControls.values()) {
        if (path.resolve(item.stateDir) === path.resolve(stateDir) && item.executorId === executorId
          && item.instanceId !== stored.instanceId) discardJobCancelControl(item);
      }
    }
    return { ...stored, online: true, compatible: true };
  });
}

export async function takeExecutorControl(
  stateDir: string,
  executorId: string,
  identity: RuntimeIdentity,
): Promise<ExecutorControl | undefined> {
  validateExecutorId(executorId);
  RuntimeIdentitySchema.parse(identity);
  const state = await loadState(stateDir);
  const executor = requireAvailableExecutor(state, executorId);
  if (!sameRuntimeIdentity(identity, executor)) throw denied("Stale worker control identity", { executorId, instanceId: identity.instanceId });
  if (!executor.capabilities.includes(EXECUTOR_CONTROL_CAPABILITY)) return undefined;
  const key = controlKey(stateDir, executorId, identity.instanceId);
  const restart = restartControls.get(key);
  const cancel = jobCancelControls.get(key);
  if (!restart && !cancel) return undefined;
  return {
    ...(restart ? { restart: { requestId: restart.requestId, reason: restart.reason } } : {}),
    ...(cancel ? { cancelJob: { jobId: cancel.jobId, reason: cancel.reason } } : {}),
  };
}

export function acknowledgeExecutorControl(
  stateDir: string,
  executorId: string,
  identity: RuntimeIdentity,
  requestId: string,
): boolean {
  validateExecutorId(executorId);
  RuntimeIdentitySchema.parse(identity);
  const key = controlKey(stateDir, executorId, identity.instanceId);
  const item = restartControls.get(key);
  if (!item || item.requestId !== requestId) return false;
  restartControls.delete(key);
  clearTimeout(item.timeout);
  item.resolve({ scheduled: true, reason: item.reason, requestId: item.requestId, via: "heartbeat-control" });
  return true;
}

export function acknowledgeExecutorJobCancellation(
  stateDir: string,
  executorId: string,
  identity: RuntimeIdentity,
  jobId: string,
): boolean {
  validateExecutorId(executorId);
  RuntimeIdentitySchema.parse(identity);
  const key = controlKey(stateDir, executorId, identity.instanceId);
  const item = jobCancelControls.get(key);
  if (!item || item.jobId !== jobId) return false;
  discardJobCancelControl(item);
  return true;
}

export async function listExecutorStatus(stateDir: string, now = Date.now()): Promise<ExecutorStatus[]> {
  const state = await loadState(stateDir);
  return Object.values(state.executors)
    .map((executor) => ({ ...executor, compatible: HeartbeatSchema.safeParse(executor).success,
      online: now - executor.lastSeenAtMs <= EXECUTOR_HEARTBEAT_TTL_MS && HeartbeatSchema.safeParse(executor).success }))
    .sort((a, b) => a.executorId.localeCompare(b.executorId));
}

export async function setProjectExecutorRoute(stateDir: string, projectId: string, executorId: string | null): Promise<void> {
  return await withStateAccess(stateDir, async () => {
    const state = await readState(stateDir);
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
  });
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

  for (const stored of Object.values(state.executors)) {
    const validated = HeartbeatSchema.safeParse(stored);
    if (now - stored.lastSeenAtMs > EXECUTOR_HEARTBEAT_TTL_MS || !validated.success) continue;
    const executor = validated.data;
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
        executionTarget: deriveRemoteExecutionTarget(executor, project, projectId),
      });
    }
  }

  return remote;
}

export async function resolveRoutedLocalProject(
  stateDir: string,
  localProject: ProjectRegistryEntry,
  workspaceRoot = path.dirname(localProject.root),
): Promise<ProjectRegistryEntry> {
  // Managed task checkouts exist on this host; never route their identity to a worker.
  const local = async () => ({ ...localProject,
    executionTarget: await deriveLocalExecutionTarget(workspaceRoot, localProject) });
  if (/^jk-task-[a-f0-9]{24}$/u.test(localProject.projectId)) return await local();
  const state = await loadState(stateDir);
  const route = state.routes[localProject.projectId];
  if (!route && localProject.executorKind === "remote") {
    const executor = requireAvailableExecutor(state, localProject.executorId ?? "", localProject.projectId);
    const remote = executor.projects.find((project) => project.projectId === localProject.sourceProjectId);
    if (!remote) throw denied("Mapped executor project is missing", { executorId: executor.executorId, projectId: localProject.projectId });
    return { ...localProject, ...remote, projectId: localProject.projectId,
      executionTarget: deriveRemoteExecutionTarget(executor, remote, localProject.projectId) };
  }
  if (!route || route === "local") return await local();
  const executor = requireAvailableExecutor(state, route, localProject.projectId);
  const remote = executor.projects.find((project) =>
    project.projectId === localProject.projectId || project.aliases.includes(localProject.projectId),
  );
  if (!remote) throw denied("Mapped executor project is missing", { executorId: route, projectId: localProject.projectId });
  return {
    ...remote,
    projectId: localProject.projectId,
    aliases: Array.from(new Set([...localProject.aliases, ...remote.aliases, remote.name])),
    executorId: route,
    executorKind: "remote",
    executorOnline: true,
    sourceProjectId: remote.projectId,
    executionTarget: deriveRemoteExecutionTarget(executor, remote, localProject.projectId),
  };
}

function requireAvailableExecutor(state: ExecutorStateFile, executorId: string, projectId?: string): ExecutorHeartbeat {
  const executor = state.executors[executorId];
  const details = { executorId, projectId };
  if (!executor) throw denied("Mapped executor is unavailable", details);
  const validated = HeartbeatSchema.safeParse(executor);
  if (!validated.success) throw denied("Mapped executor protocol is incompatible or missing", details);
  if (Date.now() - executor.lastSeenAtMs > EXECUTOR_HEARTBEAT_TTL_MS) throw denied("Mapped executor is offline", details);
  return validated.data;
}

function currentTarget(state: ExecutorStateFile, executor: ExecutorHeartbeat, payload: Record<string, unknown>): ExecutionTarget {
  const parsed = payload.executionTarget === undefined ? undefined : ExecutionTargetSchema.safeParse(payload.executionTarget);
  if (parsed && !parsed.success) throw denied("Invalid expected execution target", { issues: parsed.error.issues });
  const expected = parsed?.data;
  const sourceProjectId = payload.sourceProjectId ?? payload.projectId;
  const project = executor.projects.find((candidate) => candidate.projectId === sourceProjectId);
  if (!project) throw denied("Canonical executor project not found", { executorId: executor.executorId, sourceProjectId });
  const projectId = expected?.projectId ?? (typeof payload.projectId === "string" ? payload.projectId : project.projectId);
  const route = state.routes[projectId];
  if (/^jk-task-[a-f0-9]{24}$/u.test(projectId) || (route && route !== executor.executorId)) {
    throw denied("Executor route changed or is local", { projectId, executorId: executor.executorId, route });
  }
  if (route) {
    const mapped = executor.projects.find((candidate) => candidate.projectId === projectId || candidate.aliases.includes(projectId));
    if (mapped?.projectId !== project.projectId) throw denied("Mapped canonical project changed", { projectId, sourceProjectId });
  }
  const target = deriveRemoteExecutionTarget(executor, project, projectId);
  if (expected && !sameExecutionTarget(expected, target)) throw denied("Execution target changed", { expected, actual: target });
  return target;
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

export interface PreparedExecutorJobDelivery {
  readonly job: ExecutorJob;
  readonly claim: JobDeliveryClaim;
}
export interface ExecutorJobDeliveryLink {
  approvedJobId: string;
  brokerJobId: string;
  bindingDigest: string;
}
// Only a fresh preparation in this process can be dispatched. Disk records are evidence, not queues.
const preparations = new WeakMap<PreparedExecutorJobDelivery, { stateDir: string; job: ExecutorJob; claim: JobDeliveryClaim }>();

/** Call under the approved-job lock, then persist the returned linkage before dispatching. */
export async function prepareExecutorJobDelivery(
  stateDir: string, executorId: string, tool: "local_shell_run" | "command_run",
  payload: Record<string, unknown>, ownerBinding: JobDeliveryOwnerBinding, timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
): Promise<PreparedExecutorJobDelivery> {
  const state = await loadState(stateDir);
  const executor = requireAvailableExecutor(state, executorId);
  if (!executor.capabilities.includes(tool) || !executor.capabilities.includes(DURABLE_RESULT_CAPABILITY)) {
    throw new JobDeliveryError("UNAUTHORIZED");
  }
  const executionTarget = currentTarget(state, executor, payload);
  const createdAt = Date.now();
  const job: ExecutorJob = JSON.parse(normalizeDeliveryJson({ jobId: randomUUID(), executorId, tool, payload,
    createdAt, protocolVersion: EXECUTOR_PROTOCOL_VERSION, runtime: RuntimeIdentitySchema.parse(executor), executionTarget }));
  const { claim, delivery } = await createJobDeliveryClaim(stateDir, {
    jobId: job.jobId, tool, payload: job.payload, runtime: job.runtime, executionTarget,
    ownerBinding, createdAt, deadlineAt: createdAt + Math.max(1_000, timeoutMs),
  });
  job.delivery = delivery;
  const prepared: PreparedExecutorJobDelivery = JSON.parse(normalizeDeliveryJson({ job, claim }));
  preparations.set(prepared, { stateDir: path.resolve(stateDir), job, claim });
  return prepared;
}

function validateDurableOffer(state: ExecutorStateFile, job: ExecutorJob): void {
  const executor = requireAvailableExecutor(state, job.executorId);
  if (!sameRuntimeIdentity(job.runtime, executor) || !executor.capabilities.includes(job.tool)
    || !executor.capabilities.includes(DURABLE_RESULT_CAPABILITY)) throw new JobDeliveryError("UNAUTHORIZED");
  currentTarget(state, executor, { ...job.payload, executionTarget: job.executionTarget });
}

async function offerDurableJob(stateDir: string, job: ExecutorJob, deliver: (job: ExecutorJob | null) => void): Promise<void> {
  const item = pending.get(job.jobId);
  if (!item) { deliver(null); return; }
  try {
    validateDurableOffer(await loadState(stateDir), job);
    const offered = await offerJobDeliveryClaim(stateDir, job.jobId, job.delivery!.bindingDigest);
    // Persistence yields: instance, capability, target, route and caller deadline can all change.
    await withStateAccess(stateDir, async () => {
      const state = await readState(stateDir);
      validateDurableOffer(state, job);
      if (Date.now() >= offered.deadlineAt) throw new JobDeliveryError("EXPIRED");
      if (pending.get(job.jobId) !== item) { deliver(null); return; }
      deliver(job);
    });
  } catch (error) {
    if (pending.get(job.jobId) === item) discardJob(item, error as Error);
    deliver(null);
  }
}

/** Link is the caller's assertion that the existing approved job has committed this exact preparation. */
export async function dispatchPreparedExecutorJob<T = unknown>(
  stateDir: string, prepared: PreparedExecutorJobDelivery, link: ExecutorJobDeliveryLink,
): Promise<T> {
  const live = preparations.get(prepared);
  if (!live || live.stateDir !== path.resolve(stateDir) || link.approvedJobId !== live.claim.ownerBinding.approvedJobId
    || link.brokerJobId !== live.job.jobId || link.bindingDigest !== live.claim.bindingDigest) throw new JobDeliveryError("UNAUTHORIZED");
  preparations.delete(prepared);
  const { job, claim } = live;
  if (Date.now() >= claim.deadlineAt) throw new JobDeliveryError("EXPIRED");
  validateDurableOffer(await loadState(stateDir), job);
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const item = pending.get(job.jobId);
      if (item) discardJob(item, new DomainError(ErrorCode.TIMEOUT, "Executor delivery outcome unknown", { jobId: job.jobId }));
    }, Math.max(0, claim.deadlineAt - Date.now()));
    pending.set(job.jobId, { stateDir, job, resolve: (result) => resolve(result as T), reject, timeout });
    const key = queueKey(stateDir, job.executorId, job.runtime.instanceId);
    const executorWaiters = waiters.get(key);
    const waiter = executorWaiters?.shift();
    if (executorWaiters?.length === 0) waiters.delete(key);
    if (waiter) void offerDurableJob(stateDir, job, waiter);
    else {
      const queue = queues.get(key) ?? [];
      queue.push(job);
      queues.set(key, queue);
    }
  });
}

/** Token authentication is the HTTP caller's precondition. Historical origin is never rebound. */
export async function completeDurableExecutorJob(
  stateDir: string, executorId: string, jobId: string, value: DurableResultSubmission,
): Promise<DurableResultAck> {
  const submission = DurableResultSubmissionSchema.parse(value);
  if (submission.delivery.jobId !== jobId || submission.courierRuntime.executorId !== executorId) throw new JobDeliveryError("UNAUTHORIZED");
  const ack = await withStateAccess(stateDir, async () => {
    const state = await readState(stateDir);
    const courier = requireAvailableExecutor(state, executorId);
    if (!courier.capabilities.includes(DURABLE_RESULT_CAPABILITY)
      || !sameRuntimeIdentity(courier, submission.courierRuntime)) throw new JobDeliveryError("UNAUTHORIZED");
    return await recordJobDeliveryReceipt(stateDir, submission, RuntimeIdentitySchema.parse(courier));
  });
  const item = pending.get(jobId);
  if (item?.job.delivery && path.resolve(item.stateDir) === path.resolve(stateDir)) {
    pending.delete(jobId);
    clearTimeout(item.timeout);
    if (submission.delivery.outcome === "threw") item.reject(new Error(submission.delivery.error));
    else item.resolve(submission.delivery.result);
  }
  return ack;
}

export async function dispatchExecutorJob<T = unknown>(
  stateDir: string,
  executorId: string,
  tool: ExecutorToolName,
  payload: Record<string, unknown>,
  timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
): Promise<T> {
  const state = await loadState(stateDir);
  const executor = requireAvailableExecutor(state, executorId);
  if (!executor.capabilities.includes(tool)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Executor does not support ${tool}`, { executorId, tool });
  }

  if (tool === "executor_restart" && executor.capabilities.includes(EXECUTOR_CONTROL_CAPABILITY)) {
    const key = controlKey(stateDir, executorId, executor.instanceId);
    if (restartControls.has(key)) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Executor restart is already requested", { executorId });
    }
    const requestId = randomUUID();
    const reason = String(payload.reason ?? "JK requested worker restart").slice(0, 240);
    return await new Promise<T>((resolve, reject) => {
      const item: PendingRestartControl = {
        stateDir, executorId, instanceId: executor.instanceId, requestId, reason,
        resolve: (result) => resolve(result as T), reject,
        timeout: undefined as unknown as NodeJS.Timeout,
      };
      item.timeout = setTimeout(() => {
        const current = restartControls.get(key);
        if (current === item) discardRestartControl(item,
          new DomainError(ErrorCode.TIMEOUT, "Executor restart control timed out", { executorId, requestId }));
      }, Math.max(1_000, timeoutMs));
      restartControls.set(key, item);
    });
  }

  const executionTarget = tool === "executor_restart" && payload.executionTarget === undefined
    ? undefined : currentTarget(state, executor, payload);
  const job: ExecutorJob = { jobId: randomUUID(), executorId, tool, payload, createdAt: Date.now(),
    protocolVersion: EXECUTOR_PROTOCOL_VERSION, runtime: RuntimeIdentitySchema.parse(executor), executionTarget };
  const key = queueKey(stateDir, executorId, executor.instanceId);
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const item = pending.get(job.jobId);
      if (item) requestJobCancellation(item, `Executor job timed out: ${tool}`);
      pending.delete(job.jobId);
      const queue = queues.get(key);
      if (queue) {
        const index = queue.findIndex((queued) => queued.jobId === job.jobId);
        if (index >= 0) queue.splice(index, 1);
        if (queue.length === 0) queues.delete(key);
      }
      reject(new DomainError(ErrorCode.TIMEOUT, `Executor job timed out: ${tool}`, { executorId, tool }));
    }, Math.max(1_000, timeoutMs));
    pending.set(job.jobId, {
      stateDir,
      job,
      resolve: (result) => resolve(result as T),
      reject,
      timeout,
    });
    deliverQueuedJob(key, job);
  });
}

export async function pollExecutorJob(
  executorId: string, waitMs = 20_000, identity?: RuntimeIdentity, stateDir?: string,
): Promise<ExecutorJob | null> {
  validateExecutorId(executorId);
  if (!identity || !stateDir) throw denied("Worker poll requires protocol identity and state", { executorId });
  RuntimeIdentitySchema.parse(identity);
  const state = await loadState(stateDir);
  const executor = requireAvailableExecutor(state, executorId);
  if (!sameRuntimeIdentity(identity, executor)) throw denied("Stale worker poll identity", { executorId, instanceId: identity.instanceId });
  const id = queueKey(stateDir, executorId, identity.instanceId);
  const queue = queues.get(id);
  while (queue?.length) {
    const queued = queue.shift();
    if (queue.length === 0) queues.delete(id);
    const item = queued ? pending.get(queued.jobId) : undefined;
    if (queued && item) {
      if (queued.delivery) {
        let offered: ExecutorJob | null = null;
        await offerDurableJob(stateDir, queued, (job) => { offered = job; });
        if (offered) return offered;
        continue;
      }
      try {
        if (!sameRuntimeIdentity(queued.runtime, executor)) throw denied("Queued worker identity changed", { executorId });
        if (!executor.capabilities.includes(queued.tool)) throw denied("Queued worker capability changed", { executorId, tool: queued.tool });
        if (queued.executionTarget) currentTarget(state, executor, { ...queued.payload, executionTarget: queued.executionTarget });
        return queued;
      } catch (error) {
        discardJob(item, error as Error);
      }
    }
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

export function completeExecutorJob(
  jobId: string, result: unknown, error?: string, executorId?: string, identity?: RuntimeIdentity,
): boolean {
  const item = pending.get(jobId);
  if (!item || item.job.delivery) return false;
  if (!identity || !RuntimeIdentitySchema.safeParse(identity).success || item.job.executorId !== executorId
    || !sameRuntimeIdentity(item.job.runtime, identity)) return false;
  pending.delete(jobId);
  clearTimeout(item.timeout);
  if (error) item.reject(new Error(error));
  else item.resolve(result);
  return true;
}
