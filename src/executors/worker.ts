import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { applyPatch, createFile } from "../code/patch.js";
import { codeSearch } from "../code/search.js";
import { readSlice } from "../code/read-slice.js";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath, redact } from "../policy/secrets.js";
import { listCommands, runCommand } from "../exec/command-runner.js";
import { runLocalShell } from "../exec/local-shell.js";
import { captureE2eScreenshot } from "../e2e/local-e2e.js";
import { listImages, retrieveImage } from "../assets/images.js";
import { nestedProjectRoots, scanWorkspaceWithRuntimeSelf } from "../workspace/registry.js";
import { createCheckpoint } from "../state/checkpoints.js";
import { gitDiffSummary, gitRepositoryStatus, gitStatus, gitSyncStart } from "../git/git.js";
import type { ProjectRegistryEntry } from "../types.js";
import type { ExecutorHeartbeat, ExecutorJob, ExecutorToolName } from "./broker.js";
import {
  EXECUTOR_PROTOCOL_VERSION, ExecutorHandshakeSchema, ExecutionTargetSchema, RuntimeIdentitySchema,
  DURABLE_RESULT_CAPABILITY, EXECUTOR_CONTROL_CAPABILITY, DurableCommandResultSchema, DurableDeliveryOfferSchema,
  canonicalDirectory, createRuntimeIdentity, deriveRemoteExecutionTarget, sameExecutionTarget, sameRuntimeIdentity,
  type ExecutorControl, type RuntimeIdentity,
} from "./target-protocol.js";

import {
  JobDeliveryError, openWorkerDeliveryOutbox, serializeDurableResultSubmission,
  type WorkerDeliveryOutbox, type WorkerDeliveryOutboxRecord,
} from "./job-delivery-store.js";
import { captureWindowsForegroundAppScreenshot, performWindowsComputerAction } from "../control/windows-input.js";

const DEFAULT_CAPABILITIES: ExecutorToolName[] = [
  "project_status",
  "project_rules",
  "repo_status",
  "repo_diff_summary",
  "git_sync_start",
  "code_search",
  "file_read_slice",
  "file_apply_patch",
  "file_create",
  "command_list",
  "command_run",
  "local_shell_run",
  "list_images",
  "retrieve_image",
  "e2e_screenshot",
  "computer_screenshot",
  "computer_action",
  "executor_restart",
];

