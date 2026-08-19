import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { sendJkPush } from "../notifications/ntfy.js";
import { redact } from "./secrets.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_SCOPE_TTL_MS = 15 * 60 * 1000;
const SUPERVISED_TTL_MS = 30 * 60 * 1000;
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
  createdAt: number;
  expiresAt: number;
}

interface LocalShellTaskBundleRecord {
  id: string;
  projectId: string;
  cwd: string | null;
  taskKey: string;
  label: string;
  commandKeys: string[];
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

function taskBundlesDir(stateDir: string): string {
  return path.join(approvalsDir(stateDir), "task-bundles");
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

async function ensureTaskBundlesDir(stateDir: string): Promise<string> {
  const dir = taskBundlesDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => undefined);
  return dir;
}

function approvalId(input: LocalShellApprovalInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.projectId,
        command: input.command,
        cwd: input.cwd ?? null,
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

function taskBundleId(input: {
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

function taskBundleRecordPath(stateDir: string, id: string): string {
  return path.join(taskBundlesDir(stateDir), `${id}.json`);
}

async function readTaskBundleRecord(stateDir: string, id: string): Promise<LocalShellTaskBundleRecord | null> {
  if (!APPROVAL_ID_RE.test(id)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(taskBundleRecordPath(stateDir, id), "utf8")) as LocalShellTaskBundleRecord;
    return parsed && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

async function writeTaskBundleRecord(stateDir: string, record: LocalShellTaskBundleRecord): Promise<void> {
  const dir = await ensureTaskBundlesDir(stateDir);
  const target = path.join(dir, `${record.id}.json`);
  const temp = path.join(dir, `.${record.id}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  await fs.chmod(temp, FILE_MODE).catch(() => undefined);
  await fs.rename(temp, target);
}

async function hasActiveTaskBundleGrant(stateDir: string, input: LocalShellApprovalInput): Promise<boolean> {
  const taskKey = supervisedTaskKey(input);
  const id = taskBundleId(input);
  if (!taskKey || !id) return false;
  const record = await readTaskBundleRecord(stateDir, id);
  if (!record) return false;
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) {
    await fs.unlink(taskBundleRecordPath(stateDir, id)).catch(() => undefined);
    return false;
  }
  return record.projectId === input.projectId
    && record.cwd === (input.cwd ?? null)
    && record.taskKey === taskKey
    && record.commandKeys.includes(commandGrantKey(input));
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
  return record.projectId === input.projectId && record.cwd === (input.cwd ?? null) && record.taskKey === taskKey;
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
  const id = approvalId(input);
  const current = await readRecord(stateDir, id);
  if (current && !expired(current)) return current;
  if (current) await fs.unlink(recordPath(stateDir, id)).catch(() => undefined);

  const createdAt = Date.now();
  const bundleEntries = supervisedTaskKey(input) && input.bundle?.entries?.length
    ? input.bundle.entries.slice(0, 20)
    : [];
  const record: LocalShellApprovalRecord = {
    id,
    projectId: input.projectId,
    commandPreview: redact(input.command).slice(0, 800),
    cwd: input.cwd ?? null,
    reason: input.reason ? redact(input.reason).slice(0, 400) : null,
    ...(input.taskIdentity?.trim() ? { taskIdentity: input.taskIdentity.trim().slice(0, 240) } : {}),
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
          bundleCommandKeys: [...new Set(bundleEntries.map((entry) => commandGrantKey(entry)))],
          bundlePreviews: bundleEntries.map((entry) => {
            const risk = entry.destructive ? "[destructive] " : entry.needsNetwork ? "[network] " : "";
            return `${risk}${redact(entry.command).slice(0, 300)}`;
          }),
          bundleTtlMs: Math.min(Math.max(input.bundle?.ttlMs ?? TASK_BUNDLE_TTL_MS, 60_000), TASK_BUNDLE_TTL_MS),
        }
      : {}),
  };
  await writeRecord(stateDir, record);
  void sendJkPush({ kind: "approval", projectId: record.projectId, reason: record.reason }, process.env, stateDir);
  return record;
}

export async function consumeLocalShellApproval(
  stateDir: string,
  input: LocalShellApprovalInput,
): Promise<boolean> {
  const id = approvalId(input);
  const record = await readRecord(stateDir, id);
  if (record?.status === "approved" && !expired(record)) {
    const source = recordPath(stateDir, id);
    const consumed = path.join(approvalsDir(stateDir), `.${id}.${randomUUID()}.consumed`);
    try {
      await fs.rename(source, consumed);
      await fs.unlink(consumed).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }
  if (record && expired(record)) await fs.unlink(recordPath(stateDir, id)).catch(() => undefined);
  if (await hasActiveTaskBundleGrant(stateDir, input)) return true;
  if (await hasActiveSupervisedGrant(stateDir, input)) return true;
  if (await hasActiveScope(stateDir, input)) return true;
  return false;
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
  if (decision !== "deny" && record.bundleLabel && record.bundleCommandKeys?.length && (record.taskIdentity || record.reason)) {
    const taskKey = supervisedTaskKey(record);
    const bundleRecordId = taskBundleId({
      projectId: record.projectId,
      cwd: record.cwd ?? undefined,
      reason: record.reason,
      taskIdentity: record.taskIdentity,
    });
    if (taskKey && bundleRecordId) {
      const createdAt = Date.now();
      await writeTaskBundleRecord(stateDir, {
        id: bundleRecordId,
        projectId: record.projectId,
        cwd: record.cwd ?? null,
        taskKey,
        label: record.bundleLabel,
        commandKeys: record.bundleCommandKeys,
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
  if (decision === "supervise" && (record.reason || record.taskIdentity) && record.needsNetwork && !record.destructive) {
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
        createdAt,
        expiresAt: createdAt + SUPERVISED_TTL_MS,
      });
    }
  }
  return next;
}
