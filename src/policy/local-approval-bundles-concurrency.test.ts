import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as durable from "../orchestration/mass-ulw-lock.js";
import {
  consumeLocalShellTaskBundle, localShellTaskBundleId, localShellTaskBundleRecordId, localShellBundleFingerprint, writeLocalShellTaskBundle,
  type LocalShellTaskBundleRecord,
} from "./local-approval-bundles.js";

const hooks = vi.hoisted(() => ({
  read: undefined as undefined | ((file: string) => Promise<void>),
  unlink: undefined as undefined | ((file: string) => Promise<void>),
}));

// Keep the real durable lock algorithm and disk operations. Inject only the
// Windows delete-pending/open conflict, at its actual filesystem boundary.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      await hooks.read?.(String(args[0]));
      return actual.readFile(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await hooks.unlink?.(String(args[0]));
      return actual.unlink(...args);
    },
  };
});

const commandKey = (command: string) => createHash("sha256").update(JSON.stringify({ command, needsNetwork: false, destructive: true })).digest("hex");
const one = commandKey("one");
const two = commandKey("two");
const roots: string[] = [];
afterEach(async () => {
  hooks.read = undefined;
  hooks.unlink = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(taskKey = "target:fixture-a", root?: string) {
  const stateDir = root ?? await fs.mkdtemp(path.join(os.tmpdir(), "jk-bundle-contention-"));
  if (!root) roots.push(stateDir);
  const identity = { projectId: "proj", cwd: null, workSessionId: "ws_bundle", taskKey };
  const generation = { identityId: localShellTaskBundleId(identity), approvalId: "a".repeat(64),
    bundleFingerprint: localShellBundleFingerprint({ ...identity, commandKeys: [one, two] }), approvalCreatedAt: Date.now() };
  const record = {
    ...identity, ...generation, version: 2 as const, id: localShellTaskBundleRecordId(generation),
    label: "fixture", commandKeys: [one, two], remainingCommandKeys: [one, two],
    createdAt: generation.approvalCreatedAt, expiresAt: generation.approvalCreatedAt + 60000,
  } satisfies LocalShellTaskBundleRecord;
  await writeLocalShellTaskBundle(stateDir, record);
  const directory = path.join(stateDir, "approvals", "shell", "task-bundles");
  return { stateDir, identity, record, directory, lock: path.join(directory, `${record.identityId}.lock`),
    file: path.join(directory, `${record.id}.json`) };
}

describe("same-process task bundle lock serialization", () => {
  it("does not open an owner lock while its same-process deletion is pending", async () => {
    const a = await fixture();
    const b = await fixture("target:fixture-b", a.stateDir);
    const events = new EventEmitter();
    const releaseEntered = once(events, "release.entered", { signal: AbortSignal.timeout(5000) });
    const releaseAllowed = once(events, "release.allowed", { signal: AbortSignal.timeout(5000) });
    let readContended: Promise<unknown[]> | undefined;
    let deleting = false;
    let holdRelease = true;
    let overlappingAttempt = false;
    let conflicts = 0;

    // These fixture directories already exist. Resolve only their idempotent
    // setup operations immediately so caller order reaches the lock boundary
    // deterministically, without depending on filesystem callback ordering.
    const mkdir = fs.mkdir;
    const chmod = fs.chmod;
    vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options) => {
      if (String(directory) === a.directory) return undefined;
      return mkdir(directory, options);
    });
    vi.spyOn(fs, "chmod").mockImplementation(async (file, mode) => {
      if (String(file) !== a.directory) await chmod(file, mode);
    });
    const acquire = durable.acquireMassUlwLock;
    vi.spyOn(durable, "acquireMassUlwLock").mockImplementation(async (options) => {
      if (options.path === a.lock && deleting) {
        overlappingAttempt = true;
        readContended = once(events, "read.contended", { signal: AbortSignal.timeout(5000) });
      }
      // If the old implementation admitted a contender first, keep the
      // independent operation behind its exact read event, not a timer.
      if (options.path === b.lock && overlappingAttempt) await readContended;
      return acquire(options);
    });
    hooks.unlink = async (file) => {
      if (file !== a.lock || !holdRelease) return;
      holdRelease = false;
      deleting = true;
      events.emit("release.entered");
      await releaseAllowed;
      deleting = false;
    };
    hooks.read = async (file) => {
      if (file !== a.lock || !deleting) return;
      conflicts += 1;
      events.emit("read.contended");
      throw Object.assign(new Error("Injected Windows delete-pending lock open"), { code: "EPERM", syscall: "open", path: file });
    };

    const first = consumeLocalShellTaskBundle(a.stateDir, { ...a.identity, commandKey: one });
    await releaseEntered;
    const second = consumeLocalShellTaskBundle(a.stateDir, { ...a.identity, commandKey: two });
    const results = Promise.allSettled([first, second]);
    try {
      const independent = await consumeLocalShellTaskBundle(b.stateDir, { ...b.identity, commandKey: one });
      expect(independent).toMatchObject({ approvalId: b.record.approvalId });
    } finally {
      events.emit("release.allowed");
    }
    expect(await results).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ approvalId: a.record.approvalId }) },
      { status: "fulfilled", value: expect.objectContaining({ approvalId: a.record.approvalId }) },
    ]);
    expect(conflicts).toBe(0);
    expect(overlappingAttempt).toBe(false);
    expect(JSON.parse(await fs.readFile(a.file, "utf8")).remainingCommandKeys).toEqual([]);
    expect(await Promise.all([one, two].map((commandKey) =>
      consumeLocalShellTaskBundle(a.stateDir, { ...a.identity, commandKey })))).toEqual([null, null]);
    expect(JSON.parse(await fs.readFile(b.file, "utf8")).remainingCommandKeys).toEqual([two]);
    await expect(fs.stat(a.lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates an acquisition failure without retrying it or poisoning queued callers", async () => {
    const a = await fixture();
    const failure = Object.assign(new Error("Fixture lock open failure"), { code: "EPERM" });
    const acquire = durable.acquireMassUlwLock;
    const attempts = vi.spyOn(durable, "acquireMassUlwLock")
      .mockRejectedValueOnce(failure).mockImplementation(acquire);
    const outcomes = await Promise.allSettled(Array.from({ length: 2 }, () =>
      consumeLocalShellTaskBundle(a.stateDir, { ...a.identity, commandKey: one })));
    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: expect.objectContaining({ approvalId: a.record.approvalId }) },
    ]);
    expect(attempts).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(a.file, "utf8")).remainingCommandKeys).toEqual([two]);
    await expect(fs.stat(a.lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors a durable owner outside the in-process bundle queue", async () => {
    const a = await fixture();
    const owner = await durable.acquireMassUlwLock({ path: a.lock, now: Date.now, lockedMessage: "fixture-owned" });
    const ownerBytes = await fs.readFile(a.lock, "utf8");
    const events = new EventEmitter();
    const blocked = once(events, "blocked", { signal: AbortSignal.timeout(5000) });
    const acquire = durable.acquireMassUlwLock;
    vi.spyOn(durable, "acquireMassUlwLock").mockImplementation(async (options) => {
      try {
        return await acquire(options);
      } catch (error) {
        events.emit("blocked");
        throw error;
      }
    });
    const consume = consumeLocalShellTaskBundle(a.stateDir, { ...a.identity, commandKey: one });
    try {
      await blocked;
      expect(await fs.readFile(a.lock, "utf8")).toBe(ownerBytes);
      expect(JSON.parse(await fs.readFile(a.file, "utf8")).remainingCommandKeys).toEqual([one, two]);
    } finally {
      await owner.release();
    }
    expect(await consume).toMatchObject({ approvalId: a.record.approvalId });
    expect(await consumeLocalShellTaskBundle(a.stateDir, { ...a.identity, commandKey: one })).toBeNull();
    await expect(fs.stat(a.lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the durable lock and queue after a failed bundle write", async () => {
    const a = await fixture();
    const failure = Object.assign(new Error("Fixture bundle publish failure"), { code: "EIO" });
    const rename = fs.rename;
    const generation = { ...a.record, approvalId: "c".repeat(64) };
    const newRecord = { ...generation, id: localShellTaskBundleRecordId(generation) };
    const newFile = path.join(a.directory, `${newRecord.id}.json`);
    let failWrite = true;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination) === newFile && failWrite) {
        failWrite = false;
        throw failure;
      }
      await rename(source, destination);
    });
    const outcomes = await Promise.allSettled([
      writeLocalShellTaskBundle(a.stateDir, newRecord),
      consumeLocalShellTaskBundle(a.stateDir, { ...a.identity, commandKey: one }),
    ]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: expect.objectContaining({ approvalId: a.record.approvalId }) },
    ]);
    expect(JSON.parse(await fs.readFile(a.file, "utf8")).remainingCommandKeys).toEqual([two]);
    expect(await consumeLocalShellTaskBundle(a.stateDir, { ...a.identity, commandKey: one })).toBeNull();
    await expect(fs.stat(a.lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
