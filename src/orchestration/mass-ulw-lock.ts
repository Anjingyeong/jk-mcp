import { createHash, randomUUID } from "node:crypto";
import { chmod, link, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const FILE_MODE = 0o600;

const OwnerRecordSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  token: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
}).strict();

const ReclamationRecordSchema = OwnerRecordSchema.extend({
  observed: z.string().min(1),
}).strict();

type OwnerRecord = z.infer<typeof OwnerRecordSchema>;
type ReclamationRecord = z.infer<typeof ReclamationRecordSchema>;
type LockRecord = OwnerRecord | ReclamationRecord;
type LockHandle = { release(): Promise<void> };
type ObservedRecord = {
  readonly fingerprint: string;
  readonly owner: OwnerRecord | null;
};
type Marker = {
  readonly path: string;
  readonly fingerprint: string;
  readonly owner: OwnerRecord | null;
};
type Reclamation = {
  readonly expected: string;
  readonly markers: readonly Marker[];
};
type ReclamationStep = {
  readonly path: string;
  readonly expected: string;
  readonly ancestors: readonly Marker[];
};

export type MassUlwLockOptions = {
  readonly path: string;
  readonly now: () => number;
  readonly lockedMessage: string;
  readonly onAbandonedObserved?: () => void | Promise<void>;
  readonly onReclamationClaimed?: () => void | Promise<void>;
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function fingerprint(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !["ESRCH", "EINVAL"].includes(errorCode(error) ?? "");
  }
}

async function readObserved(path: string): Promise<ObservedRecord | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const digest = fingerprint(contents);
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) return { fingerprint: digest, owner: null };
    throw error;
  }
  const reclamation = ReclamationRecordSchema.safeParse(value);
  if (reclamation.success) {
    return { fingerprint: digest, owner: reclamation.data };
  }
  const parsed = OwnerRecordSchema.safeParse(value);
  return parsed.success
    ? { fingerprint: digest, owner: parsed.data }
    : { fingerprint: digest, owner: null };
}

async function publishComplete(path: string, record: LockRecord): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.creating`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, FILE_MODE);
    await link(temporary, path);
  } finally {
    if (handle !== undefined) await handle.close();
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

async function removeIfCurrent(marker: Marker): Promise<void> {
  const current = await readObserved(marker.path);
  if (current === null || current.fingerprint !== marker.fingerprint) return;
  await unlink(marker.path).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

function markerFrom(path: string, observed: ObservedRecord): Marker {
  return { path, fingerprint: observed.fingerprint, owner: observed.owner };
}

async function acquireReclamation(
  options: MassUlwLockOptions,
  step: ReclamationStep,
): Promise<Reclamation> {
  const { path, expected, ancestors } = step;
  const record: ReclamationRecord = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: options.now(),
    observed: expected,
  };
  try {
    await publishComplete(path, record);
    const current = await readObserved(path);
    if (current === null || current.owner === null) throw new Error(options.lockedMessage);
    return { expected, markers: [...ancestors, markerFrom(path, current)] };
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const existing = await readObserved(path);
  if (existing === null) {
    return acquireReclamation(options, step);
  }
  if (existing.owner !== null && processIsAlive(existing.owner.pid)) {
    throw new Error(options.lockedMessage);
  }
  const marker = markerFrom(path, existing);
  const contents = await readFile(path, "utf8");
  let persistedExpected = expected;
  try {
    const parsed = ReclamationRecordSchema.safeParse(JSON.parse(contents));
    if (parsed.success) persistedExpected = parsed.data.observed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const successor = `${options.path}.reclaim.${existing.fingerprint}`;
  return acquireReclamation(options, {
    path: successor,
    expected: persistedExpected,
    ancestors: [...ancestors, marker],
  });
}

async function createOwner(options: MassUlwLockOptions): Promise<LockHandle> {
  const token = randomUUID();
  await publishComplete(options.path, {
    version: 1,
    pid: process.pid,
    token,
    createdAt: options.now(),
  });
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      const current = await readObserved(options.path);
      if (current?.owner?.token === token) {
        await unlink(options.path).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      }
    },
  };
}

export async function acquireMassUlwLock(options: MassUlwLockOptions): Promise<LockHandle> {
  try {
    return await createOwner(options);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const observed = await readObserved(options.path);
  if (observed === null) return createOwner(options);

  // Portable runtimes expose PID liveness, not a process incarnation. PID reuse
  // therefore remains indistinguishable from the original owner; record age is
  // deliberately not used as a fake incarnation signal.
  if (observed.owner !== null && processIsAlive(observed.owner.pid)) {
    throw new Error(options.lockedMessage);
  }
  await options.onAbandonedObserved?.();

  const root = `${options.path}.reclaim`;
  const reclamation = await acquireReclamation(options, {
    path: root,
    expected: observed.fingerprint,
    ancestors: [],
  });
  await options.onReclamationClaimed?.();
  try {
    const current = await readObserved(options.path);
    if (current === null) return await createOwner(options);
    if (current.fingerprint !== reclamation.expected) throw new Error(options.lockedMessage);
    if (current.owner !== null && processIsAlive(current.owner.pid)) {
      throw new Error(options.lockedMessage);
    }
    await unlink(options.path);
    try {
      return await createOwner(options);
    } catch (error) {
      throw error;
    }
  } finally {
    for (const marker of [...reclamation.markers].reverse()) {
      await removeIfCurrent(marker);
    }
  }
}
