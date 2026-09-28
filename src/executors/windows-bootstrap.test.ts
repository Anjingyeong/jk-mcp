import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WINDOWS_EXECUTOR_BOOTSTRAP_JS } from "./windows-bootstrap.js";
import { RuntimeIdentitySchema, deriveRemoteExecutionTarget, type ExecutionTarget, type RuntimeIdentity } from "./target-protocol.js";

function deferred<T>() {
  let handlers: { resolve: (value: T) => void; reject: (error: unknown) => void } | undefined;
  const promise = new Promise<T>((resolve, reject) => { handlers = { resolve, reject }; });
  if (!handlers) throw new Error("Promise executor did not initialize");
  return { promise, ...handlers };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("bootstrap event timed out")), 8_000);
    })]);
  } finally { clearTimeout(timer); }
}

function handshake(identity: RuntimeIdentity) {
  return { ok: true, executor: identity, hub: {
    role: "hub", protocolVersion: 1, executorId: "local", instanceId: "hub-instance",
    workspaceRoot: "/srv/jk", os: process.platform === "win32" ? "linux" : "win32",
    arch: "arm64", capabilities: ["execution-target-v1"],
  } };
}

const markerCommand = `"${process.execPath}" -e "require('node:fs').writeFileSync('marker.txt','executed')"`;

interface ValidJob {
  jobId: string;
  executorId: string;
  protocolVersion: 1;
  runtime: RuntimeIdentity;
  executionTarget: ExecutionTarget;
  tool: "local_shell_run";
  payload: { sourceProjectId: string; command: string };
  createdAt: number;
}

const CompletionSchema = z.object({
  identity: RuntimeIdentitySchema,
  result: z.record(z.unknown()).nullable(),
  error: z.string().optional(),
});

// Only the heartbeat interval is controlled. HTTP, filesystem and job execution remain real.
const CONTROLLED_HEARTBEAT_JS = String.raw`
let heartbeatTick;
global.setInterval = (callback, ms) => {
  if (ms !== 8000) throw new Error("Unexpected controlled interval");
  heartbeatTick = callback;
  return { unref() {} };
};
process.on("message", async (message) => {
  if (message === "heartbeat") {
    await heartbeatTick();
    process.send("heartbeat-done");
  }
});
`;

