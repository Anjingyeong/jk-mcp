import { createServer as createNodeServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { issueExecutorToken } from "../executors/auth.js";
import { createHttpServer, defaultHttpServerConfig } from "./http.js";

describe("executor result JSON body limits", () => {
  let server: Server | undefined;
  let closeRuntime: (() => void) | undefined;
  let root: string | undefined;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((err) => err ? reject(err) : resolve()));
    }
    closeRuntime?.();
    if (root) await rm(root, { recursive: true, force: true });
    server = undefined;
    root = undefined;
    closeRuntime = undefined;
  });

  it("accepts 145 KB authenticated worker results, but preserves the default limit elsewhere", async () => {
    root = await mkdtemp(path.join(tmpdir(), "jk-executor-result-limit-"));
    const stateDir = path.join(root, ".state");
    const token = await issueExecutorToken(stateDir, "worker");
    const ctx = {
      workspaceRoot: root,
      stateDir,
      registry: [],
      ledger: { append: async () => undefined },
      store: { loadProjects: async () => [], saveProjects: async () => undefined,
        getSession: async () => null, setSession: async () => undefined },
      config: { workspaceRoot: root, stateDir, maxReadBytes: 10000,
        maxPatchBytes: 10000, defaultCommandTimeoutSec: 10, defaultLeaseTtlMs: 10000 },
    } as unknown as ToolContext;

    const probe = createNodeServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));

    const runtime = createHttpServer(ctx, defaultHttpServerConfig({
      host: "127.0.0.1", port, publicUrl: `http://127.0.0.1:${port}`,
      managementRoutesEnabled: false,
    }));
    closeRuntime = runtime.close;
    server = runtime.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${port}`;

    const post = (route: string, body: unknown, bearer = token) =>
      fetch(baseUrl + route, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
      });
    const large = { result: { dirtyFiles: Array.from({ length: 1945 }, (_, i) => `assets/screenshot_${i}_${"x".repeat(65)}.png`) } };
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(100 * 1024);

    // A missing job returns 404 only if authentication AND body parsing succeeded.
    const accepted = await post("/api/executors/worker/jobs/missing/result", large);
    expect(accepted.status).toBe(404);

    // Unauthorized large payloads are rejected before the 1 MB parser runs.
    const unauthorized = await post("/api/executors/worker/jobs/missing/result", large, "invalid-token");
    expect(unauthorized.status).toBe(401);

    // No global increase: regular JSON API requests over 100 KB remain rejected.
    const ordinary = await post("/api/executors/heartbeat", large);
    expect(ordinary.status).toBe(413);

    // The special executor endpoint still rejects oversized submissions.
    const oversized = await post("/api/executors/worker/jobs/missing/result", { result: { data: "x".repeat(1_100_000) } });
    expect(oversized.status).toBe(413);

    // Host allowlist remains enforced by the SDK's sub-application.
    const invalidHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(baseUrl + "/healthz", { headers: { Host: "untrusted.example" } }, res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(invalidHostStatus).toBe(403);
    const invalidHostLargeBodyStatus = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify(large);
      const req = httpRequest(baseUrl + "/api/executors/worker/jobs/missing/result", {
        method: "POST",
        headers: {
          Host: "untrusted.example",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end(body);
    });
    expect(invalidHostLargeBodyStatus).toBe(403);
  });
});
