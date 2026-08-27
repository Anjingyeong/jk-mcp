import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { sendJkPush } from "../notifications/ntfy.js";
import {
  consumeLocalShellTaskBundle,
  localShellBundleFingerprint,
  localShellTaskBundleId,
  writeLocalShellTaskBundle,
} from "./local-approval-bundles.js";
import { redact } from "./secrets.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_SCOPE_TTL_MS = 15 * 60 * 1000;
const SUPERVISED_TTL_MS = 15 * 60 * 1000;
const TASK_BUNDLE_TTL_MS = 30 * 60 * 1000;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;

export type LocalShellApprovalStatus = "pending" | "approved" | "denied";
export type LocalShellApprovalDecision = "approve" | "supervise" | "deny";

export interface LocalShellApprovalRecord {
  id: string;
  projectId: string;
  commandPreview: string;
  cwd: string | null;
  reason: string | null;
  taskIdentity?: string;
  workSessionId?: string | null;
  needsNetwork: boolean;
  destructive: boolean;
  createdAt: number;
  expiresAt: number;
  status: LocalShellApprovalStatus;
  resolvedAt?: number;
  scopeKey?: string;
  scopeLabel?: string;
  scopeTtlMs?: number;
  bundleLabel?: string;
  bundleCommandKeys?: string[];
  bundlePreviews?: string[];
  bundleTtlMs?: number;
  bundleFingerprint?: string;
}

export interface LocalShellApprovalScope {
  key: string;
  label: string;
  ttlMs?: number;
}

export interface LocalShellApprovalBundleEntry {
  command: string;
  needsNetwork: boolean;
  destructive: boolean;
}

export interface LocalShellApprovalBundle {
  label: string;
  entries: LocalShellApprovalBundleEntry[];
  ttlMs?: number;
}

export interface LocalShellApprovalInput {
  projectId: string;
  command: string;
  cwd?: string;
  reason?: string;
  taskIdentity?: string;
  workSessionId?: string | null;
  needsNetwork: boolean;
  destructive: boolean;
  scope?: LocalShellApprovalScope;
  bundle?: LocalShellApprovalBundle;
}

interface LocalShellApprovalScopeRecord {
  id: string;
  projectId: string;
  cwd: string | null;
  scopeKey: string;
  scopeLabel: string;
  createdAt: number;
  expiresAt: number;
}

interface LocalShellSupervisedRecord {
  id: string;
  projectId: string;
  cwd: string | null;
  taskKey: string;
  taskLabel: string;
  verificationOnly?: boolean;
  createdAt: number;
  expiresAt: number;
}

function approvalsDir(stateDir: string): string {
  return path.join(stateDir, "approvals", "shell");
}

function scopesDir(stateDir: string): string {
  return path.join(approvalsDir(stateDir), "scopes");
}

function supervisedDir(stateDir: string): string {
  return path.join(approvalsDir(stateDir), "supervised");
}

async function ensureDir(stateDir: string): Promise<string> {
  const dir = approvalsDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => undefined);
  return dir;
}

async function ensureScopesDir(stateDir: string): Promise<string> {
  const dir = scopesDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => undefined);
  return dir;
}

async function ensureSupervisedDir(stateDir: string): Promise<string> {
  const dir = supervisedDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => undefined);
  return dir;
}

export function localShellApprovalId(input: LocalShellApprovalInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.projectId,
        command: input.command,
        cwd: input.cwd ?? null,
        taskIdentity: input.taskIdentity?.trim() || null,
        workSessionId: input.workSessionId?.trim() || null,
        needsNetwork: input.needsNetwork,
        destructive: input.destructive,
      }),
    )
    .digest("hex");
}

function recordPath(stateDir: string, id: string): string {
  return path.join(approvalsDir(stateDir), `${id}.json`);
}

function scopeId(input: Pick<LocalShellApprovalInput, "projectId" | "cwd"> & { scope: LocalShellApprovalScope }): string {
  return createHash("sha256")
    .update(JSON.stringify({ projectId: input.projectId, cwd: input.cwd ?? null, scopeKey: input.scope.key }))
    .digest("hex");
}

function scopeRecordPath(stateDir: string, id: string): string {
  return path.join(scopesDir(stateDir), `${id}.json`);
}

