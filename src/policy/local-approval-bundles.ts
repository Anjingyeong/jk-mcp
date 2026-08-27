import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;

export interface LocalShellTaskBundleRecord {
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
}

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
  record: LocalShellTaskBundleRecord,
): Promise<void> {
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
  if (!APPROVAL_ID_RE.test(id)) return null;
  const source = taskBundleRecordPath(stateDir, id);
  const claimed = path.join(taskBundlesDir(stateDir), `.${id}.${randomUUID()}.consuming`);
  try {
    await fs.rename(source, claimed);
  } catch {
    return null;
  }

  try {
    const record = JSON.parse(await fs.readFile(claimed, "utf8")) as LocalShellTaskBundleRecord;
    const valid = record.id === id
      && APPROVAL_ID_RE.test(record.approvalId)
      && APPROVAL_ID_RE.test(record.bundleFingerprint)
      && record.projectId === input.projectId
      && record.cwd === input.cwd
      && record.taskKey === input.taskKey
      && record.workSessionId === input.workSessionId
      && Number.isFinite(record.expiresAt)
      && record.expiresAt > Date.now()
      && Array.isArray(record.remainingCommandKeys);
    const commandIndex = valid ? record.remainingCommandKeys.indexOf(input.commandKey) : -1;
    if (commandIndex < 0) {
      if (record.expiresAt > Date.now()) await fs.rename(claimed, source);
      else await fs.unlink(claimed);
      return null;
    }

    const remainingCommandKeys = record.remainingCommandKeys.toSpliced(commandIndex, 1);
    await writeLocalShellTaskBundle(stateDir, { ...record, remainingCommandKeys });
    await fs.unlink(claimed);
    return {
      approvalId: record.approvalId,
      bundleFingerprint: record.bundleFingerprint,
      workSessionId: record.workSessionId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  } catch (error) {
    await fs.rename(claimed, source).catch(() => undefined);
    throw error;
  }
}
