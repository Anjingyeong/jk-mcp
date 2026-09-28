import express from "express";
import { z } from "zod";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { ToolContext } from "../types.js";
import { storeOwnerToken } from "../auth/owner-token.js";
import { issueExecutorToken } from "./auth.js";
import { dispatchExecutorJob, getExecutorProjectRegistry } from "./broker.js";
import { registerExecutorRoutes } from "./http.js";
import { runExecutorWorker } from "./worker.js";
import { createRuntimeIdentity, EXECUTOR_PROTOCOL_VERSION, ExecutorHandshakeSchema, RuntimeIdentitySchema } from "./target-protocol.js";

describe("executor HTTP protocol integration", () => {
  let root: string;
  let stateDir: string;
  let server: Server;
  let hubUrl: string;
  let token: string;
  const owner = "isolated-test-owner-token-12345";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "jk-executor-http-"));
    stateDir = path.join(root, ".state");
    await mkdir(path.join(root, "fixture"));
    await writeFile(path.join(root, "fixture", "package.json"), "{}");
    await writeFile(path.join(root, "fixture", "hello.txt"), "worker-bound-content\n");
    await mkdir(path.join(root, "fixture", ".jk", "images"), { recursive: true });
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(path.join(root, "fixture", ".jk", "images", "pixel.png"), Buffer.concat([tinyPng, Buffer.alloc(160_000)]));
    token = await issueExecutorToken(stateDir, "worker");
    await storeOwnerToken(stateDir, owner);
    const ctx: ToolContext = {
      workspaceRoot: root, stateDir, registry: [], ledger: { append: async () => {} },
      store: { loadProjects: async () => [], saveProjects: async () => {}, getSession: async () => null, setSession: async () => {} },
      config: { workspaceRoot: root, stateDir, maxReadBytes: 10000, maxPatchBytes: 10000,
        defaultCommandTimeoutSec: 10, defaultLeaseTtlMs: 10000 },
    };
    const app = express();
    app.use(express.json());
    registerExecutorRoutes(app, ctx);
    server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback server did not bind");
    hubUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });

  function post(route: string, body: unknown, bearer = token) {
    return fetch(`${hubUrl}${route}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }

  it("authenticates mixed-OS handshakes and exposes both runtime identities in owner status", async () => {
    const worker = { ...await createRuntimeIdentity("worker", root, "worker", ["file_read_slice"]), os: "darwin", arch: "arm64",
      platform: "darwin/arm64", projects: [] };
    expect((await post("/api/executors/heartbeat", worker, "wrong-token")).status).toBe(401);
    expect((await post("/api/executors/heartbeat", { ...worker, protocolVersion: undefined })).status).toBe(400);
    expect((await post("/api/executors/heartbeat", { ...worker, protocolVersion: 2 })).status).toBe(400);
    const response = await post("/api/executors/heartbeat", worker);
    expect(response.status).toBe(200);
    const handshake = ExecutorHandshakeSchema.parse(await response.json());
    expect(handshake.executor.os).toBe("darwin");
    expect(handshake.hub.os).toBe(process.platform);
    expect(handshake.hub.role).toBe("hub");
    const status = await fetch(`${hubUrl}/api/executors`, { headers: { authorization: `Bearer ${owner}` }, signal: AbortSignal.timeout(5000) });
    const body = z.object({ hub: RuntimeIdentitySchema, executors: z.array(
      RuntimeIdentitySchema.extend({ online: z.boolean(), compatible: z.boolean() }),
    ) }).parse(await status.json());
    expect(RuntimeIdentitySchema.parse(body.hub)).toEqual(handshake.hub);
    expect(body.executors[0]).toMatchObject({ instanceId: worker.instanceId, workspaceRoot: worker.workspaceRoot,
      protocolVersion: EXECUTOR_PROTOCOL_VERSION, online: true, compatible: true });
    expect((await post("/api/executors/worker/poll", { waitMs: 0 })).status).toBe(400);
    expect((await post("/api/executors/worker/poll", { waitMs: 0, identity: { ...worker, instanceId: "stale" } })).status).toBe(400);
    expect((await post("/api/executors/worker/poll", { waitMs: 0, identity: worker })).status).toBe(200);
  });

  it("runs the real worker through authenticated handshake, bound read, result and restart", async () => {
    const events = new EventEmitter();
    const ready = once(events, "ready", { signal: AbortSignal.timeout(5000) });
    const controller = new AbortController();
    const worker = runExecutorWorker({ hubUrl, executorId: "worker", executorToken: token, workspaceRoot: root,
      signal: controller.signal, heartbeatMs: 3000, pollWaitMs: 1000, onStatus: () => events.emit("ready") });
    try {
      await ready;
      const entry = (await getExecutorProjectRegistry(stateDir, [])).find((project) => project.projectId === "fixture");
      if (!entry) throw new Error("Expected the worker's advertised fixture project");
      expect(entry.executionTarget).toMatchObject({ kind: "remote", executorId: "worker", sourceProjectId: "fixture" });
      const result = await dispatchExecutorJob<{ content: string }>(stateDir, "worker", "file_read_slice", {
        sourceProjectId: entry.sourceProjectId, executionTarget: entry.executionTarget, path: "hello.txt", start: 1, end: 1,
      }, 5000);
      expect(result.content).toBe("1\tworker-bound-content");
      const listed = await dispatchExecutorJob<{ images: Array<{ filePath: string; mime: string }> }>(
        stateDir, "worker", "list_images", { sourceProjectId: entry.sourceProjectId, executionTarget: entry.executionTarget }, 5000);
      expect(listed.images).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: path.join(".jk", "images", "pixel.png"), mime: "image/png" })]));
      const retrieved = await dispatchExecutorJob<{ filePath: string; mime: string; data: string }>(
        stateDir, "worker", "retrieve_image", { sourceProjectId: entry.sourceProjectId, executionTarget: entry.executionTarget, filePath: path.join(".jk", "images", "pixel.png") }, 5000);
      expect(retrieved).toMatchObject({ filePath: path.join(".jk", "images", "pixel.png"), mime: "image/png" });
      expect(retrieved.data).toMatch(/^data:image\/png;base64,/);
      await expect(dispatchExecutorJob(stateDir, "worker", "executor_restart", { reason: "fixture done" }, 5000))
        .resolves.toMatchObject({ scheduled: true, reason: "fixture done", via: "heartbeat-control" });
      await worker;
    } finally {
      controller.abort();
      await worker;
    }
  }, 10000);
});
