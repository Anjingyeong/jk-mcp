import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { applyPatch, createFile } from "../code/patch.js";
import { codeSearch } from "../code/search.js";
import { readSlice } from "../code/read-slice.js";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath, redact } from "../policy/secrets.js";
import { listCommands, runCommand } from "../exec/command-runner.js";
import { runLocalShell } from "../exec/local-shell.js";
import { nestedProjectRoots, scanWorkspaceWithRuntimeSelf } from "../workspace/registry.js";
import { createCheckpoint } from "../state/checkpoints.js";
import { gitDiffSummary, gitRepositoryStatus, gitStatus } from "../git/git.js";
import type { ProjectRegistryEntry } from "../types.js";
import type { ExecutorHeartbeat, ExecutorJob, ExecutorToolName } from "./broker.js";

const DEFAULT_CAPABILITIES: ExecutorToolName[] = [
  "project_status",
  "project_rules",
  "repo_status",
  "repo_diff_summary",
  "code_search",
  "file_read_slice",
  "file_apply_patch",
  "file_create",
  "command_list",
  "command_run",
  "local_shell_run",
  "executor_restart",
];

export interface ExecutorWorkerOptions {
  hubUrl: string;
  executorToken: string;
  executorId: string;
  workspaceRoot: string;
  label?: string;
  heartbeatMs?: number;
  pollWaitMs?: number;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}

interface WorkerJobPayload {
  sourceProjectId?: string;
  projectId?: string;
  [key: string]: unknown;
}

function normalizeHubUrl(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function requestJson<T>(url: string, token: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...headers(token), ...(init.headers ?? {}) } });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const detail = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error?: unknown }).error)
      : String(payload ?? response.statusText);
    throw new Error(`JK hub ${response.status}: ${detail}`);
  }
  return payload as T;
}

function publicProjectSnapshot(project: ProjectRegistryEntry): ProjectRegistryEntry {
  return {
    projectId: project.projectId,
    name: project.name,
    root: project.root,
    aliases: project.aliases,
    branch: project.branch,
    dirty: project.dirty,
    hasAgentsMd: project.hasAgentsMd,
    hasCodeBrain: project.hasCodeBrain,
    packageHints: project.packageHints,
    lastSeenAt: project.lastSeenAt,
  };
}

function resolveProject(registry: ProjectRegistryEntry[], payload: WorkerJobPayload): ProjectRegistryEntry {
  const id = String(payload.sourceProjectId ?? payload.projectId ?? "");
  const entry = registry.find((candidate) => candidate.projectId === id || candidate.aliases.includes(id));
  if (!entry) throw new Error(`Worker project not found: ${id}`);
  return entry;
}

async function hashFileBytes(abs: string): Promise<string> {
  const bytes = await fs.readFile(abs);
  return createHash("sha256").update(bytes).digest("hex");
}