function reusableScopeAllowed(
  input: LocalShellApprovalInput,
): input is LocalShellApprovalInput & { scope: LocalShellApprovalScope } {
  if (!input.scope) return false;
  if (!input.destructive && input.needsNetwork) return true;
  return input.destructive && input.scope.key.startsWith("maintenance:jk:");
}

function normalizedTaskReason(reason: string | undefined | null): string | null {
  const normalized = reason?.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized ? normalized : null;
}

function supervisedTaskKey(input: { reason?: string | null; taskIdentity?: string }): string | null {
  const taskIdentity = input.taskIdentity?.trim();
  if (taskIdentity) return `task:${taskIdentity}`;
  return normalizedTaskReason(input.reason);
}

function supervisedId(input: {
  projectId: string;
  cwd?: string | null;
  reason?: string | null;
  taskIdentity?: string;
}): string | null {
  const taskKey = supervisedTaskKey(input);
  if (!taskKey) return null;
  return createHash("sha256")
    .update(JSON.stringify({ projectId: input.projectId, cwd: input.cwd ?? null, taskKey }))
    .digest("hex");
}

function supervisedRecordPath(stateDir: string, id: string): string {
  return path.join(supervisedDir(stateDir), `${id}.json`);
}

function commandGrantKey(input: Pick<LocalShellApprovalInput, "command" | "needsNetwork" | "destructive">): string {
  return createHash("sha256")
    .update(JSON.stringify({ command: input.command, needsNetwork: input.needsNetwork, destructive: input.destructive }))
    .digest("hex");
}

