import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineHashes, rangeHash } from "../util/hash.js";
import { runExecutorWorker } from "./worker.js";
import {
  createRuntimeIdentity, deriveRemoteExecutionTarget, EXECUTOR_PROTOCOL_VERSION,
  RuntimeIdentitySchema, type ExecutionTarget,
} from "./target-protocol.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jk-native-evolution-R3-worker-"));
  vi.stubEnv("JK_RUNTIME_MODE", "packaged");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("real worker same-buffer read", () => {
  it.each([
    { name: "redacted partial CRLF", bytes: Buffer.from("before\r\npassword=abcdefgh1234\r\nafter\r\n"),
      start: 2, end: 2, content: "2\tpassword=[REDACTED]", range: "password=abcdefgh1234",
      hashes: lineHashes("password=abcdefgh1234"), eol: "crlf" },
    { name: "empty file", bytes: Buffer.alloc(0), start: 1, end: 1,
      content: "1\t", range: "", hashes: lineHashes(""), eol: "lf" },
    { name: "out-of-range CRLF", bytes: Buffer.from("before\r\n"), start: 9, end: 10,
      content: "", range: "", hashes: [], eol: "crlf" },
  ])("native-evolution R3 returns same-read worker tokens across a controlled edit: $name", async (fixture) => {
    await fs.mkdir(path.join(root, "fixture"));
    await fs.writeFile(path.join(root, "fixture", "package.json"), "{}");
    const abs = path.join(await fs.realpath(root), "fixture", "source.txt");
    const replacement = Buffer.from("changed-on-disk\n");
    await fs.writeFile(abs, fixture.bytes);
    const originalReadFile = fs.readFile.bind(fs);
    let reads = 0;
    // Keep real I/O and change only this owned file after its first read settles.
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const bytes = await originalReadFile(...args);
      if (args[0] === abs) {
        reads += 1;
        if (reads === 1) await fs.writeFile(abs, replacement);
      }
      return bytes;
    });

    const hub = await createRuntimeIdentity("hub", root);
    const token = randomUUID();
    const jobId = randomUUID();
    const executorId = "r3-worker";
    const controller = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("R3 worker result deadline")), 10_000);
    const events = new EventEmitter();
    const app = express();
    const server = createServer(app);
    let worker: Promise<void> | undefined;
    let target: ExecutionTarget | undefined;
    let dispatched = false;
    app.use(express.json());
    app.use((req, res, next) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.sendStatus(401);
        return;
      }
      next();
    });
    app.post("/api/executors/heartbeat", (req, res) => {
      const identity = RuntimeIdentitySchema.parse(req.body);
      const { projects } = z.object({ projects: z.array(z.object({
        projectId: z.string(), name: z.string(), root: z.string(), aliases: z.array(z.string()),
      })) }).parse(req.body);
      const project = projects.find((candidate) => candidate.projectId === "fixture");
      if (!project) throw new Error("Worker did not advertise the owned fixture");
      target = deriveRemoteExecutionTarget(identity, project);
      res.json({ ok: true, hub, executor: identity });
    });
    app.post(`/api/executors/${executorId}/poll`, (req, res) => {
      if (dispatched) return; // Hold any subsequent poll until worker cancellation.
      if (!target) throw new Error("Expected heartbeat before job dispatch");
      dispatched = true;
      res.json({ job: {
        jobId, executorId, tool: "file_read_slice", createdAt: Date.now(),
        protocolVersion: EXECUTOR_PROTOCOL_VERSION,
        runtime: RuntimeIdentitySchema.parse(req.body.identity), executionTarget: target,
        payload: { sourceProjectId: "fixture", path: "source.txt", start: fixture.start, end: fixture.end },
      } });
    });
    app.post(`/api/executors/${executorId}/jobs/${jobId}/result`, (req, res) => {
      res.json({ ok: true });
      events.emit("result", req.body);
    });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      events.emit("error", error);
      res.sendStatus(500);
    });

    try {
      const listening = once(server, "listening", { signal: deadline.signal });
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback TCP address");
      const resultReceived = once(events, "result", { signal: deadline.signal });
      worker = runExecutorWorker({ hubUrl: `http://127.0.0.1:${address.port}`, executorToken: token,
        executorId, workspaceRoot: root, signal: controller.signal });
      const [receipt] = await Promise.race([resultReceived, worker.then(() => {
        throw new Error("Worker stopped before delivering the requested result");
      })]);

      expect(receipt).not.toHaveProperty("error");
      expect(receipt).toMatchObject({ result: { content: fixture.content, eol: fixture.eol,
        fileHash: rangeHash(fixture.range), lineHashes: fixture.hashes } });
      expect(await originalReadFile(abs)).toEqual(replacement);
      const expectedHash = createHash("sha256").update(fixture.bytes).digest("hex");
      expect(receipt).toMatchObject({ result: { workContextFileHash: expectedHash, fullFileHash: expectedHash } });
      expect(reads).toBe(1);
    } finally {
      controller.abort();
      try {
        await worker;
      } finally {
        try {
          events.removeAllListeners();
          if (server.listening) {
            const closed = once(server, "close", { signal: deadline.signal });
            server.close();
            server.closeAllConnections();
            await closed;
          }
        } finally {
          clearTimeout(timer);
          deadline.abort();
        }
      }
    }
  });
});
