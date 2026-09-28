import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { acquireMassUlwLock } from "../orchestration/mass-ulw-lock.js";
import { DomainError, ErrorCode } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;
const bundleOperations = new Map<string, Promise<void>>();

export interface LocalShellTaskBundleRecord {
  version?: 2;
  identityId?: string;
  approvalCreatedAt?: number;
  id: string;
  approvalId: string;
  bundleFingerprint: string;
  workSessionId: string | null;
  projectId: string;
  cwd: string | null;
  taskKey: string;
  label: string;
  commandKeys: string[];
  remainingCommandKeys: string[];
  createdAt: number;
  expiresAt: number;
}

export interface LocalShellTaskBundleGrant {
  approvalId: string;
  bundleFingerprint: string;
  workSessionId: string | null;
  createdAt: number;
  expiresAt: number;
}

interface TaskBundleIdentity {
  projectId: string;
  cwd: string | null;
  taskKey: string;
  workSessionId: string | null;
}

interface ConsumeTaskBundleInput extends TaskBundleIdentity {
  commandKey: string;
  expected?: { approvalId: string; bundleFingerprint: string; approvalCreatedAt: number };
}

const hashSchema = z.string().regex(APPROVAL_ID_RE);
const keysSchema = z.array(hashSchema).refine((keys) => new Set(keys).size === keys.length);
const bundleSchema = z.object({
  version: z.literal(2).optional(), identityId: hashSchema.optional(),
  approvalCreatedAt: z.number().finite().nonnegative().optional(),
  id: hashSchema, approvalId: hashSchema, bundleFingerprint: hashSchema,
  workSessionId: z.string().nullable(), projectId: z.string(), cwd: z.string().nullable(),
  taskKey: z.string(), label: z.string(), commandKeys: keysSchema.refine((keys) => keys.length > 0), remainingCommandKeys: keysSchema,
  createdAt: z.number().finite().nonnegative(), expiresAt: z.number().finite(),
}).refine((record) => record.expiresAt > record.createdAt
  && record.remainingCommandKeys.every((key) => record.commandKeys.includes(key))
  && record.bundleFingerprint === localShellBundleFingerprint(record)
  && (record.version === 2
    ? record.identityId === localShellTaskBundleId(record) && record.approvalCreatedAt !== undefined
      && record.approvalCreatedAt <= record.createdAt
      && record.id === localShellTaskBundleRecordId({ ...record, identityId: record.identityId, approvalCreatedAt: record.approvalCreatedAt })
    : record.identityId === undefined && record.approvalCreatedAt === undefined && record.id === localShellTaskBundleId(record)));

function taskBundlesDir(stateDir: string): string {
  return path.join(stateDir, "approvals", "shell", "task-bundles");
}

function taskBundleRecordPath(stateDir: string, id: string): string {
  return path.join(taskBundlesDir(stateDir), `${id}.json`);
}

async function ensureTaskBundlesDir(stateDir: string): Promise<string> {
  const dir = taskBundlesDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => undefined);
  return dir;
}

export function localShellTaskBundleId(input: TaskBundleIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify({
      projectId: input.projectId,
      cwd: input.cwd,
      taskKey: input.taskKey,
      workSessionId: input.workSessionId,
    }))
    .digest("hex");
}

export function localShellBundleFingerprint(input: TaskBundleIdentity & { commandKeys: readonly string[] }): string {
  return createHash("sha256")
    .update(JSON.stringify({
      projectId: input.projectId,
      cwd: input.cwd,
      taskKey: input.taskKey,
      workSessionId: input.workSessionId,
      commandKeys: [...input.commandKeys].sort(),
    }))
    .digest("hex");
}

export async function writeLocalShellTaskBundle(
  stateDir: string,
  record: LocalShellTaskBundleRecord & { version: 2; identityId: string; approvalCreatedAt: number },
): Promise<void> {
  await withTaskBundleLock(stateDir, record.identityId, async () => {
    // An existing generation, including a spent tombstone, is never refilled.
    if (await readTaskBundle(stateDir, record.id)) return;
    await writeTaskBundle(stateDir, record);
  });
}

