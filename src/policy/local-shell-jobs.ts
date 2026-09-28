import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import type { LocalShellApprovalRecord } from "./local-approvals.js";
import { taskApprovalIdentity } from "./local-approvals.js";
import { sendJkPush } from "../notifications/ntfy.js";
import { redact } from "./secrets.js";
import { ExecutionTargetSchema, type ExecutionTarget } from "../executors/target-protocol.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;
const SUCCEEDED_REUSE_TTL_MS = 30 * 60 * 1000;
const FAILED_REUSE_TTL_MS = 10 * 60 * 1000;
const RUNNER_INSTANCE_ID = randomUUID();

export type LocalShellJobStatus = "pending" | "running" | "succeeded" | "failed" | "denied" | "expired";

export interface LocalShellJobContinuation {
  workSessionId: string | null;
  goalId: string | null;
  loopId: string | null;
}

export interface LocalShellJobCompletionProof {
  kind: "executor-reconnect";
  executorId: string;
  previousInstanceId: string | null;
  requiredHeartbeats: number;
  timeoutMs: number;
  requiredCapabilities?: string[];
}

export interface LocalShellJobRecord {
  id: string;
  executionTarget?: ExecutionTarget;
  projectId: string;
  command: string;
  executionKind?: "local-shell" | "command-run";
  commandId?: string;
  args?: string[];
  manifestFingerprint?: string;
  cwd: string | null;
  reason: string | null;
  taskIdentity?: string | null;
  workSessionId?: string | null;
  approvalId?: string;
  bundleFingerprint?: string;
  needsNetwork: boolean;
  destructive: boolean;
  timeoutSec: number | null;
  writesWorkspace: boolean;
  fingerprint?: string;
  continuation?: LocalShellJobContinuation | null;
  completionProof?: LocalShellJobCompletionProof | null;
  createdAt: number;
  expiresAt: number;
  status: LocalShellJobStatus;
  runnerInstanceId?: string;
  interruptedByRestart?: boolean;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  durationMs?: number;
  error?: string;
}

// No defaults or normalization: legacy optional fields and opaque fingerprints
// retain their original meaning, while persisted execution inputs are typed.
const LocalShellJobRecordSchema = z.object({
  id: z.string().regex(APPROVAL_ID_RE),
  projectId: z.string().min(1),
  command: z.string().min(1),
  executionTarget: ExecutionTargetSchema.optional(),
  executionKind: z.enum(["local-shell", "command-run"]).optional(),
  commandId: z.string().optional(),
  args: z.array(z.string()).optional(),
  manifestFingerprint: z.string().optional(),
  cwd: z.string().nullable(),
  reason: z.string().nullable(),
  taskIdentity: z.string().nullable().optional(),
  workSessionId: z.string().nullable().optional(),
  approvalId: z.string().optional(),
  bundleFingerprint: z.string().optional(),
  needsNetwork: z.boolean(),
  destructive: z.boolean(),
  timeoutSec: z.number().finite().nullable(),
  writesWorkspace: z.boolean(),
  fingerprint: z.string().optional(),
  continuation: z.object({
    workSessionId: z.string().nullable(), goalId: z.string().nullable(), loopId: z.string().nullable(),
  }).passthrough().nullable().optional(),
  completionProof: z.object({
    kind: z.literal("executor-reconnect"), executorId: z.string(), previousInstanceId: z.string().nullable(),
    requiredHeartbeats: z.number().finite(), timeoutMs: z.number().finite(),
    requiredCapabilities: z.array(z.string()).optional(),
  }).passthrough().nullable().optional(),
  createdAt: z.number().finite(),
  expiresAt: z.number().finite(),
  // `expired` was persisted by older JK runtimes. Keep it readable for
  // backward compatibility, but never consider it reusable below.
  status: z.enum(["pending", "running", "succeeded", "failed", "denied", "expired"]),
  runnerInstanceId: z.string().optional(),
  interruptedByRestart: z.boolean().optional(),
  startedAt: z.number().finite().optional(),
  finishedAt: z.number().finite().optional(),
  exitCode: z.number().finite().optional(),
  stdoutSummary: z.string().optional(),
  stderrSummary: z.string().optional(),
  durationMs: z.number().finite().optional(),
  error: z.string().optional(),
}).passthrough() satisfies z.ZodType<LocalShellJobRecord>;

