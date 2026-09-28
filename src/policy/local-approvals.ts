import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { sendJkPush } from "../notifications/ntfy.js";
import {
  consumeLocalShellTaskBundle,
  localShellBundleFingerprint,
  localShellTaskBundleId,
  localShellTaskBundleRecordId,
  withLocalShellExactApprovalLock,
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
  resolvedDecision?: LocalShellApprovalDecision;
  scopeKey?: string;
  scopeLabel?: string;
  scopeTtlMs?: number;
  bundleLabel?: string;
  bundleCommandKeys?: string[];
  bundlePreviews?: string[];
  bundleTtlMs?: number;
  bundleFingerprint?: string;
}

interface PendingApprovalCacheEntry {
  revision: string;
  records: LocalShellApprovalRecord[];
}

const pendingApprovalCache = new Map<string, PendingApprovalCacheEntry>();

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

function archivedApprovalsDir(stateDir: string): string {
  return path.join(approvalsDir(stateDir), "archive");
}

async function approvalDirectoryRevision(stateDir: string): Promise<string> {
  try {
    const info = await fs.stat(approvalsDir(stateDir));
    return String(info.mtimeMs);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function invalidatePendingApprovalCache(stateDir: string): void {
  pendingApprovalCache.delete(stateDir);
}

async function archiveExpiredApprovalRecord(stateDir: string, record: LocalShellApprovalRecord): Promise<void> {
  const archiveDir = archivedApprovalsDir(stateDir);
  await fs.mkdir(archiveDir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(archiveDir, DIR_MODE).catch(() => undefined);
  const target = path.join(archiveDir, `${record.id}.${record.createdAt}.${randomUUID()}.json`);
  try {
    await fs.rename(recordPath(stateDir, record.id), target);
    invalidatePendingApprovalCache(stateDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function archiveExpiredApprovalRecordsInBackground(
  stateDir: string,
  records: LocalShellApprovalRecord[],
): Promise<void> {
  for (const record of records) {
    await archiveExpiredApprovalRecord(stateDir, record).catch(() => undefined);
  }
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

const supervisedRecordSchema = z.object({
  id: z.string().regex(APPROVAL_ID_RE), projectId: z.string(), cwd: z.string().nullable(),
  taskKey: z.string(), taskLabel: z.string(), verificationOnly: z.boolean().optional(),
  createdAt: z.number().finite().nonnegative(), expiresAt: z.number().finite(),
}).refine((record) => record.expiresAt > record.createdAt && record.expiresAt - record.createdAt <= SUPERVISED_TTL_MS
  && record.id === createHash("sha256").update(JSON.stringify({ projectId: record.projectId, cwd: record.cwd, taskKey: record.taskKey })).digest("hex"));

async function readSupervisedRecord(stateDir: string, id: string): Promise<LocalShellSupervisedRecord | null> {
  if (!APPROVAL_ID_RE.test(id)) return null;
  try {
    const parsed = supervisedRecordSchema.parse(JSON.parse(await fs.readFile(supervisedRecordPath(stateDir, id), "utf8")));
    if (parsed.id !== id) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid supervised approval file identity");
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid persisted supervised approval");
    }
    throw error;
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

const scopeRecordSchema = z.object({
  id: z.string().regex(APPROVAL_ID_RE), projectId: z.string(), cwd: z.string().nullable(),
  scopeKey: z.string(), scopeLabel: z.string(), createdAt: z.number().finite().nonnegative(), expiresAt: z.number().finite(),
}).refine((record) => record.expiresAt > record.createdAt && record.expiresAt - record.createdAt <= MAX_SCOPE_TTL_MS
  && record.id === scopeId({ projectId: record.projectId, cwd: record.cwd ?? undefined, scope: { key: record.scopeKey, label: record.scopeLabel } }));

async function readScopeRecord(stateDir: string, id: string): Promise<LocalShellApprovalScopeRecord | null> {
  if (!APPROVAL_ID_RE.test(id)) return null;
  try {
    const parsed = scopeRecordSchema.parse(JSON.parse(await fs.readFile(scopeRecordPath(stateDir, id), "utf8")));
    if (parsed.id !== id) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid scoped approval file identity");
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid persisted scoped approval");
    }
    throw error;
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

const approvalRecordSchema = z.object({
  id: z.string().regex(APPROVAL_ID_RE), projectId: z.string(), commandPreview: z.string(),
  cwd: z.string().nullable(), reason: z.string().nullable(), taskIdentity: z.string().optional(),
  workSessionId: z.string().nullable().optional(), needsNetwork: z.boolean(), destructive: z.boolean(),
  createdAt: z.number().finite().nonnegative(), expiresAt: z.number().finite(),
  status: z.enum(["pending", "approved", "denied"]), resolvedAt: z.number().finite().optional(),
  resolvedDecision: z.enum(["approve", "supervise", "deny"]).optional(),
  scopeKey: z.string().optional(), scopeLabel: z.string().optional(),
  scopeTtlMs: z.number().finite().min(60_000).max(MAX_SCOPE_TTL_MS).optional(),
  bundleLabel: z.string().optional(), bundlePreviews: z.array(z.string()).optional(),
  bundleCommandKeys: z.array(z.string().regex(APPROVAL_ID_RE)).min(1).max(20)
    .refine((keys) => new Set(keys).size === keys.length).optional(),
  bundleTtlMs: z.number().finite().min(60_000).max(TASK_BUNDLE_TTL_MS).optional(),
  bundleFingerprint: z.string().regex(APPROVAL_ID_RE).optional(),
}).passthrough().refine((record) => {
  if (record.expiresAt <= record.createdAt) return false;
  if (record.resolvedAt !== undefined && (record.resolvedAt < record.createdAt || record.resolvedAt >= record.expiresAt)) return false;
  if (record.resolvedDecision !== undefined && (record.resolvedAt === undefined
    || record.status !== (record.resolvedDecision === "deny" ? "denied" : "approved"))) return false;
  if (record.bundleFingerprint === undefined) return record.bundleCommandKeys === undefined;
  const taskKey = supervisedTaskKey(record);
  return Boolean(taskKey && record.bundleCommandKeys && record.bundleLabel !== undefined
    && record.bundleFingerprint === localShellBundleFingerprint({
      projectId: record.projectId, cwd: record.cwd, taskKey, workSessionId: record.workSessionId ?? null,
      commandKeys: record.bundleCommandKeys,
    }));
});

async function readRecord(stateDir: string, id: string): Promise<LocalShellApprovalRecord | null> {
  if (!APPROVAL_ID_RE.test(id)) return null;
  try {
    const parsed = approvalRecordSchema.parse(JSON.parse(await fs.readFile(recordPath(stateDir, id), "utf8")));
    if (parsed.id !== id) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid approval file identity");
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid persisted approval record");
    }
    throw error;
  }
}

async function writeRecord(stateDir: string, record: LocalShellApprovalRecord): Promise<void> {
  const dir = await ensureDir(stateDir);
  const target = path.join(dir, `${record.id}.json`);
  const temp = path.join(dir, `.${record.id}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  await fs.chmod(temp, FILE_MODE).catch(() => undefined);
  await fs.rename(temp, target);
  invalidatePendingApprovalCache(stateDir);
}

function expired(record: LocalShellApprovalRecord, now = Date.now()): boolean {
  return !Number.isFinite(record.expiresAt) || record.expiresAt <= now;
}

export async function requestLocalShellApproval(
  stateDir: string,
  input: LocalShellApprovalInput,
): Promise<LocalShellApprovalRecord> {
  return withLocalShellExactApprovalLock(stateDir, localShellApprovalId(input), () => requestLocked(stateDir, input));
}

async function requestLocked(stateDir: string, input: LocalShellApprovalInput): Promise<LocalShellApprovalRecord> {
  const id = localShellApprovalId(input);
  const current = await readRecord(stateDir, id);
  if (current && !expired(current)) return current;
  const taskKey = supervisedTaskKey(input);
  const workSessionId = input.workSessionId?.trim() || null;
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

  if (current) await archiveExpiredApprovalRecord(stateDir, current);

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
    ...(input.taskIdentity?.trim() ? { taskIdentity: input.taskIdentity.trim() } : {}),
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
  return withLocalShellExactApprovalLock(stateDir, localShellApprovalId(input), () => consumeLocked(stateDir, input));
}

async function consumeLocked(stateDir: string, input: LocalShellApprovalInput): Promise<LocalShellApprovalGrant | null> {
  const id = localShellApprovalId(input);
  const record = await readRecord(stateDir, id);
  if (record && (record.projectId !== input.projectId || record.cwd !== (input.cwd ?? null)
    || (record.taskIdentity?.trim() || null) !== (input.taskIdentity?.trim() || null)
    || (record.workSessionId ?? null) !== (input.workSessionId?.trim() || null)
    || record.needsNetwork !== input.needsNetwork || record.destructive !== input.destructive)) return null;
  if (record?.status === "approved" && !expired(record)) {
    const source = recordPath(stateDir, id);
    const consumed = path.join(approvalsDir(stateDir), `.${id}.${randomUUID()}.consumed`);
    await fs.rename(source, consumed);
    invalidatePendingApprovalCache(stateDir);
    if (record.bundleFingerprint) {
      try {
        const taskKey = supervisedTaskKey(input);
        if (!taskKey) return null;
        const grant = await consumeLocalShellTaskBundle(stateDir, {
          projectId: input.projectId,
          cwd: input.cwd ?? null,
          taskKey,
          workSessionId: input.workSessionId?.trim() || null,
          commandKey: commandGrantKey(input),
          expected: { approvalId: record.id, bundleFingerprint: record.bundleFingerprint, approvalCreatedAt: record.createdAt },
        });
        return grant ? { source: "exact", ...grant } : null;
      } finally {
        // The marker records the decision, not a second token. Retain it for
        // publication retries; even an exhausted bundle must not be republished.
        await fs.rename(consumed, source);
        invalidatePendingApprovalCache(stateDir);
      }
    }
    await fs.unlink(consumed);
    invalidatePendingApprovalCache(stateDir);
    return {
      source: "exact", approvalId: record.id, workSessionId: record.workSessionId ?? null,
      createdAt: record.createdAt, expiresAt: record.expiresAt,
    };
  }
  if (record && expired(record)) {
    await archiveExpiredApprovalRecord(stateDir, record);
  }
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
  const revision = await approvalDirectoryRevision(stateDir);
  const cached = pendingApprovalCache.get(stateDir);
  const now = Date.now();
  if (cached?.revision === revision) {
    const active = cached.records.filter((record) => record.status === "pending" && !expired(record, now));
    if (active.length !== cached.records.length) {
      pendingApprovalCache.set(stateDir, { revision, records: active });
    }
    return [...active].sort((a, b) => b.createdAt - a.createdAt);
  }
  const files = await fs.readdir(dir);
  const records: LocalShellApprovalRecord[] = [];
  const expiredRecords: LocalShellApprovalRecord[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const id = file.slice(0, -5);
    const record = await readRecord(stateDir, id);
    if (!record) continue;
    if (expired(record, now)) {
      expiredRecords.push(record);
      continue;
    }
    if (record.status === "pending") records.push(record);
  }
  const settledRevision = await approvalDirectoryRevision(stateDir);
  if (settledRevision === revision) {
    pendingApprovalCache.set(stateDir, { revision: settledRevision, records });
  } else {
    invalidatePendingApprovalCache(stateDir);
  }
  if (expiredRecords.length) void archiveExpiredApprovalRecordsInBackground(stateDir, expiredRecords);
  return [...records].sort((a, b) => b.createdAt - a.createdAt);
}

export async function resolveLocalShellApproval(
  stateDir: string,
  id: string,
  decision: LocalShellApprovalDecision,
): Promise<LocalShellApprovalRecord> {
  if (!APPROVAL_ID_RE.test(id)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid approval id");
  }
  return withLocalShellExactApprovalLock(stateDir, id, () => resolveLocked(stateDir, id, decision));
}

async function resolveLocked(
  stateDir: string, id: string, requestedDecision: LocalShellApprovalDecision,
): Promise<LocalShellApprovalRecord> {
  const record = await readRecord(stateDir, id);
  if (!record || expired(record)) {
    if (record) await archiveExpiredApprovalRecord(stateDir, record);
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Approval request is missing or expired");
  }
  // Legacy resolved markers cannot safely reconstruct authority that may have
  // been overwritten or spent by an older binary.
  if (record.status !== "pending" && record.resolvedDecision === undefined) return record;
  const decision = record.resolvedDecision ?? requestedDecision;
  const resolvedAt = record.resolvedAt ?? Date.now();
  const next: LocalShellApprovalRecord = record.status === "pending" ? {
    ...record,
    status: decision === "deny" ? "denied" : "approved",
    resolvedAt,
    resolvedDecision: decision,
  } : record;
  if (record.status === "pending") await writeRecord(stateDir, next);
  if (
    decision !== "deny" &&
    record.bundleLabel &&
    record.bundleCommandKeys?.length &&
    (record.taskIdentity || record.reason)
  ) {
    const taskKey = supervisedTaskKey(record);
    if (taskKey && record.bundleFingerprint) {
      const createdAt = resolvedAt;
      const workSessionId = record.workSessionId ?? null;
      const identityId = localShellTaskBundleId({ projectId: record.projectId, cwd: record.cwd, taskKey, workSessionId });
      await writeLocalShellTaskBundle(stateDir, {
        version: 2,
        identityId,
        approvalCreatedAt: record.createdAt,
        id: localShellTaskBundleRecordId({
          identityId, approvalId: record.id, bundleFingerprint: record.bundleFingerprint, approvalCreatedAt: record.createdAt,
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
    const createdAt = resolvedAt;
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
      (decision === "supervise" && Boolean(record.reason || record.taskIdentity) && (
        !record.destructive ||
        Boolean(record.bundleFingerprint && record.bundleCommandKeys?.length && record.taskIdentity && record.workSessionId)
      ))) &&
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
      const createdAt = resolvedAt;
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
