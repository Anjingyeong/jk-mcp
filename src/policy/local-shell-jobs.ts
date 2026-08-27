import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LocalShellApprovalRecord } from "./local-approvals.js";
import { sendJkPush } from "../notifications/ntfy.js";
import { redact } from "./secrets.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;
const SUCCEEDED_REUSE_TTL_MS = 30 * 60 * 1000;
const FAILED_REUSE_TTL_MS = 10 * 60 * 1000;
const RUNNER_INSTANCE_ID = randomUUID();

export type LocalShellJobStatus = "pending" | "running" | "succeeded" | "failed" | "denied";

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

export interface LocalShellJobFingerprintInput {
  projectId: string;
  command: string;
  executionKind?: "local-shell" | "command-run";
  cwd?: string | null;
  reason?: string | null;
  taskIdentity?: string | null;
  workSessionId?: string | null;
  needsNetwork: boolean;
  destructive: boolean;
  writesWorkspace?: boolean;
  completionProof?: LocalShellJobCompletionProof | null;
}

type LocalShellJobAuthorization = Pick<
  LocalShellApprovalRecord,
  "id" | "projectId" | "createdAt" | "expiresAt" | "workSessionId" | "bundleFingerprint"
>;

export function localShellJobFingerprint(input: LocalShellJobFingerprintInput): string {
  const commandRun = input.executionKind === "command-run";
  const workSessionId = input.workSessionId?.trim() || null;
  return createHash("sha256")
    .update(JSON.stringify({
      projectId: input.projectId,
      command: input.command,
      cwd: input.cwd ?? null,
      // Reason is human-facing audit metadata, not execution identity.
      // A wording-only change must not create a second approval/job.
      taskKey: workSessionId ? `work-session:${workSessionId}` : input.taskIdentity?.trim() || null,
      ...(commandRun
        ? { executionKind: "command-run" }
        : {
            needsNetwork: input.needsNetwork,
            destructive: input.destructive,
            writesWorkspace: Boolean(input.writesWorkspace),
          }),
      completionProof: input.completionProof ?? null,
    }))
    .digest("hex");
}

function recordFingerprint(record: LocalShellJobRecord): string {
  if (record.executionKind === "command-run") return localShellJobFingerprint(record);
  return record.fingerprint ?? localShellJobFingerprint(record);
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

function jobPath(stateDir: string, id: string): string {
  return path.join(jobsDir(stateDir), `${id}.json`);
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
  if (!APPROVAL_ID_RE.test(id)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(jobPath(stateDir, id), "utf8")) as LocalShellJobRecord;
    return parsed && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

export async function queueLocalShellJob(
  stateDir: string,
  approval: LocalShellJobAuthorization,
  input: {
    command: string;
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
  const dir = await ensureDir(stateDir);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const candidates: LocalShellJobRecord[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    let record = await readLocalShellJob(stateDir, file.slice(0, -5));
    if (record) record = await reconcileInterruptedRunningJob(stateDir, record, now);
    if (!record || recordFingerprint(record) !== fingerprint) continue;
    const workSessionId = input.workSessionId?.trim() || null;
    const sameTask = workSessionId
      ? record.workSessionId === workSessionId
      : Boolean(input.taskIdentity?.trim()) && record.taskIdentity === input.taskIdentity?.trim();
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
  const dir = await ensureDir(stateDir);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const jobs: LocalShellJobRecord[] = [];
  const now = Date.now();
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    let record = await readLocalShellJob(stateDir, file.slice(0, -5));
    if (record) record = await reconcileInterruptedRunningJob(stateDir, record, now);
    if (record) jobs.push(record);
  }
  return jobs
    .sort((a, b) => {
      const aAt = a.interruptedByRestart ? (a.startedAt ?? a.createdAt) : (a.finishedAt ?? a.startedAt ?? a.createdAt);
      const bAt = b.interruptedByRestart ? (b.startedAt ?? b.createdAt) : (b.finishedAt ?? b.startedAt ?? b.createdAt);
      return bAt - aAt;
    })
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(publicLocalShellJob);
}