async function executeWorkerJob(registry: ProjectRegistryEntry[], job: ExecutorJob): Promise<unknown> {
  const payload = job.payload as WorkerJobPayload;
  const entry = resolveProject(registry, payload);

  switch (job.tool) {
    case "repo_status":
      return await gitRepositoryStatus(entry.root);
    case "repo_diff_summary":
      return await gitDiffSummary(entry.root);
    case "project_status": {
      const [status, commands] = await Promise.all([gitStatus(entry.root), listCommands(entry.root)]);
      const ruleFiles: string[] = [];
      for (const candidate of ["AGENTS.md", "CLAUDE.md", ".codex/config.toml"]) {
        try {
          const stat = await fs.stat(path.join(entry.root, candidate));
          if (stat.isFile()) ruleFiles.push(candidate);
        } catch {
          // absent is normal
        }
      }
      return {
        branch: status.branch,
        dirtyFiles: status.dirtyFiles,
        staged: status.staged,
        packageHints: entry.packageHints ?? [],
        ruleFiles,
        knownCommands: commands.map((command) => command.commandId),
        hasCodeBrain: entry.hasCodeBrain ?? false,
      };
    }
    case "project_rules": {
      const rules: { file: string; summary: string }[] = [];
      const root = path.resolve(entry.root);
      let scopeDir = root;
      let scopePath = ".";
      if (typeof payload.path === "string" && payload.path) {
        const target = await resolveInProject(entry.root, payload.path, { allowSymlink: true });
        const stat = await fs.stat(target).catch(() => null);
        scopeDir = stat?.isDirectory() ? target : path.dirname(target);
        scopePath = path.relative(root, target).split(path.sep).join("/") || ".";
      }
      const directories: string[] = [];
      let cursor = path.resolve(scopeDir);
      while (true) {
        directories.unshift(cursor);
        if (cursor === root) break;
        const parent = path.dirname(cursor);
        if (parent === cursor || path.relative(root, parent).startsWith("..")) break;
        cursor = parent;
      }
      for (const directory of directories) {
        const candidates = directory === root ? [".codex/config.toml", "AGENTS.md", "CLAUDE.md"] : ["AGENTS.md", "CLAUDE.md"];
        for (const candidate of candidates) {
          const abs = path.join(directory, candidate);
          if (isSecretPath(abs)) continue;
          const raw = await fs.readFile(abs, "utf8").catch(() => null);
          if (raw === null) continue;
          const summary = redact(raw).split("\n").slice(0, 20).join("\n").slice(0, 2000);
          rules.push({ file: path.relative(root, abs).split(path.sep).join("/") || candidate, summary });
        }
      }
      return { scopePath, hierarchical: Boolean(payload.path), rules };
    }
    case "code_search": {
      const query = String(payload.query ?? "");
      const mode = payload.mode === "symbol" || payload.mode === "semantic" ? payload.mode : "text";
      const maxResults = typeof payload.maxResults === "number" ? payload.maxResults : undefined;
      const result = await codeSearch(entry.root, query, mode, maxResults, nestedProjectRoots(registry, entry));
      return {
        backend: result.backend,
        matches: result.matches
          .filter((match) => !isSecretPath(path.join(entry.root, match.path)))
          .map((match) => ({ ...match, snippet: redact(match.snippet) })),
      };
    }
    case "file_read_slice": {
      const rel = String(payload.path ?? "");
      const abs = await resolveInProject(entry.root, rel, { allowSymlink: false });
      if (isSecretPath(abs)) throw new Error(`Secret-classified path blocked: ${rel}`);
      const start = typeof payload.start === "number"
        ? payload.start
        : typeof payload.offset === "number"
          ? payload.offset + 1
          : undefined;
      const end = typeof payload.end === "number" ? payload.end : undefined;
      const slice = await readSlice(entry.root, rel, start, end);
      return { ...slice, content: redact(slice.content), workContextFileHash: await hashFileBytes(abs) };
    }
    case "file_apply_patch": {
      const result = await applyPatch(
        entry.root,
        String(payload.patch ?? ""),
        payload.preconditionHashes && typeof payload.preconditionHashes === "object"
          ? payload.preconditionHashes as Record<string, string>
          : undefined,
      );
      const checkpoint = await createCheckpoint(entry.root, entry.projectId, "remote patch");
      const fileHashes: Record<string, string | null> = {};
      for (const applied of result.applied) {
        if (applied.action === "delete" || applied.action === "move") {
          fileHashes[applied.path] = null;
          continue;
        }
        fileHashes[applied.path] = await hashFileBytes(path.join(entry.root, applied.path));
      }
      return { ...result, checkpointId: checkpoint.checkpointId, fileHashes };
    }
    case "file_create": {
      const result = await createFile(
        entry.root,
        String(payload.path ?? ""),
        String(payload.content ?? ""),
        Boolean(payload.overwrite),
      );
      const checkpoint = await createCheckpoint(entry.root, entry.projectId, "remote create");
      const fileHash = await hashFileBytes(path.join(entry.root, result.path));
      return { ...result, checkpointId: checkpoint.checkpointId, fileHash };
    }
    case "command_list":
      return { commands: await listCommands(entry.root) };
    case "command_run":
      return await runCommand(
        entry.root,
        String(payload.commandId ?? ""),
        Array.isArray(payload.args) ? payload.args.map(String) : undefined,
        typeof payload.timeoutSec === "number" ? payload.timeoutSec : undefined,
      );
    case "local_shell_run":
      return await runLocalShell(
        entry.root,
        String(payload.command ?? ""),
        typeof payload.cwd === "string" ? payload.cwd : undefined,
        typeof payload.timeoutSec === "number" ? payload.timeoutSec : undefined,
        {
          needsNetwork: Boolean(payload.approvedNeedsNetwork),
          destructive: Boolean(payload.approvedDestructive),
        },
      );
    default:
      throw new Error(`Unsupported executor tool: ${String(job.tool)}`);
  }
}