export class LocalShellJobReadError extends DomainError {
  constructor(
    readonly jobId: string | null,
    readonly reason: "invalid-id" | "invalid-record" | "unreadable",
    cause?: unknown,
  ) {
    super(ErrorCode.APPROVAL_RESUME_FAILED, `Persisted local shell job cannot be read: ${reason}`, { jobId, reason });
    this.name = "LocalShellJobReadError";
    this.cause = cause;
  }
}

export interface LocalShellJobFingerprintInput {
  projectId: string;
  executionTarget?: ExecutionTarget;
  command: string;
  executionKind?: "local-shell" | "command-run";
  cwd?: string | null;
  reason?: string | null;
  taskIdentity?: string | null;
  workSessionId?: string | null;
  manifestFingerprint?: string | null;
  needsNetwork: boolean;
  destructive: boolean;
  writesWorkspace?: boolean;
  completionProof?: LocalShellJobCompletionProof | null;
  continuation?: LocalShellJobContinuation | null;
}

function restartStableExecutionTarget(target: ExecutionTarget): Omit<ExecutionTarget, "instanceId"> {
  const { instanceId: _instanceId, ...stable } = ExecutionTargetSchema.parse(target);
  return stable;
}

function jobOwner(input: LocalShellJobFingerprintInput): { taskIdentity: string | null; workSessionId: string | null } {
  const workSessionId = input.workSessionId?.trim() || null;
  let taskIdentity = input.taskIdentity?.trim() || null;
  const continuation = input.continuation;
  // Pre-port maintenance identities included the replaced instance. Convert only
  // when the stored target and continuation prove that exact historical owner.
  if (input.completionProof?.kind === "executor-reconnect" && input.executionTarget && continuation &&
      (continuation.goalId?.trim() || continuation.loopId?.trim()) &&
      (continuation.workSessionId?.trim() || null) === workSessionId) {
    const owner = taskApprovalIdentity(continuation);
    if (taskIdentity === targetApprovalIdentity(input.executionTarget, owner)) {
      taskIdentity = restartStableTargetApprovalIdentity(input.executionTarget, owner);
    }
  }
  return { taskIdentity, workSessionId };
}

type LocalShellJobAuthorization = Pick<
  LocalShellApprovalRecord,
  "id" | "projectId" | "createdAt" | "expiresAt" | "workSessionId" | "bundleFingerprint"
>;

export function localShellJobFingerprint(input: LocalShellJobFingerprintInput): string {
  const commandRun = input.executionKind === "command-run";
  const executionTarget = input.executionTarget ? ExecutionTargetSchema.parse(input.executionTarget) : null;
  const fingerprintTarget = executionTarget && input.completionProof?.kind === "executor-reconnect"
    ? restartStableExecutionTarget(executionTarget)
    : executionTarget;
  const fingerprintCompletionProof = input.completionProof?.kind === "executor-reconnect"
    ? (({ previousInstanceId: _previousInstanceId, ...stable }) => stable)(input.completionProof)
    : input.completionProof ?? null;
  return createHash("sha256")
    .update(JSON.stringify({
      projectId: input.projectId,
      executionTarget: fingerprintTarget,
      command: input.command,
      cwd: input.cwd ?? null,
      // Reason is human-facing audit metadata, not execution identity.
      // A wording-only change must not create a second approval/job.
      ...jobOwner(input),
      ...(commandRun
        ? { executionKind: "command-run" }
        : {
            needsNetwork: input.needsNetwork,
            destructive: input.destructive,
            writesWorkspace: Boolean(input.writesWorkspace),
            manifestFingerprint: input.manifestFingerprint?.trim() || null,
          }),
      completionProof: fingerprintCompletionProof,
    }))
    .digest("hex");
}

function recordFingerprint(record: LocalShellJobRecord): string {
  return localShellJobFingerprint(record);
}

// Bind existing approval task/scope namespaces without changing token consumption.
export function targetApprovalIdentity(target: ExecutionTarget, taskIdentity?: string): string {
  return `target:${createHash("sha256").update(JSON.stringify([
    ExecutionTargetSchema.parse(target), taskIdentity ?? null,
  ])).digest("hex")}`;
}