async function readSupervisedRecord(stateDir: string, id: string): Promise<LocalShellSupervisedRecord | null> {
  if (!APPROVAL_ID_RE.test(id)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(supervisedRecordPath(stateDir, id), "utf8")) as LocalShellSupervisedRecord;
    return parsed && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSupervisedRecord(stateDir: string, record: LocalShellSupervisedRecord): Promise<void> {
  const dir = await ensureSupervisedDir(stateDir);
  const target = path.join(dir, `${record.id}.json`);
  const temp = path.join(dir, `.${record.id}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  await fs.chmod(temp, FILE_MODE).catch(() => undefined);
  await fs.rename(temp, target);
}

async function hasActiveSupervisedGrant(stateDir: string, input: LocalShellApprovalInput): Promise<boolean> {
  if (input.destructive || !input.needsNetwork) return false;
  const taskKey = supervisedTaskKey(input);
  const id = supervisedId(input);
  if (!taskKey || !id) return false;
  const record = await readSupervisedRecord(stateDir, id);
  if (!record) return false;
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) {
    await fs.unlink(supervisedRecordPath(stateDir, id)).catch(() => undefined);
    return false;
  }
  if (record.verificationOnly && !input.scope) return false;
  return record.projectId === input.projectId && record.cwd === (input.cwd ?? null) && record.taskKey === taskKey;
}

export function taskApprovalIdentity(input: {
  goalId?: string | null;
  loopId?: string | null;
  workSessionId?: string | null;
  leaseId?: string | null;
}): string | undefined {
  const workSessionId = input.workSessionId?.trim() || null;
  const leaseId = input.leaseId?.trim() || null;
  if (input.goalId?.trim()) return `goal:${input.goalId.trim()}${workSessionId ? `:work-session:${workSessionId}` : ""}`;
  if (input.loopId?.trim()) return `loop:${input.loopId.trim()}${workSessionId ? `:work-session:${workSessionId}` : ""}`;
  if (workSessionId) return `work-session:${workSessionId}`;
  return leaseId ? `lease:${leaseId}` : undefined;
}

export async function hasActiveTaskNetworkApproval(
  stateDir: string,
  input: { projectId: string; cwd?: string; taskIdentity?: string; reason?: string },
): Promise<boolean> {
  if (!input.taskIdentity?.trim() && !input.reason?.trim()) return false;
  const taskKey = supervisedTaskKey(input);
  const id = supervisedId(input);
  if (!taskKey || !id) return false;
  const record = await readSupervisedRecord(stateDir, id);
  if (!record) return false;
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) {
    await fs.unlink(supervisedRecordPath(stateDir, id)).catch(() => undefined);
    return false;
  }
  return record.projectId === input.projectId
    && record.cwd === (input.cwd ?? null)
    && record.taskKey === taskKey;
}

async function readScopeRecord(stateDir: string, id: string): Promise<LocalShellApprovalScopeRecord | null> {
  if (!APPROVAL_ID_RE.test(id)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(scopeRecordPath(stateDir, id), "utf8")) as LocalShellApprovalScopeRecord;
    return parsed && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

async function writeScopeRecord(stateDir: string, record: LocalShellApprovalScopeRecord): Promise<void> {
  const dir = await ensureScopesDir(stateDir);
  const target = path.join(dir, `${record.id}.json`);
  const temp = path.join(dir, `.${record.id}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  await fs.chmod(temp, FILE_MODE).catch(() => undefined);
  await fs.rename(temp, target);
}

async function hasActiveScope(stateDir: string, input: LocalShellApprovalInput): Promise<boolean> {
  if (!reusableScopeAllowed(input)) return false;
  const id = scopeId({ projectId: input.projectId, cwd: input.cwd, scope: input.scope });
  const record = await readScopeRecord(stateDir, id);
  if (!record) return false;
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) {
    await fs.unlink(scopeRecordPath(stateDir, id)).catch(() => undefined);
    return false;
  }
  return record.projectId === input.projectId && record.scopeKey === input.scope.key && record.cwd === (input.cwd ?? null);
}

async function readRecord(stateDir: string, id: string): Promise<LocalShellApprovalRecord | null> {
  if (!APPROVAL_ID_RE.test(id)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(recordPath(stateDir, id), "utf8")) as LocalShellApprovalRecord;
    return parsed && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRecord(stateDir: string, record: LocalShellApprovalRecord): Promise<void> {
  const dir = await ensureDir(stateDir);
  const target = path.join(dir, `${record.id}.json`);
  const temp = path.join(dir, `.${record.id}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  await fs.chmod(temp, FILE_MODE).catch(() => undefined);
  await fs.rename(temp, target);
}

function expired(record: LocalShellApprovalRecord, now = Date.now()): boolean {
  return !Number.isFinite(record.expiresAt) || record.expiresAt <= now;
}

export async function requestLocalShellApproval(
  stateDir: string,
  input: LocalShellApprovalInput,
): Promise<LocalShellApprovalRecord> {
  const id = localShellApprovalId(input);
  const current = await readRecord(stateDir, id);
  const taskKey = supervisedTaskKey(input);
  const workSessionId = input.workSessionId?.trim().slice(0, 160) || null;
  const bundleEntries = taskKey && input.bundle?.entries?.length
    ? input.bundle.entries.slice(0, 20)
    : [];
  const bundleCommandKeys = [...new Set(bundleEntries.map((entry) => commandGrantKey(entry)))];
  const bundleFingerprint = taskKey && bundleCommandKeys.length
    ? localShellBundleFingerprint({
        projectId: input.projectId,
        cwd: input.cwd ?? null,
        taskKey,
        workSessionId,
        commandKeys: bundleCommandKeys,
      })
    : undefined;
  const bundlePreviews = bundleEntries.map((entry) => {
    const risk = entry.destructive ? "[destructive] " : entry.needsNetwork ? "[network] " : "";
    return `${risk}${redact(entry.command).slice(0, 300)}`;
  });
  const bundleTtlMs = bundleEntries.length
    ? Math.min(Math.max(input.bundle?.ttlMs ?? TASK_BUNDLE_TTL_MS, 60_000), TASK_BUNDLE_TTL_MS)
    : undefined;

  if (current && !expired(current)) {
    const currentKeys = current.bundleCommandKeys ?? [];
    const canUpgradePendingBundle =
      current.status === "pending" &&
      Boolean(taskKey) &&
      bundleEntries.length > 0 &&
      supervisedTaskKey(current) === taskKey &&
      (current.workSessionId ?? null) === workSessionId &&
      bundleCommandKeys.includes(commandGrantKey(input)) &&
      currentKeys.every((key) => bundleCommandKeys.includes(key));
    if (canUpgradePendingBundle) {
      const upgraded: LocalShellApprovalRecord = {
        ...current,
        bundleLabel: redact(input.bundle?.label ?? current.bundleLabel ?? "Task bundle").slice(0, 160),
        bundleCommandKeys,
        bundleFingerprint,
        bundlePreviews,
        bundleTtlMs,
      };
      await writeRecord(stateDir, upgraded);
      return upgraded;
    }
    return current;
  }
  if (current) await fs.unlink(recordPath(stateDir, id)).catch(() => undefined);

  if (taskKey) {
    const commandKey = commandGrantKey(input);
    const pending = await listPendingLocalShellApprovals(stateDir);
    const bundled = pending.find((record) => (
      record.projectId === input.projectId &&
      record.cwd === (input.cwd ?? null) &&
      supervisedTaskKey(record) === taskKey &&
      (record.workSessionId ?? null) === workSessionId &&
      (!bundleFingerprint || record.bundleFingerprint === bundleFingerprint) &&
      Boolean(record.bundleCommandKeys?.includes(commandKey))
    ));
    if (bundled) return bundled;
  }

  const createdAt = Date.now();
  const record: LocalShellApprovalRecord = {
    id,
    projectId: input.projectId,
    commandPreview: redact(input.command).slice(0, 800),
    cwd: input.cwd ?? null,
    reason: input.reason ? redact(input.reason).slice(0, 400) : null,
    ...(input.taskIdentity?.trim() ? { taskIdentity: input.taskIdentity.trim().slice(0, 240) } : {}),
    ...(workSessionId ? { workSessionId } : {}),
    needsNetwork: input.needsNetwork,
    destructive: input.destructive,
    createdAt,
    expiresAt: createdAt + APPROVAL_TTL_MS,
    status: "pending",
    ...(reusableScopeAllowed(input)
      ? {
          scopeKey: input.scope.key.slice(0, 240),
          scopeLabel: redact(input.scope.label).slice(0, 160),
          scopeTtlMs: Math.min(Math.max(input.scope.ttlMs ?? MAX_SCOPE_TTL_MS, 60_000), MAX_SCOPE_TTL_MS),
        }
      : {}),
    ...(bundleEntries.length
      ? {
          bundleLabel: redact(input.bundle?.label ?? "Task bundle").slice(0, 160),
          bundleCommandKeys,
          bundleFingerprint,
          bundlePreviews,
          bundleTtlMs,
        }
      : {}),
  };
  await writeRecord(stateDir, record);
  void sendJkPush({
    kind: "approval",
    projectId: record.projectId,
    reason: record.reason,
  }, process.env, stateDir);
  return record;
}

export type LocalShellApprovalGrant =
  | {
      source: "exact" | "task-bundle";
      approvalId: string;
      bundleFingerprint?: string;
      workSessionId: string | null;
      createdAt: number;
      expiresAt: number;
    }
  | { source: "supervised" | "scope" };

export async function consumeLocalShellApprovalGrant(
  stateDir: string,
  input: LocalShellApprovalInput,
): Promise<LocalShellApprovalGrant | null> {
  const id = localShellApprovalId(input);
  const record = await readRecord(stateDir, id);
  if (record?.status === "approved" && !expired(record)) {
    const source = recordPath(stateDir, id);
    const consumed = path.join(approvalsDir(stateDir), `.${id}.${randomUUID()}.consumed`);
    try {
      await fs.rename(source, consumed);
      await fs.unlink(consumed).catch(() => undefined);
      const taskKey = supervisedTaskKey(input);
      if (record.bundleFingerprint && taskKey) {
        await consumeLocalShellTaskBundle(stateDir, {
          projectId: input.projectId,
          cwd: input.cwd ?? null,
          taskKey,
          workSessionId: input.workSessionId?.trim() || null,
          commandKey: commandGrantKey(input),
        });
      }
      return {
        source: "exact",
        approvalId: record.id,
        bundleFingerprint: record.bundleFingerprint,
        workSessionId: record.workSessionId ?? null,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      };
    } catch {
      return null;
    }
  }
  if (record && expired(record)) await fs.unlink(recordPath(stateDir, id)).catch(() => undefined);
  const taskKey = supervisedTaskKey(input);
  if (taskKey) {
    const bundleGrant = await consumeLocalShellTaskBundle(stateDir, {
      projectId: input.projectId,
      cwd: input.cwd ?? null,
      taskKey,
      workSessionId: input.workSessionId?.trim() || null,
      commandKey: commandGrantKey(input),
    });
    if (bundleGrant) return { source: "task-bundle", ...bundleGrant };
  }
  if (await hasActiveSupervisedGrant(stateDir, input)) return { source: "supervised" };
  if (await hasActiveScope(stateDir, input)) return { source: "scope" };
  return null;
}

export async function consumeLocalShellApproval(
  stateDir: string,
  input: LocalShellApprovalInput,
): Promise<boolean> {
  return Boolean(await consumeLocalShellApprovalGrant(stateDir, input));
}

export async function listPendingLocalShellApprovals(stateDir: string): Promise<LocalShellApprovalRecord[]> {
  const dir = await ensureDir(stateDir);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const records: LocalShellApprovalRecord[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const id = file.slice(0, -5);
    const record = await readRecord(stateDir, id);
    if (!record) continue;
    if (expired(record)) {
      await fs.unlink(recordPath(stateDir, id)).catch(() => undefined);
      continue;
    }
    if (record.status === "pending") records.push(record);
  }
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function resolveLocalShellApproval(
  stateDir: string,
  id: string,
  decision: LocalShellApprovalDecision,
): Promise<LocalShellApprovalRecord> {
  if (!APPROVAL_ID_RE.test(id)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid approval id");
  }
  const record = await readRecord(stateDir, id);
  if (!record || expired(record)) {
    if (record) await fs.unlink(recordPath(stateDir, id)).catch(() => undefined);
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Approval request is missing or expired");
  }
  if (record.status !== "pending") return record;
  const next: LocalShellApprovalRecord = {
    ...record,
    status: decision === "deny" ? "denied" : "approved",
    resolvedAt: Date.now(),
  };
  await writeRecord(stateDir, next);
  if (
    decision !== "deny" &&
    record.bundleLabel &&
    record.bundleCommandKeys?.length &&
    (record.taskIdentity || record.reason)
  ) {
    const taskKey = supervisedTaskKey(record);
    if (taskKey && record.bundleFingerprint) {
      const createdAt = Date.now();
      const workSessionId = record.workSessionId ?? null;
      await writeLocalShellTaskBundle(stateDir, {
        id: localShellTaskBundleId({
          projectId: record.projectId,
          cwd: record.cwd,
          taskKey,
          workSessionId,
        }),
        approvalId: record.id,
        bundleFingerprint: record.bundleFingerprint,
        workSessionId,
        projectId: record.projectId,
        cwd: record.cwd ?? null,
        taskKey,
        label: record.bundleLabel,
        commandKeys: record.bundleCommandKeys,
        remainingCommandKeys: record.bundleCommandKeys,
        createdAt,
        expiresAt: createdAt + Math.min(Math.max(record.bundleTtlMs ?? TASK_BUNDLE_TTL_MS, 60_000), TASK_BUNDLE_TTL_MS),
      });
    }
  }
  if (
    decision === "approve" &&
    record.scopeKey &&
    record.scopeLabel &&
    ((record.needsNetwork && !record.destructive) || (record.destructive && record.scopeKey.startsWith("maintenance:jk:")))
  ) {
    const scope: LocalShellApprovalScope = {
      key: record.scopeKey,
      label: record.scopeLabel,
      ttlMs: record.scopeTtlMs,
    };
    const createdAt = Date.now();
    const id = scopeId({ projectId: record.projectId, cwd: record.cwd ?? undefined, scope });
    await writeScopeRecord(stateDir, {
      id,
      projectId: record.projectId,
      cwd: record.cwd ?? null,
      scopeKey: scope.key,
      scopeLabel: scope.label,
      createdAt,
      expiresAt: createdAt + Math.min(Math.max(scope.ttlMs ?? MAX_SCOPE_TTL_MS, 60_000), MAX_SCOPE_TTL_MS),
    });
  }
  if (
    ((decision === "approve" && Boolean(record.taskIdentity)) ||
      (decision === "supervise" && Boolean(record.reason || record.taskIdentity) && !record.destructive)) &&
    record.needsNetwork
  ) {
    const verificationOnly = decision === "approve";
    const taskKey = supervisedTaskKey(record);
    const supervisedRecordId = supervisedId({
      projectId: record.projectId,
      cwd: record.cwd ?? undefined,
      reason: record.reason,
      taskIdentity: record.taskIdentity,
    });
    if (taskKey && supervisedRecordId) {
      const createdAt = Date.now();
      await writeSupervisedRecord(stateDir, {
        id: supervisedRecordId,
        projectId: record.projectId,
        cwd: record.cwd ?? null,
        taskKey,
        taskLabel: redact(record.reason ?? record.taskIdentity ?? "supervised task").slice(0, 160),
        verificationOnly,
        createdAt,
        expiresAt: createdAt + SUPERVISED_TTL_MS,
      });
    }
  }
  return next;
}