async function heartbeat(
  hub: string,
  token: string,
  options: ExecutorWorkerOptions,
  registry: ProjectRegistryEntry[],
): Promise<void> {
  const body: ExecutorHeartbeat = {
    executorId: options.executorId,
    label: options.label ?? options.executorId,
    platform: `${process.platform}/${process.arch} · ${os.hostname()}`,
    workspaceRoot: path.resolve(options.workspaceRoot),
    projects: registry.map(publicProjectSnapshot),
    capabilities: DEFAULT_CAPABILITIES,
  };
  await requestJson(`${hub}/api/executors/heartbeat`, token, { method: "POST", body: JSON.stringify(body) });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export async function runExecutorWorker(options: ExecutorWorkerOptions): Promise<void> {
  const hub = normalizeHubUrl(options.hubUrl);
  const heartbeatMs = Math.min(Math.max(options.heartbeatMs ?? 10_000, 3_000), 30_000);
  const pollWaitMs = Math.min(Math.max(options.pollWaitMs ?? 20_000, 1_000), 25_000);
  let registry = await scanWorkspaceWithRuntimeSelf(path.resolve(options.workspaceRoot));
  let lastHeartbeat = 0;
  let backoffMs = 1_000;

  options.onStatus?.(`executor ${options.executorId} connecting to ${hub}`);

  while (!options.signal?.aborted) {
    try {
      const now = Date.now();
      if (now - lastHeartbeat >= heartbeatMs) {
        registry = await scanWorkspaceWithRuntimeSelf(path.resolve(options.workspaceRoot));
        await heartbeat(hub, options.executorToken, options, registry);
        lastHeartbeat = Date.now();
        options.onStatus?.(`executor ${options.executorId} online · ${registry.length} project(s)`);
      }

      const polled = await requestJson<{ job: ExecutorJob | null }>(
        `${hub}/api/executors/${encodeURIComponent(options.executorId)}/poll`,
        options.executorToken,
        { method: "POST", body: JSON.stringify({ waitMs: pollWaitMs }) },
      );
      if (!polled.job) {
        backoffMs = 1_000;
        continue;
      }

      let result: unknown = null;
      let error: string | undefined;
      let restartRequested = false;
      let restartReason = "";
      try {
        if (polled.job.tool === "executor_restart") {
          restartReason = String(polled.job.payload.reason ?? "JK requested worker restart").slice(0, 240);
          result = { scheduled: true, reason: restartReason };
          restartRequested = true;
        } else {
          result = await executeWorkerJob(registry, polled.job);
        }
      } catch (err) {
        error = redact(err instanceof Error ? err.message : String(err));
      }
      await requestJson(
        `${hub}/api/executors/${encodeURIComponent(options.executorId)}/jobs/${encodeURIComponent(polled.job.jobId)}/result`,
        options.executorToken,
        { method: "POST", body: JSON.stringify({ result, error }) },
      );
      if (restartRequested && !error) {
        options.onStatus?.(`executor ${options.executorId} restart requested: ${restartReason}`);
        return;
      }
      backoffMs = 1_000;
    } catch (err) {
      if (options.signal?.aborted) break;
      options.onStatus?.(`executor retry: ${redact(err instanceof Error ? err.message : String(err))}`);
      await delay(backoffMs, options.signal).catch(() => undefined);
      backoffMs = Math.min(backoffMs * 2, 15_000);
    }
  }
}

export async function readExecutorToken(tokenFile: string): Promise<string> {
  const value = (await fs.readFile(tokenFile, "utf8")).trim();
  if (!value) throw new Error("Executor token file is empty");
  return value;
}