export interface ExecutorWorkerOptions {
  hubUrl: string;
  executorToken: string;
  executorId: string;
  workspaceRoot: string;
  /** Stable private storage outside replaceable checkouts/dist. Omit for legacy ephemeral operation. */
  stateDir?: string;
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

class HubRequestError extends Error {
  constructor(readonly status: number, detail: string) { super(`JK hub ${status}: ${detail}`); }
}

async function requestJson<T>(url: string, token: string, init: RequestInit, timeoutMs = 5_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Executor request timed out")), timeoutMs);
  try {
    const response = await fetch(url, { ...init,
      signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      headers: { ...headers(token), ...(init.headers ?? {}) } });
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
      throw new HubRequestError(response.status, detail);
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

type BinaryExecutorResult = { body: Uint8Array; field: "imageBase64" | "data"; mime: string; result: Record<string, unknown> };

function extractBinaryExecutorResult(result: unknown): BinaryExecutorResult | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.imageBase64 === "string" && typeof record.mimeType === "string"
    && /^image\/(?:png|jpeg|gif|webp)$/i.test(record.mimeType)) {
    const { imageBase64, ...rest } = record;
    return { body: new Uint8Array(Buffer.from(imageBase64, "base64")), field: "imageBase64", mime: record.mimeType, result: rest };
  }
  if (typeof record.data === "string") {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(record.data);
    if (match) {
      const mime = match[1];
      const encoded = match[2];
      if (!mime || !encoded) return null;
      const { data, ...rest } = record;
      return { body: new Uint8Array(Buffer.from(encoded, "base64")), field: "data", mime, result: rest };
    }
  }
  return null;
}

async function postExecutorResult(
  hub: string, token: string, executorId: string, jobId: string, result: unknown, error: string | undefined, identity: RuntimeIdentity, signal?: AbortSignal,
): Promise<void> {
  const baseUrl = `${hub}/api/executors/${encodeURIComponent(executorId)}/jobs/${encodeURIComponent(jobId)}/result`;
  const binary = error ? null : extractBinaryExecutorResult(result);
  if (!binary) {
    await requestJson(baseUrl, token, { method: "POST", body: JSON.stringify({ result, error, identity }), signal });
    return;
  }
  const meta = Buffer.from(JSON.stringify({ result: binary.result, error, identity }), "utf8").toString("base64url");
  await requestJson(`${baseUrl}-binary`, token, {
    method: "POST", body: binary.body, signal,
    headers: {
      "content-type": "application/octet-stream",
      "x-jk-result-meta": meta,
      "x-jk-binary-field": binary.field,
      "x-jk-binary-mime": binary.mime,
    },
  }, 30_000);
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
  const entry = registry.find((candidate) => candidate.projectId === id);
  if (!entry) throw new Error(`Worker project not found: ${id}`);
  return entry;
}

async function hashFileBytes(abs: string): Promise<string> {
  const bytes = await fs.readFile(abs);
  return createHash("sha256").update(bytes).digest("hex");
}

async function executeWorkerJob(registry: ProjectRegistryEntry[], job: ExecutorJob, signal?: AbortSignal): Promise<unknown> {
  const payload = job.payload as WorkerJobPayload;
  const entry = resolveProject(registry, payload);

  switch (job.tool) {
    case "repo_status":
      return await gitRepositoryStatus(entry.root);
    case "repo_diff_summary":
      return await gitDiffSummary(entry.root);
    case "git_sync_start":
      return await gitSyncStart(entry.root);
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
      return { ...slice, content: redact(slice.content), workContextFileHash: slice.fullFileHash };
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
        typeof payload.expectedManifestFingerprint === "string" ? payload.expectedManifestFingerprint : undefined,
        Boolean(payload.approvedRisky),
        signal,
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
        signal,
      );
    case "list_images":
      return { images: await listImages(entry.root) };
    case "retrieve_image":
      return await retrieveImage(entry.root, String(payload.filePath ?? ""), entry.projectId);
    case "e2e_screenshot": {
      const screenshot = await captureE2eScreenshot(entry.root, {
        label: typeof payload.label === "string" ? payload.label : undefined,
        waitMs: typeof payload.waitMs === "number" ? payload.waitMs : undefined,
        openAfterCapture: Boolean(payload.openAfterCapture),
      });
      const image = await fs.readFile(screenshot.path);
      const maxRemoteScreenshotBytes = 6 * 1024 * 1024;
      if (image.length > maxRemoteScreenshotBytes) {
        throw new Error(`Remote E2E screenshot is too large to return (${image.length} bytes)`);
      }
      return { ...screenshot, imageBase64: image.toString("base64"), mimeType: "image/png" };
    }
    case "computer_screenshot": {
      if (process.platform !== "win32") throw new Error("computer_screenshot remote capability currently requires Windows");
      return await captureWindowsForegroundAppScreenshot(entry.root, {
        appName: String(payload.appName ?? ""),
        label: typeof payload.label === "string" ? payload.label : undefined,
        waitMs: typeof payload.waitMs === "number" ? payload.waitMs : undefined,
      }, signal);
    }
    case "computer_action": {
      if (process.platform !== "win32") throw new Error("computer_action remote capability currently requires Windows");
      return await performWindowsComputerAction({
        appName: String(payload.appName ?? ""),
        kind: String(payload.kind ?? "") as "click" | "type" | "key" | "scroll",
        windowPoint: payload.windowPoint && typeof payload.windowPoint === "object"
          ? {
              xRel: Number((payload.windowPoint as Record<string, unknown>).xRel),
              yRel: Number((payload.windowPoint as Record<string, unknown>).yRel),
            }
          : undefined,
        text: typeof payload.text === "string" ? payload.text : undefined,
        keyCode: typeof payload.keyCode === "number" ? payload.keyCode : undefined,
        scrollDelta: typeof payload.scrollDelta === "number" ? payload.scrollDelta : undefined,
      }, signal);
    }
    default:
      throw new Error(`Unsupported executor tool: ${String(job.tool)}`);
  }
}