export function localShellTaskBundleRecordId(input: {
  identityId: string; approvalId: string; bundleFingerprint: string; approvalCreatedAt: number;
}): string {
  return createHash("sha256").update(JSON.stringify({
    identityId: input.identityId, approvalId: input.approvalId,
    bundleFingerprint: input.bundleFingerprint, approvalCreatedAt: input.approvalCreatedAt,
  })).digest("hex");
}

// Lock order: exact record -> task identity. Bundle helpers never take this lock.
export function withLocalShellExactApprovalLock<T>(stateDir: string, id: string, action: () => Promise<T>): Promise<T> {
  return withTaskBundleLock(stateDir, `exact-${id}`, action);
}

async function readTaskBundle(stateDir: string, id: string): Promise<LocalShellTaskBundleRecord | null> {
  try {
    const parsed = bundleSchema.parse(JSON.parse(await fs.readFile(taskBundleRecordPath(stateDir, id), "utf8")));
    if (parsed.id !== id) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid approval bundle file identity");
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid persisted approval bundle");
    }
    throw error;
  }
}

async function withTaskBundleLock<T>(stateDir: string, id: string, action: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(taskBundleRecordPath(stateDir, id));
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = bundleOperations.get(key) ?? Promise.resolve();
  const operation = previous.then(() => withDurableTaskBundleLock(stateDir, id, action));
  // Propagate failures through operation, but let the next caller proceed after
  // acquisition, mutation, and release have all settled (including failures).
  const completed = operation.then(() => undefined, () => undefined);
  bundleOperations.set(key, completed);
  try {
    return await operation;
  } finally {
    if (bundleOperations.get(key) === completed) bundleOperations.delete(key);
  }
}

async function withDurableTaskBundleLock<T>(stateDir: string, id: string, action: () => Promise<T>): Promise<T> {
  const dir = await ensureTaskBundlesDir(stateDir);
  const deadline = Date.now() + 5000;
  const lockedMessage = "Approval bundle is busy; retry the existing request without requesting another approval";
  for (;;) {
    let lock;
    try {
      lock = await acquireMassUlwLock({ path: path.join(dir, `${id}.lock`), now: Date.now, lockedMessage });
    } catch (error) {
      const busy = error instanceof Error && (error.message === lockedMessage || ("code" in error && error.code === "EEXIST"));
      if (!busy || Date.now() >= deadline) throw error;
      await delay(10);
      continue;
    }
    try {
      return await action();
    } finally {
      await lock.release();
    }
  }
}

async function writeTaskBundle(stateDir: string, record: LocalShellTaskBundleRecord): Promise<void> {
  const dir = await ensureTaskBundlesDir(stateDir);
  const target = path.join(dir, `${record.id}.json`);
  const temp = path.join(dir, `.${record.id}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  await fs.chmod(temp, FILE_MODE).catch(() => undefined);
  await fs.rename(temp, target);
}

export async function consumeLocalShellTaskBundle(
  stateDir: string,
  input: ConsumeTaskBundleInput,
): Promise<LocalShellTaskBundleGrant | null> {
  const id = localShellTaskBundleId(input);
  // Keep the record visible while another command waits. Moving it away to
  // claim it made parallel consumers mistake lock contention for no approval.
  return withTaskBundleLock(stateDir, id, async () => {
    const candidates: LocalShellTaskBundleRecord[] = [];
    for (const file of await fs.readdir(taskBundlesDir(stateDir))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const record = await readTaskBundle(stateDir, file.slice(0, -5));
      if (!record || localShellTaskBundleId(record) !== id || record.expiresAt <= Date.now()
        || !record.remainingCommandKeys.includes(input.commandKey)) continue;
      const expected = input.expected;
      if (expected && (record.approvalId !== expected.approvalId
        || record.bundleFingerprint !== expected.bundleFingerprint
        || (record.version === 2 && record.approvalCreatedAt !== expected.approvalCreatedAt))) continue;
      candidates.push(record);
    }
    const record = candidates.sort((a, b) => a.expiresAt - b.expiresAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
    if (!record) return null;
    const commandIndex = record.remainingCommandKeys.indexOf(input.commandKey);
    const remainingCommandKeys = record.remainingCommandKeys.toSpliced(commandIndex, 1);
    await writeTaskBundle(stateDir, { ...record, remainingCommandKeys });
    return {
      approvalId: record.approvalId,
      bundleFingerprint: record.bundleFingerprint,
      workSessionId: record.workSessionId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  });
}
