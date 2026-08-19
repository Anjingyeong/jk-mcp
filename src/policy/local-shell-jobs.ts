import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sendJkPush } from "../notifications/ntfy.js";
import type { LocalShellApprovalRecord } from "./local-approvals.js";
import { redact } from "./secrets.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;

export type LocalShellJobStatus = "pending" | "running" | "succeeded" | "failed" | "denied" | "expired";

const DEFAULT_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RUNNING_GRACE_MS = 60_000;
const STALE_RUNNING_JOB_ERROR = "Interrupted or stale running job reconciled after timeout";

export interface LocalShellJobContinuation {
  workSessionId: string | null;
  goalId: string | null;
  loopId: string | null;
}

export interface LocalShellJobRecord {
  id: string;
  projectId: string;
  command: string;
  cwd: string | null;
  reason: string | null;
  needsNetwork: boolean;
  destructive: boolean;
  timeoutSec: number | null;
  writesWorkspace: boolean;
  continuation?: LocalShellJobContinuation | null;
  createdAt: number;
  expiresAt: number;
  status: LocalShellJobStatus;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  durationMs?: number;
  error?: string;
}

export interface PublicLocalShellJobRecord extends Omit<LocalShellJobRecord, "command"> {
  commandPreview: string;
}

export function publicLocalShellJob(record: LocalShellJobRecord): PublicLocalShellJobRecord {
  const { command, ...rest } = record;
  return {
    ...rest,
    commandPreview: redact(command).slice(0, 800),
  };
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
  approval: LocalShellApprovalRecord,
  input: {
    command: string;
    cwd?: string;
    reason?: string;
    needsNetwork: boolean;
    destructive: boolean;
    timeoutSec?: number;
    writesWorkspace?: boolean;
    continuation?: LocalShellJobContinuation | null;
  },
): Promise<LocalShellJobRecord> {
  const existing = await readLocalShellJob(stateDir, approval.id);
  if (existing && existing.status === "pending" && existing.expiresAt > Date.now()) {
    if (!existing.continuation && input.continuation) {
      const linked = { ...existing, continuation: input.continuation };
      await writeJob(stateDir, linked);
      return linked;
    }
    return existing;
  }

  const record: LocalShellJobRecord = {
    id: approval.id,
    projectId: approval.projectId,
    command: input.command,
    cwd: input.cwd ?? null,
    reason: input.reason ?? null,
    needsNetwork: input.needsNetwork,
    destructive: input.destructive,
    timeoutSec: input.timeoutSec ?? null,
    writesWorkspace: Boolean(input.writesWorkspace),
    continuation: input.continuation ?? null,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    status: "pending",
  };
  await writeJob(stateDir, record);
  return record;
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
  if (current.status !== next.status && next.status === "failed") {
    void sendJkPush({ kind: "failure", projectId: next.projectId, reason: next.reason ?? next.error }, process.env, stateDir);
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

export async function reconcileLocalShellJobs(
  stateDir: string,
  options: { now?: number; retentionMs?: number; runningGraceMs?: number } = {},
): Promise<{ expired: number; failed: number; removed: number }> {
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? DEFAULT_JOB_RETENTION_MS;
  const runningGraceMs = options.runningGraceMs ?? DEFAULT_RUNNING_GRACE_MS;
  const dir = await ensureDir(stateDir);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  let expired = 0;
  let failed = 0;
  let removed = 0;

  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const id = file.slice(0, -5);
    const record = await readLocalShellJob(stateDir, id);
    if (!record) continue;

    if (record.status === "pending" && record.expiresAt <= now) {
      await updateLocalShellJob(stateDir, id, (current) => ({
        ...current,
        status: "expired",
        finishedAt: now,
        error: current.error ?? "Approval expired before execution",
      }));
      expired += 1;
      continue;
    }

    if (record.status === "running" && record.startedAt) {
      const timeoutMs = Math.max(1, record.timeoutSec ?? 30) * 1_000;
      if (record.startedAt + timeoutMs + runningGraceMs <= now) {
        const staleAt = Math.min(now, record.startedAt + timeoutMs + runningGraceMs);
        await updateLocalShellJob(stateDir, id, (current) => ({
          ...current,
          status: "failed",
          finishedAt: staleAt,
          error: current.error ?? STALE_RUNNING_JOB_ERROR,
        }));
        failed += 1;
        continue;
      }
    }

    if (["succeeded", "failed", "denied", "expired"].includes(record.status)) {
      const terminalAt = record.finishedAt ?? record.startedAt ?? record.createdAt;
      if (terminalAt + retentionMs <= now) {
        await fs.unlink(jobPath(stateDir, id)).catch(() => undefined);
        removed += 1;
      }
    }
  }

  return { expired, failed, removed };
}

export async function listRecentLocalShellJobs(stateDir: string, limit = 20): Promise<PublicLocalShellJobRecord[]> {
  await reconcileLocalShellJobs(stateDir);
  const dir = await ensureDir(stateDir);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const jobs: LocalShellJobRecord[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const record = await readLocalShellJob(stateDir, file.slice(0, -5));
    if (record) jobs.push(record);
  }
  const sortAt = (record: LocalShellJobRecord): number => {
    if (record.status === "failed" && record.error === STALE_RUNNING_JOB_ERROR) {
      return record.startedAt ?? record.createdAt;
    }
    return record.finishedAt ?? record.startedAt ?? record.createdAt;
  };
  return jobs
    .sort((a, b) => sortAt(b) - sortAt(a))
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(publicLocalShellJob);
}