async function heartbeat(
  hub: string,
  token: string,
  options: ExecutorWorkerOptions,
  registry: ProjectRegistryEntry[],
  identity: RuntimeIdentity,
  startedAtMs: number,
): Promise<z.infer<typeof ExecutorHandshakeSchema>> {
  const body: ExecutorHeartbeat = {
    ...identity,
    executorId: options.executorId,
    label: options.label ?? options.executorId,
    platform: `${process.platform}/${process.arch} · ${os.hostname()}`,
    workspaceRoot: identity.workspaceRoot,
    projects: registry.map(publicProjectSnapshot),
    startedAtMs,
  };
  const response = ExecutorHandshakeSchema.parse(await requestJson(`${hub}/api/executors/heartbeat`, token,
    { method: "POST", body: JSON.stringify(body), signal: options.signal }));
  if (!sameRuntimeIdentity(response.executor, identity)) throw new Error("Hub acknowledged a different worker identity");
  return response;
}

async function scanCanonicalWorkspace(root: string, includeGitMetadata = true): Promise<ProjectRegistryEntry[]> {
  if (await canonicalDirectory(root) !== root) throw new Error("Worker workspace root changed");
  return await Promise.all((await scanWorkspaceWithRuntimeSelf(root, undefined, undefined, { includeGitMetadata })).map(async (project) => ({
    ...project, root: await canonicalDirectory(project.root),
  })));
}

const WorkerJobSchema = z.object({
  jobId: z.string().min(1), executorId: z.string().min(1), tool: z.string(),
  payload: z.record(z.unknown()), createdAt: z.number(),
  protocolVersion: z.literal(EXECUTOR_PROTOCOL_VERSION), runtime: RuntimeIdentitySchema,
  executionTarget: ExecutionTargetSchema.optional(),
});

