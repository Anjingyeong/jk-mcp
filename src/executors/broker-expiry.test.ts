import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../types.js";
import {
  acknowledgeExecutorJobCancellation,
  completeExecutorJob as brokerComplete,
  dispatchExecutorJob as brokerDispatch,
  pollExecutorJob as brokerPoll,
  recordExecutorHeartbeat,
  takeExecutorControl,
} from "./broker.js";
import { EXECUTOR_CONTROL_CAPABILITY, EXECUTOR_PROTOCOL_VERSION, TARGET_CAPABILITY, type RuntimeIdentity } from "./target-protocol.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

describe("executor job expiry", () => {
  let stateDir: string;

  function identity(executorId = "expiry-worker"): RuntimeIdentity {
    return { role: "worker", protocolVersion: EXECUTOR_PROTOCOL_VERSION, executorId,
      instanceId: `${executorId}-instance`, workspaceRoot: stateDir, os: "win32", arch: "x64",
      capabilities: [TARGET_CAPABILITY, EXECUTOR_CONTROL_CAPABILITY, "file_create"] };
  }

  function pollExecutorJob(executorId: string, waitMs: number) {
    return brokerPoll(executorId, waitMs, identity(executorId), stateDir);
  }

  function completeExecutorJob(jobId: string, result: unknown, error?: string, executorId = "expiry-worker") {
    return brokerComplete(jobId, result, error, executorId, identity(executorId));
  }

  function dispatchExecutorJob(dir: string, executorId: string, tool: "file_create", payload: Record<string, unknown>, timeoutMs: number) {
    return brokerDispatch(dir, executorId, tool, { ...payload, sourceProjectId: "fixture" }, timeoutMs);
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "jk-executor-expiry-"));
    vi.useFakeTimers();
    await recordExecutorHeartbeat(stateDir, {
      ...identity(),
      executorId: "expiry-worker",
      platform: "win32/x64",
      workspaceRoot: stateDir,
      projects: [{ projectId: "fixture", name: "fixture", root: stateDir, aliases: [] }],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(stateDir, { recursive: true, force: true });
  });

  function observeEnqueue(): Promise<void> {
    const schedule = globalThis.setTimeout;
    return new Promise<void>((resolve) => {
      const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce((callback, delay, ...args) => {
        const timer = schedule(callback, delay, ...args);
        timerSpy.mockRestore();
        // Timer registration, pending.set and enqueue share one synchronous turn.
        // The awaiting continuation therefore runs only after the job is queued.
        resolve();
        return timer;
      });
    });
  }

  async function enqueue(filePath: string, timeoutMs = 10_000, executorId = "expiry-worker") {
    const enqueued = observeEnqueue();
    const result = dispatchExecutorJob(stateDir, executorId, "file_create", { path: filePath }, timeoutMs);
    await enqueued;
    return { result };
  }

  it("does not deliver an undelivered job after its caller times out", async () => {
    // Given: subscribe before dispatch's asynchronous heartbeat read completes.
    const enqueued = observeEnqueue();
    const result = dispatchExecutorJob(stateDir, "expiry-worker", "file_create", { path: "expired.txt" }, 1_000);
    const rejected = expect(result).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
    await enqueued;

    // When: the caller's exact deadline passes before any worker polls.
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    // Then: a later worker must not receive the timed-out mutation.
    await expect(pollExecutorJob("expiry-worker", 0)).resolves.toBeNull();
  }, 5_000);

  it("preserves live FIFO and executor isolation when a middle job expires", async () => {
    // Given: live jobs surround an expiring job, with another executor queued.
    await recordExecutorHeartbeat(stateDir, {
      ...identity("other-worker"),
      executorId: "other-worker",
      platform: "win32/x64",
      workspaceRoot: stateDir,
      projects: [{ projectId: "fixture", name: "fixture", root: stateDir, aliases: [] }],
    });
    const first = await enqueue("first.txt");
    const expired = await enqueue("expired.txt", 1_000);
    const rejected = expect(expired.result).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
    const last = await enqueue("last.txt");
    const other = await enqueue("other.txt", 10_000, "other-worker");

    // When: only the middle job reaches its deadline.
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    // Then: each executor receives only its own live jobs in dispatch order.
    for (const [executorId, filePath, dispatched] of [
      ["expiry-worker", "first.txt", first],
      ["expiry-worker", "last.txt", last],
      ["other-worker", "other.txt", other],
    ] as const) {
      const job = await pollExecutorJob(executorId, 0);
      expect(job?.payload).toEqual({ path: filePath, sourceProjectId: "fixture" });
      expect(job?.executorId).toBe(executorId);
      if (!job) throw new Error("Expected a live executor job");
      expect(completeExecutorJob(job.jobId, filePath, undefined, executorId)).toBe(true);
      await expect(dispatched.result).resolves.toBe(filePath);
    }
    await expect(pollExecutorJob("expiry-worker", 0)).resolves.toBeNull();
    await expect(pollExecutorJob("other-worker", 0)).resolves.toBeNull();
  }, 5_000);

  it("skips an obsolete queue entry and delivers the next live job", async () => {
    // Given: a known job is completed before delivery, leaving an obsolete entry.
    const obsoleteId = "00000000-0000-4000-8000-000000000001";
    vi.mocked(randomUUID).mockReturnValueOnce(obsoleteId);
    const obsolete = await enqueue("obsolete.txt");
    const live = await enqueue("live.txt");
    expect(completeExecutorJob(obsoleteId, "already completed")).toBe(true);
    await expect(obsolete.result).resolves.toBe("already completed");

    // When: a worker polls a queue whose head is no longer pending.
    const job = await pollExecutorJob("expiry-worker", 0);

    // Then: polling skips that head instead of delivering it or hiding live work.
    expect(job?.payload).toEqual({ path: "live.txt", sourceProjectId: "fixture" });
    if (!job) throw new Error("Expected the live executor job");
    expect(completeExecutorJob(job.jobId, "completed")).toBe(true);
    await expect(live.result).resolves.toBe("completed");
    await expect(pollExecutorJob("expiry-worker", 0)).resolves.toBeNull();
  }, 5_000);

  it("delivers to an immediate waiter and clears the completed job's timeout", async () => {
    // Given: the worker has registered a waiter before dispatch starts.
    const registered = observeEnqueue();
    const waiting = pollExecutorJob("expiry-worker", 5_000);
    await registered;
    const result = dispatchExecutorJob(stateDir, "expiry-worker", "file_create", { path: "live.txt" }, 1_000);

    // When: the waiting worker completes the delivered job.
    const job = await waiting;
    expect(job?.payload).toEqual({ path: "live.txt", sourceProjectId: "fixture" });
    if (!job) throw new Error("Expected immediate waiter delivery");
    expect(completeExecutorJob(job.jobId, "completed", undefined, "expiry-worker")).toBe(true);

    // Then: completion wins, and neither its timer nor a duplicate delivery remains.
    await expect(result).resolves.toBe("completed");
    expect(vi.getTimerCount()).toBe(0);
    await expect(pollExecutorJob("expiry-worker", 0)).resolves.toBeNull();
  }, 5_000);

  it("rejects late completion without redelivering an already delivered expired job", async () => {
    // Given: delivery has occurred, but the worker has not completed the job.
    const registered = observeEnqueue();
    const waiting = pollExecutorJob("expiry-worker", 5_000);
    await registered;
    const result = dispatchExecutorJob(stateDir, "expiry-worker", "file_create", { path: "running.txt" }, 1_000);
    const rejected = expect(result).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
    const job = await waiting;
    if (!job) throw new Error("Expected immediate waiter delivery");

    // When: the caller times out after delivery.
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    // Then: the broker exposes cancellation to the already-running worker and
    // still rejects a late result without redelivering the expired job.
    const control = await takeExecutorControl(stateDir, "expiry-worker", identity());
    expect(control?.cancelJob).toMatchObject({
      jobId: job.jobId,
      reason: expect.stringContaining("timed out"),
    });
    expect(acknowledgeExecutorJobCancellation(stateDir, "expiry-worker", identity(), job.jobId)).toBe(true);
    await expect(takeExecutorControl(stateDir, "expiry-worker", identity())).resolves.toBeUndefined();
    expect(completeExecutorJob(job.jobId, "late", undefined, "expiry-worker")).toBe(false);
    await expect(pollExecutorJob("expiry-worker", 0)).resolves.toBeNull();
  }, 5_000);

  it("does not emit worker cancellation when a queued job expires before delivery", async () => {
    const enqueued = observeEnqueue();
    const result = dispatchExecutorJob(stateDir, "expiry-worker", "file_create", { path: "queued.txt" }, 1_000);
    const rejected = expect(result).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
    await enqueued;

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    await expect(takeExecutorControl(stateDir, "expiry-worker", identity())).resolves.toBeUndefined();
    await expect(pollExecutorJob("expiry-worker", 0)).resolves.toBeNull();
  }, 5_000);
});