// Only runtime maintenance expects instance replacement; ordinary jobs stay pinned.
export function restartStableTargetApprovalIdentity(target: ExecutionTarget, taskIdentity?: string): string {
  return `target:${createHash("sha256").update(JSON.stringify([
    restartStableExecutionTarget(target), taskIdentity ?? null,
  ])).digest("hex")}`;
}

export interface PublicLocalShellJobRecord extends Omit<LocalShellJobRecord, "command" | "args" | "runnerInstanceId"> {
  commandPreview: string;
}

export function publicLocalShellJob(record: LocalShellJobRecord): PublicLocalShellJobRecord {
  const { command, args: _args, runnerInstanceId: _runnerInstanceId, ...rest } = record;
  return {
    ...rest,
    commandPreview: redact(command).slice(0, 800),
  };
}

export function localShellRunnerInstanceId(): string {
  return RUNNER_INSTANCE_ID;
}

function jobsDir(stateDir: string): string {
  return path.join(stateDir, "approvals", "shell", "jobs");
}

interface JobListCacheEntry {
  revision: string;
  records: LocalShellJobRecord[];
}

const jobListCache = new Map<string, JobListCacheEntry>();

async function jobDirectoryRevision(stateDir: string): Promise<string> {
  try {
    const info = await fs.stat(jobsDir(stateDir));
    return String(info.mtimeMs);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function invalidateJobListCache(stateDir: string): void {
  jobListCache.delete(stateDir);
}

function jobPath(stateDir: string, id: string): string {
  return path.join(jobsDir(stateDir), `${id}.json`);
}

export async function quarantineInvalidLocalShellJob(
  stateDir: string,
  error: LocalShellJobReadError,
): Promise<string | null> {
  if (error.reason !== "invalid-record" || !error.jobId || !APPROVAL_ID_RE.test(error.jobId)) return null;
  const dir = await ensureDir(stateDir);
  const quarantineDir = path.join(dir, "invalid");
  await fs.mkdir(quarantineDir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(quarantineDir, DIR_MODE).catch(() => undefined);
  const target = path.join(quarantineDir, `${error.jobId}.${Date.now()}.${randomUUID()}.json`);
  try {
    await fs.rename(jobPath(stateDir, error.jobId), target);
    invalidateJobListCache(stateDir);
    return target;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
}

async function readLocalShellJobWithInvalidQuarantine(
  stateDir: string,
  id: string,
): Promise<LocalShellJobRecord | null> {
  try {
    return await readLocalShellJob(stateDir, id);
  } catch (error) {
    if (!(error instanceof LocalShellJobReadError) || error.reason !== "invalid-record" || error.jobId !== id) throw error;
    await quarantineInvalidLocalShellJob(stateDir, error);
    return null;
  }
}

async function ensureDir(stateDir: string): Promise<string> {
  const dir = jobsDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => undefined);
  return dir;
}

async function writeJob(stateDir: string, record: LocalShellJobRecord): Promise<void> {
  const dir = await ensureDir(stateDir);
  const target = path.join(dir, `${record.id}.json`);
  const temp = path.join(dir, `.${record.id}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  await fs.chmod(temp, FILE_MODE).catch(() => undefined);
  await fs.rename(temp, target);
  invalidateJobListCache(stateDir);
}

async function reconcileInterruptedRunningJob(
  stateDir: string,
  record: LocalShellJobRecord,
  now = Date.now(),
): Promise<LocalShellJobRecord> {
  if (record.status !== "running" || record.runnerInstanceId === RUNNER_INSTANCE_ID) return record;
  const interrupted: LocalShellJobRecord = {
    ...record,
    status: "failed",
    interruptedByRestart: true,
    finishedAt: now,
    error: "JK runtime restarted while this job was running; execution outcome is unknown. Retry requires a new explicit approval.",
  };
  await writeJob(stateDir, interrupted);
  return interrupted;
}

export async function readLocalShellJob(stateDir: string, id: string): Promise<LocalShellJobRecord | null> {
  if (!APPROVAL_ID_RE.test(id)) throw new LocalShellJobReadError(id, "invalid-id");
  let bytes: string;
  try {
    bytes = await fs.readFile(jobPath(stateDir, id), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw new LocalShellJobReadError(id, "unreadable", error);
  }
  try {
    return LocalShellJobRecordSchema.extend({ id: z.literal(id) }).parse(JSON.parse(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new LocalShellJobReadError(id, "invalid-record", error);
    }
    throw error;
  }
}

async function readJobFiles(stateDir: string): Promise<string[]> {
  try {
    return await fs.readdir(jobsDir(stateDir));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw new LocalShellJobReadError(null, "unreadable", error);
  }
}

async function readAllJobRecords(stateDir: string, now = Date.now()): Promise<LocalShellJobRecord[]> {
  const revision = await jobDirectoryRevision(stateDir);
  const cached = jobListCache.get(stateDir);
  if (cached?.revision === revision) return cached.records;

  const files = await readJobFiles(stateDir);
  const records: LocalShellJobRecord[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const id = file.slice(0, -5);
    let record: LocalShellJobRecord | null;
    try {
      record = await readLocalShellJob(stateDir, id);
    } catch (error) {
      if (!(error instanceof LocalShellJobReadError) || error.reason !== "invalid-record" || error.jobId !== id) throw error;
      await quarantineInvalidLocalShellJob(stateDir, error);
      record = null;
    }
    if (record) record = await reconcileInterruptedRunningJob(stateDir, record, now);
    if (record) records.push(record);
  }
  const settledRevision = await jobDirectoryRevision(stateDir);
  jobListCache.set(stateDir, { revision: settledRevision, records });
  return records;
}

export async function queueLocalShellJob(
  stateDir: string,
  approval: LocalShellJobAuthorization,
  input: {
    command: string;
    executionTarget?: ExecutionTarget;
    executionKind?: "local-shell" | "command-run";
    commandId?: string;
    args?: string[];
    manifestFingerprint?: string;
    cwd?: string;
    reason?: string;
    taskIdentity?: string;
    workSessionId?: string | null;
    approvalId?: string;
    bundleFingerprint?: string;
    needsNetwork: boolean;
    destructive: boolean;
    timeoutSec?: number;
    writesWorkspace?: boolean;
    continuation?: LocalShellJobContinuation | null;
    completionProof?: LocalShellJobCompletionProof | null;
  },
): Promise<LocalShellJobRecord> {
  const workSessionId = input.workSessionId?.trim() || approval.workSessionId?.trim() || null;
  const fingerprint = localShellJobFingerprint({ projectId: approval.projectId, ...input, workSessionId });
  const approvalId = input.approvalId ?? approval.id;
  const bundleFingerprint = input.bundleFingerprint ?? approval.bundleFingerprint;
  const id = input.approvalId && bundleFingerprint
    ? createHash("sha256").update(JSON.stringify({ approvalId, bundleFingerprint, fingerprint })).digest("hex")
    : approval.id;
  const existing = await readLocalShellJob(stateDir, id);
  if (
    existing &&
    recordFingerprint(existing) === fingerprint &&
    existing.status !== "denied" &&
    (existing.status !== "pending" || existing.expiresAt > Date.now())
  ) {
    if (!existing.continuation && input.continuation) {
      const linked = { ...existing, continuation: input.continuation };
      await writeJob(stateDir, linked);
      return linked;
    }
    return existing;
  }

  const record: LocalShellJobRecord = {
    id,
    projectId: approval.projectId,
    executionTarget: input.executionTarget ? ExecutionTargetSchema.parse(input.executionTarget) : undefined,
    command: input.command,
    executionKind: input.executionKind ?? "local-shell",
    commandId: input.commandId,
    args: input.args,
    manifestFingerprint: input.manifestFingerprint,
    cwd: input.cwd ?? null,
    reason: input.reason ?? null,
    taskIdentity: input.taskIdentity?.trim() || null,
    workSessionId,
    approvalId,
    bundleFingerprint,
    needsNetwork: input.needsNetwork,
    destructive: input.destructive,
    timeoutSec: input.timeoutSec ?? null,
    writesWorkspace: Boolean(input.writesWorkspace),
    fingerprint,
    continuation: input.continuation ?? null,
    completionProof: input.completionProof ?? null,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    status: "pending",
  };
  await writeJob(stateDir, record);
  return record;
}

export async function findReusableLocalShellJob(
  stateDir: string,
  input: LocalShellJobFingerprintInput,
  now = Date.now(),
): Promise<LocalShellJobRecord | null> {
  const fingerprint = localShellJobFingerprint(input);
  const files = await readJobFiles(stateDir);
  const candidates: LocalShellJobRecord[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    let record = await readLocalShellJobWithInvalidQuarantine(stateDir, file.slice(0, -5));
    if (record) record = await reconcileInterruptedRunningJob(stateDir, record, now);
    if (!record || recordFingerprint(record) !== fingerprint) continue;
    const owner = jobOwner(input);
    const recordOwner = jobOwner(record);
    const sameTask = Boolean(owner.taskIdentity) && recordOwner.taskIdentity === owner.taskIdentity &&
      recordOwner.workSessionId === owner.workSessionId;
    if (record.status === "pending" && record.expiresAt > now) candidates.push(record);
    else if (record.status === "running") candidates.push(record);
    else if (sameTask && record.status === "succeeded" && record.finishedAt && now - record.finishedAt <= SUCCEEDED_REUSE_TTL_MS) {
      candidates.push(record);
    } else if (sameTask && record.status === "failed" && record.finishedAt && now - record.finishedAt <= FAILED_REUSE_TTL_MS) {
      candidates.push(record);
    }
  }
  return candidates.sort(
    (a, b) => (b.finishedAt ?? b.startedAt ?? b.createdAt) - (a.finishedAt ?? a.startedAt ?? a.createdAt),
  )[0] ?? null;
}

export async function updateLocalShellJob(
  stateDir: string,
  id: string,
  update: (current: LocalShellJobRecord) => LocalShellJobRecord,
): Promise<LocalShellJobRecord | null> {
  const current = await readLocalShellJob(stateDir, id);
  if (!current) return null;
  const next = update(current);
  await writeJob(stateDir, next);
  if (current.status !== "failed" && next.status === "failed") {
    void sendJkPush({
      kind: "failure",
      projectId: next.projectId,
      reason: next.reason ?? next.error,
    }, process.env, stateDir);
  }
  return next;
}

export async function markLocalShellJobDenied(stateDir: string, id: string): Promise<LocalShellJobRecord | null> {
  return await updateLocalShellJob(stateDir, id, (current) => ({
    ...current,
    status: "denied",
    finishedAt: Date.now(),
  }));
}

export async function listRecentLocalShellJobs(stateDir: string, limit = 20): Promise<PublicLocalShellJobRecord[]> {
  const revision = await jobDirectoryRevision(stateDir);
  const cached = jobListCache.get(stateDir);
  if (cached?.revision === revision) {
    return [...cached.records]
      .sort((a, b) => {
        const aAt = a.interruptedByRestart ? (a.startedAt ?? a.createdAt) : (a.finishedAt ?? a.startedAt ?? a.createdAt);
        const bAt = b.interruptedByRestart ? (b.startedAt ?? b.createdAt) : (b.finishedAt ?? b.startedAt ?? b.createdAt);
        return bAt - aAt;
      })
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(publicLocalShellJob);
  }
  const files = await readJobFiles(stateDir);
  const jobs: LocalShellJobRecord[] = [];
  const now = Date.now();
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    let record = await readLocalShellJobWithInvalidQuarantine(stateDir, file.slice(0, -5));
    if (record) record = await reconcileInterruptedRunningJob(stateDir, record, now);
    if (record) jobs.push(record);
  }
  const settledRevision = await jobDirectoryRevision(stateDir);
  if (settledRevision === revision) {
    jobListCache.set(stateDir, { revision: settledRevision, records: jobs });
  } else {
    invalidateJobListCache(stateDir);
  }
  return [...jobs]
    .sort((a, b) => {
      const aAt = a.interruptedByRestart ? (a.startedAt ?? a.createdAt) : (a.finishedAt ?? a.startedAt ?? a.createdAt);
      const bAt = b.interruptedByRestart ? (b.startedAt ?? b.createdAt) : (b.finishedAt ?? b.startedAt ?? b.createdAt);
      return bAt - aAt;
    })
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(publicLocalShellJob);
}