async function validateWorkerJob(job: ExecutorJob, identity: RuntimeIdentity): Promise<ProjectRegistryEntry[]> {
  WorkerJobSchema.parse(job);
  if (job.executorId !== identity.executorId || !sameRuntimeIdentity(job.runtime, identity)
    || !identity.capabilities.includes(job.tool)) throw new Error("Job runtime identity or capability mismatch");
  if (job.tool === "executor_restart" && !job.executionTarget) return [];
  const target = ExecutionTargetSchema.parse(job.executionTarget);
  const registry = await scanCanonicalWorkspace(identity.workspaceRoot, false);
  const entry = resolveProject(registry, job.payload);
  const actual = deriveRemoteExecutionTarget(identity, entry, target.projectId);
  if (!sameExecutionTarget(target, actual)) throw new Error("Job project execution target changed");
  if (job.payload.executionTarget !== undefined
    && !sameExecutionTarget(ExecutionTargetSchema.parse(job.payload.executionTarget), actual)) {
    throw new Error("Job payload execution target mismatch");
  }
  return registry;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function rethrowOutboxError(error: unknown): never {
  // Store cleanup can throw a raw filesystem error after a successful rename.
  // It is still a storage failure, never a transport retry.
  throw error instanceof JobDeliveryError ? error : new JobDeliveryError("UNREADABLE", error);
}

export function applyExecutorJobCancellationControl(
  control: ExecutorControl | undefined,
  activeJobId: string | null,
  activeJobController: AbortController | null,
): string | null {
  const cancel = control?.cancelJob;
  if (!cancel || !activeJobController || activeJobId !== cancel.jobId) return null;
  activeJobController.abort(new Error(`Executor job cancelled by hub: ${cancel.reason}`));
  return activeJobId;
}

export async function runExecutorWorker(options: ExecutorWorkerOptions): Promise<void> {
  const outbox = options.stateDir === undefined ? undefined
    : await openWorkerDeliveryOutbox(options.stateDir, options.hubUrl, options.executorId);
  try {
    await runOwnedExecutorWorker(options, outbox);
  } finally {
    await outbox?.close();
  }
}

async function runOwnedExecutorWorker(options: ExecutorWorkerOptions, outbox?: WorkerDeliveryOutbox): Promise<void> {
  const hub = normalizeHubUrl(options.hubUrl);
  const heartbeatMs = Math.min(Math.max(options.heartbeatMs ?? 10_000, 3_000), 30_000);
  const pollWaitMs = Math.min(Math.max(options.pollWaitMs ?? 20_000, 1_000), 25_000);
  const identity = await createRuntimeIdentity("worker", options.workspaceRoot, options.executorId,
    outbox ? [...DEFAULT_CAPABILITIES, DURABLE_RESULT_CAPABILITY, EXECUTOR_CONTROL_CAPABILITY]
      : [...DEFAULT_CAPABILITIES, EXECUTOR_CONTROL_CAPABILITY], randomUUID());
  const startedAtMs = Date.now();
  let registry = await scanCanonicalWorkspace(identity.workspaceRoot);
  const initialHandshake = await heartbeat(hub, options.executorToken, options, registry, identity, startedAtMs);
  const hubIdentity = initialHandshake.hub;
  let lastHeartbeat = Date.now();
  let lastRegistryScan = Date.now();
  let backoffMs = 1_000;
  let heartbeatInFlight: Promise<void> | null = null;
  let heartbeatFailure: unknown = null;
  let hubIdentityChanged = false;
  let heartbeatTimerElapsedMs = 0;
  let restartReason: string | null = initialHandshake.control?.restart?.reason ?? null;
  let activeJobController: AbortController | null = null;
  let activeJobId: string | null = null;
  let cancelledJobId: string | null = null;
  let pendingJobCancellation: NonNullable<ExecutorControl["cancelJob"]> | null = initialHandshake.control?.cancelJob ?? null;
  const retirementController = new AbortController();
  const operationSignal = options.signal
    ? AbortSignal.any([options.signal, retirementController.signal])
    : retirementController.signal;
  const abortActiveJob = () => {
    activeJobController?.abort(
      operationSignal.reason instanceof Error ? operationSignal.reason : new Error("Executor worker stopping"),
    );
  };
  operationSignal.addEventListener("abort", abortActiveJob, { once: true });
  if (operationSignal.aborted) abortActiveJob();

  const deliver = async (record: WorkerDeliveryOutboxRecord): Promise<void> => {
    if (record.state !== "completed") return;
    if (!hubIdentity.capabilities.includes(DURABLE_RESULT_CAPABILITY)) throw new JobDeliveryError("UNAUTHORIZED");
    const body = serializeDurableResultSubmission(JSON.parse(record.envelopeJson), identity);
    let ack: unknown;
    try {
      ack = await requestJson(
        `${hub}/api/executors/${encodeURIComponent(options.executorId)}/jobs/${encodeURIComponent(record.jobId)}/result`,
        options.executorToken, { method: "POST", body, signal: operationSignal },
      );
    } catch (error) {
      if (error instanceof HubRequestError && error.status < 500 && error.status !== 408 && error.status !== 429) {
        throw new JobDeliveryError(error.status === 401 || error.status === 403 ? "UNAUTHORIZED"
          : error.status === 404 ? "NOT_FOUND" : "CONFLICT", error);
      }
      throw error;
    }
    await outbox!.acknowledge(record.jobId, ack).catch(rethrowOutboxError);
  };

  const sendKeepAlive = (): Promise<void> => {
    if (heartbeatInFlight) return heartbeatInFlight;
    heartbeatInFlight = (async () => {
      const current = await heartbeat(hub, options.executorToken, options, registry, identity, startedAtMs);
      const currentHub = current.hub;
      if (!sameRuntimeIdentity(hubIdentity, currentHub)) {
        hubIdentityChanged = true;
        options.onStatus?.(`executor ${options.executorId} hub identity changed; exiting for a fresh supervised handshake`);
        return;
      }
      if (current.control?.restart) {
        restartReason = current.control.restart.reason || "JK requested worker restart";
        const reason = new Error(`Executor restart requested: ${restartReason}`);
        activeJobController?.abort(reason);
        if (!retirementController.signal.aborted) retirementController.abort(reason);
      }
      if (current.control?.cancelJob) pendingJobCancellation = current.control.cancelJob;
      if (pendingJobCancellation) {
        const applied = applyExecutorJobCancellationControl(
          { cancelJob: pendingJobCancellation },
          activeJobId,
          activeJobController,
        );
        if (applied) {
          cancelledJobId = applied;
          pendingJobCancellation = null;
        }
      }
      heartbeatFailure = null;
      lastHeartbeat = Date.now();
      heartbeatTimerElapsedMs = 0;
      options.onStatus?.(`executor ${options.executorId} online · ${registry.length} project(s)`);
    })().catch((err) => {
      heartbeatFailure = err;
      options.onStatus?.(`executor heartbeat retry: ${redact(err instanceof Error ? err.message : String(err))}`);
    }).finally(() => {
      heartbeatInFlight = null;
    });
    return heartbeatInFlight;
  };

  // Polling and especially local jobs can block the main worker loop for much
  // longer than the broker's executor TTL. Keep the lease alive independently
  // so a healthy Windows worker does not disappear while a long job is running.
  const heartbeatTimerIntervalMs = Math.min(heartbeatMs, 1_000);
  const heartbeatTimer = setInterval(() => {
    if (options.signal?.aborted || hubIdentityChanged) return;
    heartbeatTimerElapsedMs += heartbeatTimerIntervalMs;
    if (activeJobController || heartbeatTimerElapsedMs >= heartbeatMs) void sendKeepAlive();
  }, heartbeatTimerIntervalMs);
  heartbeatTimer.unref?.();

  options.onStatus?.(`executor ready ${JSON.stringify({ worker: identity, hub: hubIdentity, projects: registry.length })}`);

  try {
    while (!options.signal?.aborted) {
      try {
        if (restartReason) {
          options.onStatus?.(`executor ${options.executorId} restart requested: ${restartReason}`);
          return;
        }
        if (hubIdentityChanged) return;
        if (heartbeatFailure) {
          await sendKeepAlive();
          if (hubIdentityChanged) return;
          if (heartbeatFailure) throw heartbeatFailure;
        }
      // Historical receipts are courier work, never executable jobs. Drain before
      // scanning/polling for new work, including after a transport retry.
      const outboxRecords = await outbox?.list().catch(rethrowOutboxError) ?? [];
      for (const record of outboxRecords) {
        if (restartReason || hubIdentityChanged || options.signal?.aborted) return;
        if (record.state === "started") options.onStatus?.(`executor outcome-unknown: ${record.jobId}`);
        await deliver(record);
      }
      const now = Date.now();
      if (now - lastRegistryScan >= heartbeatMs) {
        registry = await scanCanonicalWorkspace(identity.workspaceRoot);
        lastRegistryScan = Date.now();
      }
      if (now - lastHeartbeat >= heartbeatMs) {
        await sendKeepAlive();
        if (hubIdentityChanged) return;
        if (heartbeatFailure) throw heartbeatFailure;
      }

      const polled = await requestJson<{ job: (ExecutorJob & { delivery?: unknown }) | null }>(
        `${hub}/api/executors/${encodeURIComponent(options.executorId)}/poll`,
        options.executorToken,
        { method: "POST", body: JSON.stringify({ waitMs: pollWaitMs, identity }), signal: operationSignal },
        pollWaitMs + 5_000,
      );
      if (restartReason) return;
      if (!polled.job) {
        backoffMs = 1_000;
        continue;
      }

      // Enrollment cannot be stripped to bypass a retained start/result tombstone.
      if (polled.job.delivery === undefined && outboxRecords.some(record => record.jobId === polled.job!.jobId)) {
        throw new JobDeliveryError("CONFLICT");
      }
      if (polled.job.delivery !== undefined) {
        if (!outbox || !hubIdentity.capabilities.includes(DURABLE_RESULT_CAPABILITY)) throw new JobDeliveryError("UNAUTHORIZED");
        const job = polled.job;
        if (job.tool !== "local_shell_run" && job.tool !== "command_run") throw new JobDeliveryError("INVALID_RECORD");
        // Known claims are only compared with their saved binding; changed current
        // projects/instances cannot turn historical bytes into new execution.
        if (!await outbox.read(job.jobId).catch(rethrowOutboxError)) {
          try { registry = await validateWorkerJob(job, identity); }
          catch (error) { throw new JobDeliveryError("INVALID_RECORD", error); }
        }
        const delivery = DurableDeliveryOfferSchema.safeParse(job.delivery);
        const executionTarget = ExecutionTargetSchema.safeParse(job.executionTarget);
        if (!delivery.success || !executionTarget.success) throw new JobDeliveryError("INVALID_RECORD");
        const admission = await outbox.start({ jobId: job.jobId, tool: job.tool, runtime: job.runtime,
          executionTarget: executionTarget.data, payload: job.payload, delivery: delivery.data }).catch(rethrowOutboxError);
        if (restartReason || hubIdentityChanged || options.signal?.aborted) return;
        if (!admission.shouldExecute) {
          if (admission.record.state === "started") options.onStatus?.(`executor outcome-unknown: ${job.jobId}`);
          await deliver(admission.record);
          continue;
        }
        let result: unknown;
        let error: string | undefined;
        const controller = new AbortController();
        activeJobController = controller;
        activeJobId = job.jobId;
        try { result = await executeWorkerJob(registry, job, controller.signal); }
        catch (cause) { error = redact(cause instanceof Error ? cause.message : String(cause)); }
        finally {
          if (activeJobController === controller) activeJobController = null;
          if (activeJobId === job.jobId) activeJobId = null;
        }
        if (restartReason && controller.signal.aborted) {
          options.onStatus?.(`executor ${options.executorId} interrupted active durable job ${job.jobId}; preserving started evidence for restart`);
          return;
        }
        // Persistence is outside the execution catch: a disk or transport error
        // must never replace a successful result or authorize another execution.
        const parsed = error === undefined ? DurableCommandResultSchema.safeParse(result) : undefined;
        if (parsed && !parsed.success) throw new JobDeliveryError("INVALID_RECORD", parsed.error);
        const completed = await outbox.complete(job.jobId, error !== undefined
          ? { outcome: "threw", error } : { outcome: "returned", result: parsed!.data! }).catch(rethrowOutboxError);
        if (restartReason || hubIdentityChanged || options.signal?.aborted) return;
        await deliver(completed);
        if (cancelledJobId === job.jobId) cancelledJobId = null;
        backoffMs = 1_000;
        continue;
      }

      let result: unknown = null;
      let error: string | undefined;
      let legacyRestartRequested = false;
      let legacyRestartReason = "";
      try {
        registry = await validateWorkerJob(polled.job, identity);
        if (polled.job.tool === "executor_restart") {
          legacyRestartReason = String(polled.job.payload.reason ?? "JK requested worker restart").slice(0, 240);
          result = { scheduled: true, reason: legacyRestartReason };
          legacyRestartRequested = true;
        } else {
          const controller = new AbortController();
          activeJobController = controller;
          activeJobId = polled.job.jobId;
          if (pendingJobCancellation?.jobId === polled.job.jobId) {
            cancelledJobId = applyExecutorJobCancellationControl(
              { cancelJob: pendingJobCancellation },
              activeJobId,
              activeJobController,
            );
            pendingJobCancellation = null;
          }
          try { result = await executeWorkerJob(registry, polled.job, controller.signal); }
          finally {
            if (activeJobController === controller) activeJobController = null;
            if (activeJobId === polled.job.jobId) activeJobId = null;
          }
          if (restartReason && controller.signal.aborted) return;
        }
      } catch (err) {
        error = redact(err instanceof Error ? err.message : String(err));
      }
      if (hubIdentityChanged) return;
      if (pendingJobCancellation?.jobId === polled.job.jobId) {
        cancelledJobId = polled.job.jobId;
        pendingJobCancellation = null;
      }
      if (cancelledJobId === polled.job.jobId) {
        cancelledJobId = null;
        options.onStatus?.(`executor cancelled timed-out job ${polled.job.jobId}`);
        backoffMs = 1_000;
        continue;
      }
      await postExecutorResult(
        hub, options.executorToken, options.executorId, polled.job.jobId, result, error, identity, operationSignal,
      );
      if (legacyRestartRequested && !error) {
        options.onStatus?.(`executor ${options.executorId} restart requested: ${legacyRestartReason}`);
        return;
      }
      backoffMs = 1_000;
      } catch (err) {
        if (err instanceof JobDeliveryError) {
          options.onStatus?.(err.message);
          throw err;
        }
        if (restartReason) {
          options.onStatus?.(`executor ${options.executorId} restart requested: ${restartReason}`);
          return;
        }
        if (options.signal?.aborted) break;
        options.onStatus?.(`executor retry: ${redact(err instanceof Error ? err.message : String(err))}`);
        await delay(backoffMs, operationSignal).catch(() => undefined);
        if (restartReason) return;
        backoffMs = Math.min(backoffMs * 2, 15_000);
      }
    }
  } finally {
    operationSignal.removeEventListener("abort", abortActiveJob);
    abortActiveJob();
    clearInterval(heartbeatTimer);
    const pendingHeartbeat = heartbeatInFlight as Promise<void> | null;
    if (pendingHeartbeat) await pendingHeartbeat.catch(() => undefined);
  }
}

export async function readExecutorToken(tokenFile: string): Promise<string> {
  const value = (await fs.readFile(tokenFile, "utf8")).trim();
  if (!value) throw new Error("Executor token file is empty");
  return value;
}
