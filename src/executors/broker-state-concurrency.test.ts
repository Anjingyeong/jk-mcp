import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectExecutorRoutes, listExecutorStatus, pollExecutorJob,
  recordExecutorHeartbeat, setProjectExecutorRoute, type ExecutorHeartbeat,
} from "./broker.js";
import { createRuntimeIdentity } from "./target-protocol.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

function gate() {
  const events = new EventEmitter<{ release: [] }>();
  return {
    promise: once(events, "release", { signal: AbortSignal.timeout(5000) }).then(() => undefined),
    release: () => { events.emit("release"); },
  };
}

describe("executor state persistence concurrency", () => {
  let root: string;
  let stateDir: string;
  let otherDir: string;
  let stateFile: string;
  let heartbeat: ExecutorHeartbeat;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "jk-state-concurrency-"));
    stateDir = path.join(root, "hub-state");
    otherDir = path.join(root, "other-state");
    stateFile = path.join(stateDir, "executors.json");
    heartbeat = { ...await createRuntimeIdentity("worker", root, "worker", ["file_create"]),
      platform: "win32/x64", projects: [] };
    await recordExecutorHeartbeat(stateDir, heartbeat);
    await setProjectExecutorRoute(otherDir, "independent", "local");
  });

  afterEach(async () => {
    vi.mocked(readFile).mockReset().mockImplementation(actual.readFile);
    vi.mocked(rename).mockReset().mockImplementation(actual.rename);
    await rm(root, { recursive: true, force: true });
  });

  it("excludes same-directory poll readers from rename while independent directories proceed", async () => {
    const renameEntered = gate();
    const permitRename = gate();
    const permitRead = gate();
    let holdReads = false;
    let readers = 0;
    vi.mocked(readFile).mockImplementation(async (...args) => {
      if (String(args[0]) !== stateFile || !holdReads) return await actual.readFile(...args);
      readers += 1;
      try {
        const body = await actual.readFile(...args);
        await permitRead.promise;
        return body;
      } finally {
        readers -= 1;
      }
    });
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === stateFile) {
        renameEntered.release();
        await permitRename.promise;
        // Deterministically model Windows replacement denial while a reader is open.
        if (readers > 0) throw Object.assign(new Error("EPERM: reader overlaps executor state rename"), { code: "EPERM" });
      }
      await actual.rename(from, to);
    });
    const write = setProjectExecutorRoute(stateDir, "fixture", "worker");
    const written = write.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    await renameEntered.promise;
    holdReads = true;
    const poll = pollExecutorJob("worker", 0, heartbeat, `${stateDir}${path.sep}.`);
    try {
      // The same-dir poll has been requested; an unrelated stateDir must not be locked.
      await expect(getProjectExecutorRoutes(otherDir)).resolves.toEqual({ independent: "local" });
      permitRename.release();
      await expect(written).resolves.toEqual({ ok: true });
    } finally {
      holdReads = false;
      permitRename.release();
      permitRead.release();
      await written;
      await poll;
    }
    await expect(getProjectExecutorRoutes(stateDir)).resolves.toEqual({ fixture: "worker" });
  });
  it.each(["heartbeat", "route"])("keeps both updates when a concurrent %s follows a route transaction", async (kind) => {
    const firstRenameEntered = gate();
    const permitFirstRename = gate();
    const firstCommitted = gate();
    const secondSnapshot = gate();
    let watchSecondRead = false;
    let secondReadStarted = false;
    let renameCount = 0;
    vi.mocked(readFile).mockImplementation(async (...args) => {
      const watched = String(args[0]) === stateFile && watchSecondRead;
      if (watched) secondReadStarted = true;
      const body = await actual.readFile(...args);
      if (watched) secondSnapshot.release();
      return body;
    });
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) !== stateFile) return await actual.rename(from, to);
      renameCount += 1;
      if (renameCount === 1) {
        firstRenameEntered.release();
        await permitFirstRename.promise;
        await actual.rename(from, to);
        firstCommitted.release();
      } else {
        await firstCommitted.promise;
        await actual.rename(from, to);
      }
    });
    const first = setProjectExecutorRoute(stateDir, "fixture", "worker");
    await firstRenameEntered.promise;
    watchSecondRead = true;
    const second = kind === "heartbeat"
      ? recordExecutorHeartbeat(stateDir, { ...heartbeat, label: "updated worker" })
      : setProjectExecutorRoute(stateDir, "second", "local");
    const completed = Promise.all([first, second]);
    try {
      await getProjectExecutorRoutes(otherDir);
      // If a writer was allowed in, force its stale snapshot to precede the first commit.
      // Correct serialization blocks that read until after the first commit instead.
      if (secondReadStarted) await secondSnapshot.promise;
      permitFirstRename.release();
      await completed;
    } finally {
      watchSecondRead = false;
      permitFirstRename.release();
      firstCommitted.release();
      secondSnapshot.release();
      await completed;
    }
    await expect(getProjectExecutorRoutes(stateDir)).resolves.toEqual(
      kind === "route" ? { fixture: "worker", second: "local" } : { fixture: "worker" },
    );
    expect((await listExecutorStatus(stateDir))[0]?.label).toBe(kind === "heartbeat" ? "updated worker" : "worker");
  });

  it("propagates a failed rename without poisoning subsequent state access", async () => {
    // Non-transient code: EPERM/EBUSY/EACCES are now retried (see util/fs-retry).
    const failure = Object.assign(new Error("Fixture rename denied"), { code: "EXDEV" });
    vi.mocked(rename).mockRejectedValueOnce(failure);
    await expect(setProjectExecutorRoute(stateDir, "failed", "worker")).rejects.toBe(failure);
    await setProjectExecutorRoute(stateDir, "surviving", "local");
    await expect(getProjectExecutorRoutes(stateDir)).resolves.toEqual({ surviving: "local" });
    const validState = await actual.readFile(stateFile, "utf8");
    await actual.writeFile(stateFile, "{");
    await expect(getProjectExecutorRoutes(stateDir)).rejects.toMatchObject({ name: "DomainError" });
    await actual.writeFile(stateFile, validState);
    await expect(getProjectExecutorRoutes(stateDir)).resolves.toEqual({ surviving: "local" });
  });

  it("retries a transient Windows sharing violation on rename", async () => {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" }));
    await setProjectExecutorRoute(stateDir, "retried", "worker");
    await expect(getProjectExecutorRoutes(stateDir)).resolves.toEqual({ retried: "worker" });
  });
});
