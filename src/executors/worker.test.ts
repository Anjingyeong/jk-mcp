import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExecutorWorker } from "./worker.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("executor worker lifecycle", () => {
  it("acknowledges executor_restart and exits so the JK launcher can restart it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jk-executor-worker-"));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url, body });

      if (url.endsWith("/api/executors/heartbeat")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/poll")) {
        return new Response(JSON.stringify({
          job: {
            jobId: "restart-1",
            executorId: "windows-main",
            tool: "executor_restart",
            payload: { reason: "reload runtime" },
            createdAt: Date.now(),
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

      const result = requests.find((request) => request.url.includes("/jobs/restart-1/result"));
      expect(result?.body).toEqual({ result: { scheduled: true, reason: "reload runtime" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
