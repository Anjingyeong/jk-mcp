import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyExecutorJobCancellationControl, runExecutorWorker } from "./worker.js";
import { createRuntimeIdentity, EXECUTOR_PROTOCOL_VERSION } from "./target-protocol.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("executor worker lifecycle", () => {
  it("keeps heartbeating while a long poll blocks the main worker loop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jk-executor-worker-heartbeat-"));
    const controller = new AbortController();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
    const hub = await createRuntimeIdentity("hub", root);
    let heartbeatCount = 0;
    let pollPending = false;
    const events = new EventEmitter();
    const pollEntered = once(events, "poll-entered");
    const secondHeartbeat = once(events, "second-heartbeat");
    let worker: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/api/executors/heartbeat")) {
        heartbeatCount += 1;
        if (heartbeatCount === 2) events.emit("second-heartbeat");
        return new Response(JSON.stringify({ ok: true, hub, executor: body }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/poll")) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          signal?.addEventListener("abort", () => {
            pollPending = false;
            reject(signal.reason ?? new Error("aborted"));
          }, { once: true });
          pollPending = true;
          events.emit("poll-entered");
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const timedOut = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Worker heartbeat events timed out")), 4_000);
      });
      worker = runExecutorWorker({
        hubUrl: "https://hub.example.test",
        executorToken: "token",
        executorId: "windows-main",
        workspaceRoot: root,
        heartbeatMs: 3_000,
        pollWaitMs: 25_000,
        signal: controller.signal,
      });
      const workerStopped = worker.then(() => {
        throw new Error("Worker exited before the blocked-poll heartbeat was observed");
      });
      await Promise.race([pollEntered, workerStopped, timedOut]);
      expect(pollPending).toBe(true);
      expect(heartbeatCount).toBe(1);

      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.race([secondHeartbeat, workerStopped, timedOut]);
      expect(heartbeatCount).toBe(2);
      expect(pollPending).toBe(true);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      try {
        await worker;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        events.removeAllListeners();
        vi.useRealTimers();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 6_000);

  it("heartbeat restart interrupts a blocked long poll instead of waiting for poll timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jk-executor-worker-restart-poll-"));
    const controller = new AbortController();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
    const hub = await createRuntimeIdentity("hub", root);
    let heartbeatCount = 0;
    let pollAborted = false;
    const events = new EventEmitter();
    const pollEntered = once(events, "poll-entered");
    let worker: Promise<void> | undefined;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/api/executors/heartbeat")) {
        heartbeatCount += 1;
        return new Response(JSON.stringify({
          ok: true,
          hub,
          executor: body,
          ...(heartbeatCount === 2 ? { control: { restart: { requestId: "00000000-0000-4000-8000-000000000001", reason: "retire blocked poll" } } } : {}),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/poll")) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) { pollAborted = true; reject(signal.reason ?? new Error("aborted")); return; }
          signal?.addEventListener("abort", () => {
            pollAborted = true;
            reject(signal.reason ?? new Error("aborted"));
          }, { once: true });
          events.emit("poll-entered");
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      worker = runExecutorWorker({
        hubUrl: "https://hub.example.test",
        executorToken: "token",
        executorId: "windows-main",
        workspaceRoot: root,
        heartbeatMs: 3_000,
        pollWaitMs: 25_000,
        signal: controller.signal,
      });
      await pollEntered;
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.race([
        worker,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("restart did not interrupt long poll")), 500)),
      ]);
      expect(heartbeatCount).toBe(2);
      expect(pollAborted).toBe(true);
    } finally {
      controller.abort();
      await worker;
      vi.useRealTimers();
      events.removeAllListeners();
      await rm(root, { recursive: true, force: true });
    }
  }, 6_000);

  it("applies cancelJob only to the matching active job", () => {
    const jobId = "00000000-0000-4000-8000-000000000123";
    const controller = new AbortController();
    expect(applyExecutorJobCancellationControl({
      cancelJob: { jobId, reason: "caller timeout" },
    }, jobId, controller)).toBe(jobId);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toEqual(expect.objectContaining({
      message: expect.stringContaining("caller timeout"),
    }));

    const other = new AbortController();
    expect(applyExecutorJobCancellationControl({
      cancelJob: { jobId, reason: "caller timeout" },
    }, "other-job", other)).toBeNull();
    expect(other.signal.aborted).toBe(false);
  });

  it("acknowledges executor_restart and exits so the JK launcher can restart it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jk-executor-worker-"));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
    const hub = await createRuntimeIdentity("hub", root);

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url, body });

      if (url.endsWith("/api/executors/heartbeat")) {
        return new Response(JSON.stringify({ ok: true, hub, executor: body }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/poll")) {
        return new Response(JSON.stringify({
          job: {
            jobId: "restart-1",
            executorId: "windows-main",
            tool: "executor_restart",
            payload: { reason: "reload runtime" },
            createdAt: Date.now(),
            protocolVersion: EXECUTOR_PROTOCOL_VERSION,
            runtime: body.identity,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/jobs/restart-1/result")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      await runExecutorWorker({
        hubUrl: "https://hub.example.test",
        executorToken: "token",
        executorId: "windows-main",
        workspaceRoot: root,
        heartbeatMs: 3_000,
        pollWaitMs: 1_000,
      });

      const heartbeat = requests.find((request) => request.url.endsWith("/api/executors/heartbeat"));
      expect(heartbeat?.body.capabilities).toContain("executor_restart");
      expect(heartbeat?.body.capabilities).toContain("git_sync_start");
      expect(heartbeat?.body.instanceId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(heartbeat?.body.startedAtMs).toEqual(expect.any(Number));

      const result = requests.find((request) => request.url.includes("/jobs/restart-1/result"));
      expect(result?.body).toEqual({ result: { scheduled: true, reason: "reload runtime" }, identity: expect.objectContaining({
        instanceId: heartbeat?.body.instanceId, protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      }) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
