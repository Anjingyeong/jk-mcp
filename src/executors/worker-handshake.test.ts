import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExecutorWorker } from "./worker.js";
import { createRuntimeIdentity, deriveRemoteExecutionTarget, EXECUTOR_PROTOCOL_VERSION, type RuntimeIdentity } from "./target-protocol.js";
import type { ExecutorHeartbeat } from "./broker.js";

function eventSignal() {
  const events = new EventEmitter<{ observed: [] }>();
  const promise = once(events, "observed", { signal: AbortSignal.timeout(5000) }).then(() => undefined);
  return { promise, emit: () => { events.emit("observed"); } };
}

describe("worker fail-closed startup and execution", () => {
  let root: string;
  let hub: RuntimeIdentity;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "jk-worker-handshake-"));
    await mkdir(path.join(root, "fixture"));
    await writeFile(path.join(root, "fixture", "package.json"), "{}");
    hub = { ...await createRuntimeIdentity("hub", root), os: "darwin", arch: "arm64" };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  const options = () => ({ hubUrl: "http://127.0.0.1:1", executorToken: "fixture-token", executorId: "worker" });
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  it.each(["missing", "missing-protocol", "version", "role", "capability", "acknowledgement"])("never readies or polls a bad %s handshake", async (failure) => {
    const statuses = vi.fn();
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push(String(input));
      const worker = JSON.parse(String(init?.body));
      return json({ ok: true, executor: failure === "acknowledgement" ? { ...worker, instanceId: "other" } : worker,
        hub: failure === "missing" ? undefined : { ...hub,
          ...(failure === "version" ? { protocolVersion: 2 } : {}),
          ...(failure === "missing-protocol" ? { protocolVersion: undefined } : {}),
          ...(failure === "role" ? { role: "worker" } : {}),
          ...(failure === "capability" ? { capabilities: [] } : {}),
        } });
    });
    await expect(runExecutorWorker({ ...options(), workspaceRoot: root, onStatus: statuses })).rejects.toBeInstanceOf(Error);
    expect(requests).toEqual(["http://127.0.0.1:1/api/executors/heartbeat"]);
    expect(statuses).not.toHaveBeenCalled();
  });

  it.each(["missing", "file"])("validates a %s workspace before network access", async (kind) => {
    globalThis.fetch = vi.fn();
    const workspaceRoot = kind === "missing" ? path.join(root, "absent") : path.join(root, "fixture", "package.json");
    await expect(runExecutorWorker({ ...options(), workspaceRoot })).rejects.toBeInstanceOf(Error);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["instance", "protocol", "target", "root", "canonical-id", "registry"])("refuses a job with changed or missing %s before file execution", async (change) => {
    let advertised: ExecutorHeartbeat | undefined;
    let result: Record<string, unknown> | undefined;
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/heartbeat")) {
        advertised = body;
        return json({ ok: true, hub, executor: body });
      }
      if (url.endsWith("/poll")) {
        if (!advertised) throw new Error("Expected a heartbeat before polling");
        const project = advertised.projects.find((candidate) => candidate.projectId === "fixture");
        if (!project) throw new Error("Expected the advertised fixture project");
        const target = deriveRemoteExecutionTarget(advertised, project);
        if (change === "registry") await rm(path.join(root, "fixture", "package.json"));
        return json({ job: {
          jobId: "guarded", executorId: "worker", tool: "file_create", createdAt: Date.now(),
          protocolVersion: change === "protocol" ? undefined : EXECUTOR_PROTOCOL_VERSION,
          runtime: { ...advertised, ...(change === "instance" ? { instanceId: "old" } : {}) },
          executionTarget: change === "target" ? undefined : { ...target, ...(change === "root" ? { projectRoot: root } : {}) },
          payload: { sourceProjectId: change === "canonical-id" ? "not-canonical" : "fixture", path: "blocked.txt", content: "bad" },
        } });
      }
      result = body;
      controller.abort();
      return json({ ok: true });
    });
    await runExecutorWorker({ ...options(), workspaceRoot: root, signal: controller.signal });
    expect(result?.error).toEqual(expect.any(String));
    expect(result?.result).toBeNull();
    await expect(readFile(path.join(root, "fixture", "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("exits without further polling when a validated heartbeat identifies a restarted hub", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let heartbeatCount = 0;
    let pollCount = 0;
    const retryScheduled = eventSignal();
    const retried = retryScheduled.promise.then(() => "retry");
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const timer = schedule(callback, delay, ...args);
      if (delay === 1000) retryScheduled.emit();
      return timer;
    });
    globalThis.fetch = vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith("/heartbeat")) {
        heartbeatCount += 1;
        return json({ ok: true, executor: body,
          hub: heartbeatCount === 1 ? hub : { ...hub, instanceId: "restarted-hub" } });
      }
      pollCount += 1;
      vi.setSystemTime(Date.now() + 3000);
      return json({ job: null });
    });
    const worker = runExecutorWorker({ ...options(), workspaceRoot: root, heartbeatMs: 3000, signal: controller.signal });
    try {
      expect(await Promise.race([worker.then(() => "exit"), retried])).toBe("exit");
      expect(heartbeatCount).toBe(2);
      expect(pollCount).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      await worker;
    }
  });

  it("retries a transient heartbeat failure and continues under the same validated hub identity", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let heartbeatCount = 0;
    let pollCount = 0;
    let resultCount = 0;
    const retryScheduled = eventSignal();
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const timer = schedule(callback, delay, ...args);
      if (delay === 1000) retryScheduled.emit();
      return timer;
    });
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/heartbeat")) {
        heartbeatCount += 1;
        if (heartbeatCount === 2) throw new TypeError("Fixture connection reset");
        return json({ ok: true, hub, executor: body });
      }
      if (url.endsWith("/poll")) {
        pollCount += 1;
        if (pollCount === 1) {
          vi.setSystemTime(Date.now() + 3000);
          return json({ job: null });
        }
        return json({ job: { jobId: "done", executorId: "worker", tool: "executor_restart", payload: {},
          createdAt: Date.now(), protocolVersion: EXECUTOR_PROTOCOL_VERSION, runtime: body.identity } });
      }
      resultCount += 1;
      return json({ ok: true });
    });
    const worker = runExecutorWorker({ ...options(), workspaceRoot: root, heartbeatMs: 3000, signal: controller.signal });
    try {
      await retryScheduled.promise;
      expect(heartbeatCount).toBe(2);
      expect(pollCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await worker;
      expect(heartbeatCount).toBe(3);
      expect(pollCount).toBe(2);
      expect(resultCount).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      await worker;
    }
  });

  it("aborts a stalled startup heartbeat at its bounded request deadline", async () => {
    vi.useFakeTimers();
    const requestStarted = eventSignal();
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal;
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      requestStarted.emit();
    }));
    const worker = runExecutorWorker({ ...options(), workspaceRoot: root });
    const rejected = expect(worker).rejects.toThrow("Executor request timed out");
    await requestStarted.promise;
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