describe("standalone Windows executor bootstrap", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fixture(options: {
    handshake?: (identity: RuntimeIdentity, count: number) => unknown;
    heartbeatStatus?: (count: number) => number;
    controlledHeartbeat?: boolean;
    job?: (job: ValidJob, root: string) => unknown | Promise<unknown>;
    workspace?: (root: string) => string;
    prepare?: (root: string) => Promise<void>;
  } = {}) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "jk-bootstrap-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "project-alias" }));
    const workerFile = path.join(root, "worker.cjs"), tokenFile = path.join(root, "token.txt");
    await writeFile(workerFile, (options.controlledHeartbeat ? CONTROLLED_HEARTBEAT_JS : "") + WINDOWS_EXECUTOR_BOOTSTRAP_JS);
    await writeFile(tokenFile, "test-token");
    await options.prepare?.(root);
    const completed = deferred<z.infer<typeof CompletionSchema>>(), polled = deferred<void>();
    const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const failed = deferred<never>();
    void failed.promise.catch(() => {});
    let heartbeat: unknown, identity: RuntimeIdentity | undefined;
    let pollCount = 0, heartbeatCount = 0;
    const server = createServer(async (req, res) => {
      try {
        expect(req.headers.authorization).toBe("Bearer test-token");
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        const body = z.record(z.unknown()).parse(parsed);
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/executors/heartbeat") {
          heartbeat = body;
          identity = RuntimeIdentitySchema.parse(body);
          heartbeatCount++;
          res.statusCode = options.heartbeatStatus?.(heartbeatCount) ?? 200;
          res.end(JSON.stringify((options.handshake ?? handshake)(identity, heartbeatCount)));
        } else if (req.url === "/api/executors/windows-main/poll") {
          pollCount++;
          polled.resolve();
          expect(body).toEqual({ waitMs: 20000, identity });
          if (pollCount > 1) return; // Hold the long poll until cleanup, without a timer.
          if (!identity) throw new Error("Poll preceded heartbeat");
          const job: ValidJob = { jobId: "job-1", executorId: "windows-main", protocolVersion: 1, runtime: identity,
            executionTarget: deriveRemoteExecutionTarget(identity, { projectId: "project", root: await realpath(project) }, "routed-project"),
            tool: "local_shell_run", payload: { sourceProjectId: "project", command: markerCommand }, createdAt: Date.now() };
          res.end(JSON.stringify({ job: options.job ? await options.job(job, root) : job }));
        } else if (req.url === "/api/executors/windows-main/jobs/job-1/result") {
          res.end(JSON.stringify({ ok: true }));
          expect(body.identity).toEqual(identity);
          expect(body).toHaveProperty("result");
          completed.resolve(CompletionSchema.parse(body));
        } else { throw new Error("Unexpected mock hub route: " + req.url); }
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
        failed.reject(error);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock hub did not bind");
    const child = spawn(process.execPath, [workerFile], {
      env: { ...process.env, JK_HUB_URL: `http://127.0.0.1:${address.port}`, JK_EXECUTOR_ID: "windows-main",
        JK_EXECUTOR_WORKSPACE: options.workspace?.(root) ?? root, JK_EXECUTOR_TOKEN_FILE: tokenFile },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.once("error", failed.reject);
    child.once("exit", (code, signal) => exited.resolve({ code, signal }));
    child.stdout.resume(); child.stderr.resume();
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(exited.promise);
    });
    const wait = <T>(promise: Promise<T>) => bounded(Promise.race([promise, failed.promise]));
    async function tickHeartbeat() {
      const ticked = deferred<"heartbeat-done">();
      const onMessage = (message: unknown) => {
        if (message === "heartbeat-done") ticked.resolve(message);
      };
      child.on("message", onMessage);
      const outcome = Promise.race([ticked.promise, exited.promise]);
      child.send("heartbeat", (error) => { if (error) ticked.reject(error); });
      try { return await wait(outcome); } finally { child.off("message", onMessage); }
    }
    return { root, project, child, wait, completed, polled, exited, tickHeartbeat,
      get heartbeat() { return heartbeat; }, get identity() { return RuntimeIdentitySchema.parse(identity); },
      get pollCount() { return pollCount; }, get heartbeatCount() { return heartbeatCount; } };
  }

  it("rejects a wrong project target before shell execution", async () => {
    const worker = await fixture({ job: (job, root) => ({ ...job,
      executionTarget: { ...job.executionTarget, projectRoot: root },
    }) });
    const result = await worker.wait(worker.completed.promise);
    await expect(readFile(path.join(worker.project, "marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.error).toEqual(expect.any(String));
  }, 10_000);

  it.each([
    ["missing", () => ({ ok: true })],
    ["not acknowledged", (id: RuntimeIdentity) => ({ ...handshake(id), ok: false })],
    ["wrong hub role", (id: RuntimeIdentity) => ({ ...handshake(id), hub: { ...handshake(id).hub, role: "worker" } })],
    ["wrong hub version", (id: RuntimeIdentity) => ({ ...handshake(id), hub: { ...handshake(id).hub, protocolVersion: 2 } })],
    ["missing hub capability", (id: RuntimeIdentity) => ({ ...handshake(id), hub: { ...handshake(id).hub, capabilities: [] } })],
    ["missing hub OS", (id: RuntimeIdentity) => ({ ...handshake(id), hub: { ...handshake(id).hub, os: undefined } })],
    ["relative hub root", (id: RuntimeIdentity) => ({ ...handshake(id), hub: { ...handshake(id).hub, workspaceRoot: "relative" } })],
    ["wrong worker role", (id: RuntimeIdentity) => ({ ...handshake(id), executor: { ...id, role: "hub" } })],
    ["wrong worker instance", (id: RuntimeIdentity) => ({ ...handshake(id), executor: { ...id, instanceId: "other" } })],
    ["wrong worker root", (id: RuntimeIdentity) => ({ ...handshake(id), executor: { ...id, workspaceRoot: "/other" } })],
    ["missing worker capability", (id: RuntimeIdentity) => ({ ...handshake(id), executor: { ...id, capabilities: [] } })],
  ] as const)("rejects %s handshake without polling", async (_name, response) => {
    const worker = await fixture({ handshake: response });
    const outcome = await worker.wait(Promise.race([
      worker.exited.promise, worker.polled.promise.then(() => ({ code: null, signal: null })),
    ]));
    expect(outcome).toEqual({ code: 1, signal: null });
    expect(worker.pollCount).toBe(0);
    await expect(readFile(path.join(worker.root, "executor-worker.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it.each([
    ["missing job version", (job: ValidJob) => ({ ...job, protocolVersion: undefined })],
    ["missing runtime", (job: ValidJob) => ({ ...job, runtime: undefined })],
    ["wrong runtime instance", (job: ValidJob) => ({ ...job, runtime: { ...job.runtime, instanceId: "other" } })],
    ["wrong executor", (job: ValidJob) => ({ ...job, executorId: "other" })],
    ["missing runtime architecture", (job: ValidJob) => ({ ...job, runtime: { ...job.runtime, arch: undefined } })],
    ["missing runtime capability", (job: ValidJob) => ({ ...job, runtime: { ...job.runtime, capabilities: [] } })],
    ["missing target", (job: ValidJob) => ({ ...job, executionTarget: undefined })],
    ["wrong target instance", (job: ValidJob) => ({ ...job, executionTarget: { ...job.executionTarget, instanceId: "other" } })],
    ["wrong target workspace", (job: ValidJob) => ({ ...job, executionTarget: { ...job.executionTarget, workspaceRoot: "/other" } })],
    ["wrong target source", (job: ValidJob) => ({ ...job, executionTarget: { ...job.executionTarget, sourceProjectId: "other" } })],
    ["local target", (job: ValidJob) => ({ ...job, executionTarget: { ...job.executionTarget, kind: "local" } })],
    ["extra target field", (job: ValidJob) => ({ ...job, executionTarget: { ...job.executionTarget, legacy: true } })],
    ["alias instead of canonical source", (job: ValidJob) => ({ ...job, payload: { ...job.payload, sourceProjectId: "project-alias" } })],
    ["wrong payload target", (job: ValidJob) => ({ ...job, payload: { ...job.payload,
      executionTarget: { ...job.executionTarget, projectId: "other-route" } } })],
  ] as const)("rejects %s before shell execution", async (_name, job) => {
    const worker = await fixture({ job });
    const result = await worker.wait(worker.completed.promise);
    expect(result.error).toEqual(expect.any(String));
    expect(result.result).toBeNull();
    await expect(readFile(path.join(worker.project, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("executes an exact target across different hub and worker operating systems", async () => {
    const worker = await fixture({ job: (job) => ({ ...job,
      payload: { ...job.payload, executionTarget: job.executionTarget },
    }) });
    const result = await worker.wait(worker.completed.promise);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ exitCode: 0 });
    expect(await readFile(path.join(worker.project, "marker.txt"), "utf8")).toBe("executed");
    expect(await readFile(path.join(worker.root, "executor-worker.lock"), "utf8")).toBe(String(worker.child.pid));
  }, 10_000);

  it.each(["missing", "file"])("requires an existing workspace directory: %s", async (kind) => {
    const worker = await fixture({ workspace: (root) => path.join(root, kind === "file" ? "token.txt" : "absent") });
    expect(await worker.wait(worker.exited.promise)).toEqual({ code: 1, signal: null });
    expect(worker.heartbeat).toBeUndefined();
    expect(worker.pollCount).toBe(0);
  }, 10_000);

  it("canonicalizes a junction workspace before advertising and executing its target", async () => {
    const worker = await fixture({
      prepare: (root) => symlink(path.join(root, "project"), path.join(root, "workspace-link"), "junction"),
      workspace: (root) => path.join(root, "workspace-link"),
    });
    const result = await worker.wait(worker.completed.promise);
    expect(worker.identity.workspaceRoot).toBe(await realpath(worker.project));
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ exitCode: 0 });
    expect(await readFile(path.join(worker.project, "marker.txt"), "utf8")).toBe("executed");
  }, 10_000);

  it.each(["removed marker", "junction drift"])("rescans before execution after %s", async (change) => {
    const worker = await fixture({ job: async (job, root) => {
      const project = path.join(root, "project");
      if (change === "removed marker") await rm(path.join(project, "package.json"));
      else {
        await rename(project, path.join(root, "replacement"));
        await symlink(path.join(root, "replacement"), project, "junction");
      }
      return job;
    } });
    const result = await worker.wait(worker.completed.promise);
    expect(result.error).toEqual(expect.any(String));
    await expect(readFile(path.join(worker.project, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it.each([false, true])("validates runtime-only restart identity (wrong instance: %s)", async (wrong) => {
    const worker = await fixture({ job: (job) => ({ ...job, tool: "executor_restart", executionTarget: undefined,
      runtime: { ...job.runtime, instanceId: wrong ? "other" : job.runtime.instanceId }, payload: { reason: "test-restart" },
    }) });
    const result = await worker.wait(worker.completed.promise);
    const request = readFile(path.join(worker.root, "executor-restart.request"), "utf8");
    if (wrong) {
      expect(result.error).toEqual(expect.any(String));
      await expect(request).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ scheduled: true, requestFile: "executor-restart.request" });
      const parsed: unknown = JSON.parse(await request);
      const saved = z.object({ reason: z.string(), requestedAt: z.number(), notBefore: z.number() }).parse(parsed);
      expect(saved).toMatchObject({ reason: "test-restart", requestedAt: expect.any(Number) });
      expect(saved.notBefore - saved.requestedAt).toBe(3000);
      expect(result.result).toMatchObject({ notBefore: saved.notBefore });
    }
    expect(worker.child.exitCode).toBeNull();
    expect(await readFile(path.join(worker.root, "executor-worker.lock"), "utf8")).toBe(String(worker.child.pid));
  }, 10_000);

  it("exits for its supervisor when a validated heartbeat changes hub identity", async () => {
    const releaseJob = deferred<void>();
    const worker = await fixture({ controlledHeartbeat: true,
      handshake: (identity, count) => ({ ...handshake(identity),
        hub: { ...handshake(identity).hub, instanceId: count === 1 ? "hub-instance" : "replacement-hub" } }),
      job: async (job) => { await releaseJob.promise; return job; },
    });
    try {
      await worker.wait(worker.polled.promise);
      expect(await worker.tickHeartbeat()).toEqual({ code: 1, signal: null });
      expect(worker.heartbeatCount).toBe(2);
      expect(worker.pollCount).toBe(1);
      await expect(readFile(path.join(worker.project, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(worker.root, "executor-worker.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(worker.root, "executor-restart.request"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { releaseJob.resolve(); }
  }, 10_000);

  it("recovers from a transient heartbeat failure without replacing the worker", async () => {
    const releaseJob = deferred<void>();
    const worker = await fixture({ controlledHeartbeat: true,
      heartbeatStatus: (count) => count === 2 ? 503 : 200,
      job: async (job) => { await releaseJob.promise; return job; },
    });
    try {
      await worker.wait(worker.polled.promise);
      expect(await worker.tickHeartbeat()).toBe("heartbeat-done");
      expect(worker.child.exitCode).toBeNull();
      expect(await worker.tickHeartbeat()).toBe("heartbeat-done");
      releaseJob.resolve();
      const result = await worker.wait(worker.completed.promise);
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ exitCode: 0 });
      expect(worker.heartbeatCount).toBe(3);
      expect(await readFile(path.join(worker.project, "marker.txt"), "utf8")).toBe("executed");
    } finally { releaseJob.resolve(); }
  }, 10_000);

  it("discovers a project, heartbeats, executes code_search, and returns the result", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "jk-bootstrap-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "songsong" }));
    const project = path.join(root, "cleantube");
    await mkdir(path.join(project, "src"), { recursive: true });
    const nestedAndroid = path.join(project, "mobile", "android");
    await mkdir(nestedAndroid, { recursive: true });
    await writeFile(path.join(project, "package.json"), "{}\n");
    await writeFile(path.join(project, "src", "player.ts"), "const seekGuard = true;\n");
    await writeFile(path.join(nestedAndroid, "build.gradle"), "// nested module\n");
    const workerFile = path.join(root, "worker.cjs");
    const tokenFile = path.join(root, "token.txt");
    await writeFile(workerFile, WINDOWS_EXECUTOR_BOOTSTRAP_JS);
    await writeFile(tokenFile, "test-token");

    let heartbeat: any = null;
    let result: any = null;
    let pollCount = 0;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

    const server = createServer(async (req, res) => {
      try {
        expect(req.headers.authorization).toBe("Bearer test-token");
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/executors/heartbeat") {
          heartbeat = body;
          res.end(JSON.stringify(handshake(RuntimeIdentitySchema.parse(body))));
          return;
        }
        if (req.url === "/api/executors/windows-main/poll") {
          pollCount += 1;
          expect(body).toEqual({ waitMs: 20000, identity: RuntimeIdentitySchema.parse(heartbeat) });
          if (pollCount > 1) return;
          res.end(JSON.stringify({ job: pollCount === 1 ? {
            jobId: "job-1",
            executorId: "windows-main",
            protocolVersion: 1,
            runtime: RuntimeIdentitySchema.parse(heartbeat),
            executionTarget: deriveRemoteExecutionTarget(RuntimeIdentitySchema.parse(heartbeat), {
              projectId: "cleantube", root: await realpath(project),
            }),
            tool: "code_search",
            payload: { sourceProjectId: "cleantube", query: "seekGuard", maxResults: 10 },
            createdAt: Date.now(),
          } : null }));
          return;
        }
        if (req.url === "/api/executors/windows-main/jobs/job-1/result") {
          result = body;
          res.end(JSON.stringify({ ok: true }));
          resolveDone();
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
        rejectDone(error as Error);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock hub did not bind");

    const child = spawn(process.execPath, [workerFile], {
      env: {
        ...process.env,
        JK_HUB_URL: `http://127.0.0.1:${address.port}`,
        JK_EXECUTOR_ID: "windows-main",
        JK_EXECUTOR_WORKSPACE: root,
        JK_EXECUTOR_TOKEN_FILE: tokenFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = deferred<void>();
    child.once("exit", () => exited.resolve());
    child.once("error", rejectDone);
    child.stdout.resume(); child.stderr.resume();
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(exited.promise);
    });

    await bounded(done);

    expect(heartbeat?.executorId).toBe("windows-main");
    expect(RuntimeIdentitySchema.parse(heartbeat)).toMatchObject({ role: "worker", protocolVersion: 1,
      workspaceRoot: root, os: process.platform, arch: process.arch });
    expect(heartbeat?.capabilities).toContain("execution-target-v1");
    expect(result?.identity).toEqual(RuntimeIdentitySchema.parse(heartbeat));
    expect(heartbeat?.projects?.find((item: any) => path.resolve(item.root) === path.resolve(root))?.aliases).toContain("songsong");
    expect(heartbeat?.projects?.some((item: any) => item.projectId === "cleantube")).toBe(true);
    expect(heartbeat?.projects?.some((item: any) => path.resolve(item.root) === path.resolve(nestedAndroid))).toBe(false);
    expect(heartbeat?.capabilities).toContain("local_shell_run");
    expect(heartbeat?.capabilities).toContain("executor_restart");
    expect(heartbeat?.capabilities).toContain("git_sync_start");
    expect(heartbeat?.instanceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(heartbeat?.startedAtMs).toEqual(expect.any(Number));
    expect(result?.error).toBeUndefined();
    expect(result?.result?.matches?.[0]).toMatchObject({ path: "src/player.ts", line: 1 });
  }, 10_000);

  it("bounds heartbeat requests so a stuck hub response cannot wedge future heartbeats", () => {
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("new AbortController()");
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("clearTimeout(timer)");
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toMatch(/heartbeat\(registry\).*?,5000\)/);
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("setInterval(async()=>");
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("},8000)");
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain('fs.openSync(LOCK_FILE,"wx")');
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain('cp.execFileSync("tasklist"');
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain('job.tool==="executor_restart"');
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("executor-restart.request");
  });
});
