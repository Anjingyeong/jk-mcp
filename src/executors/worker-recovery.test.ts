import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExecutorWorker, type ExecutorWorkerOptions } from "./worker.js";
import { issueExecutorToken, verifyExecutorToken } from "./auth.js";
import { completeExecutorJob, dispatchExecutorJob, pollExecutorJob, recordExecutorHeartbeat, type ExecutorJob } from "./broker.js";
import { createJobDeliveryClaim, deliveryDigest, dispatchDeliveryDigest, offerJobDeliveryClaim, recordJobDeliveryReceipt, openWorkerDeliveryOutbox, readJobDeliveryClaim } from "./job-delivery-store.js";
import { createRuntimeIdentity, deriveRemoteExecutionTarget, DURABLE_RESULT_CAPABILITY, RuntimeIdentitySchema, type DurableDeliveryOffer, type DurableResultAck, type RuntimeIdentity } from "./target-protocol.js";

// All event subscriptions precede their triggering action. Deadlines only bound a
// broken test; no test waits for wall-clock progress or polls filesystem state.
const WORKER_EVENT_DEADLINE_MS = process.platform === "win32" ? 30_000 : 10_000;
const WORKER_PROCESS_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 15_000;

class Events {
  readonly emitter = new EventEmitter();
  readonly deadline = new AbortController();
  readonly timer = setTimeout(() => this.deadline.abort(), WORKER_EVENT_DEADLINE_MS);
  closing = false;
  next(name: string): Promise<unknown[]> {
    return once(this.emitter, name, { signal: this.deadline.signal }).catch(error => {
      if (this.closing) return []; // Cancel unused subscriptions after a reached assertion fails.
      throw error;
    });
  }
  emit(name: string, ...args: unknown[]) { this.emitter.emit(name, ...args); }
  close() { this.closing = true; clearTimeout(this.timer); this.deadline.abort(); }
}

type OfferedJob = ExecutorJob & { delivery: DurableDeliveryOffer };
class Fixture {
  readonly events = new Events();
  readonly dispatchReady = this.events.next("dispatch");
  readonly workers: Array<{ controller: AbortController; done: Promise<unknown> }> = [];
  readonly requests: Record<string, unknown>[] = [];
  readonly statuses: string[] = [];
  readonly executorId = "wr-worker";
  server!: Server;
  hubUrl!: string;
  token!: string;
  hub!: RuntimeIdentity;
  identity!: RuntimeIdentity;
  job?: OfferedJob;
  pending?: Promise<unknown>;
  postCount = 0;
  pollCount = 0;
  dropFirst = true;
  dropAfterCommit = false;
  restartOnPoll = false;
  readonly children: Array<{ child: ChildProcess; exited: Promise<unknown[]> }> = [];
  ackOverride?: unknown;
  ackTransform?: (ack: DurableResultAck) => unknown;
  httpStatus?: number;
  replay = false;
  mutateJob?: (job: OfferedJob) => OfferedJob;
  stripReplayDelivery = false;
  tool: "local_shell_run" | "command_run" = "local_shell_run";
  command = "node effect.mjs";
  commandId = "npm:test";
  holdEffect?: express.Response;
  control?: { restart: { requestId: string; reason: string } };
  submitted: unknown[] = [];
  constructor(readonly root: string) {}
  get stateDir() { return path.join(this.root, "worker-state"); }
  get hubState() { return path.join(this.root, "hub-state"); }
  get workspace() { return path.join(this.root, "workspace"); }
  get marker() { return path.join(this.workspace, "fixture", "effects.txt"); }
  get outboxDir() { return path.join(this.stateDir, "executor-outbox", deliveryDigest([this.hubUrl, this.executorId])); }
  async open() {
    await fs.mkdir(path.join(this.workspace, "fixture"), { recursive: true });
    await fs.writeFile(path.join(this.workspace, "fixture", "package.json"), JSON.stringify({ scripts: { test: "node effect.mjs" } }));
    await fs.writeFile(path.join(this.workspace, "fixture", "effect.mjs"), "import {appendFileSync} from 'node:fs'; appendFileSync('effects.txt','effect\\n'); console.log('native-result');");
    this.token = await issueExecutorToken(this.hubState, this.executorId);
    this.hub = await createRuntimeIdentity("hub", this.root, "local", [DURABLE_RESULT_CAPABILITY]);
    const app = express();
    app.use(express.json());
    app.get("/effect", (_req, res) => { this.holdEffect = res; this.events.emit("effect"); });
    app.use(async (req, res, next) => {
      if (!await verifyExecutorToken(this.hubState, this.executorId, String(req.headers.authorization).replace(/^Bearer /, ""))) { res.sendStatus(401); return; }
      next();
    });
    app.post("/api/executors/heartbeat", async (req, res, next) => {
      try {
        this.identity = RuntimeIdentitySchema.parse(req.body);
        await recordExecutorHeartbeat(this.hubState, req.body);
        const control = this.control;
        this.control = undefined;
        res.json({ ok: true, hub: this.hub, executor: this.identity, ...(control ? { control } : {}) });
        this.events.emit("heartbeat", this.identity);
      } catch (error) { next(error); }
    });
    app.post(`/api/executors/${this.executorId}/poll`, async (req, res, next) => {
      try {
        this.pollCount++;
        if (this.restartOnPoll) {
          res.json({ job: { jobId: randomUUID(), executorId: this.executorId, tool: "executor_restart", payload: {},
            protocolVersion: 1, runtime: req.body.identity, createdAt: Date.now() } }); return;
        }
        if (this.pollCount >= 3) this.events.emit("repeat-finished");
        if (this.job) {
          this.events.emit("poll-after-job");
          this.events.emit("next-request", "poll");
          if (this.replay) {
            this.replay = false;
            const { delivery: _delivery, ...legacy } = this.job;
            res.json({ job: this.stripReplayDelivery ? legacy : this.job });
          }
          return;
        }
        await this.dispatchReady;
        if (this.events.closing) return;
        const job = await pollExecutorJob(this.executorId, 5000, req.body.identity, this.hubState);
        if (!job) throw new Error("Fixture dispatch not delivered");
        // Pre-feature worker can still execute this protocol-v1 job, allowing a
        // genuine transport-loss RED rather than a missing-capability/import RED.
        const runtime = { ...job.runtime, capabilities: [...new Set([...job.runtime.capabilities, DURABLE_RESULT_CAPABILITY])] };
        const dispatch = { jobId: job.jobId, tool: this.tool, runtime,
          executionTarget: job.executionTarget!, payload: job.payload };
        const { delivery } = await createJobDeliveryClaim(this.hubState, { ...dispatch, createdAt: job.createdAt,
          deadlineAt: Date.now() + 60_000, ownerBinding: { approvedJobId: "a".repeat(64), approvalId: "b".repeat(64),
            projectId: "fixture", workSessionId: "session", goalId: "goal", loopId: "loop", taskIdentity: null,
            bundleFingerprint: null, jobFingerprint: "original-fingerprint", executionKind: this.tool === "command_run" ? "command-run" : "local-shell",
            commandId: this.tool === "command_run" ? this.commandId : null, manifestFingerprint: this.tool === "command_run" ? "fixture-manifest" : null } });
        await offerJobDeliveryClaim(this.hubState, job.jobId, delivery.bindingDigest);
        this.job = { ...job, runtime, delivery };
        res.json({ job: this.mutateJob ? this.mutateJob(this.job) : this.job });
        this.events.emit("offered", this.job);
      } catch (error) { next(error); }
    });
    app.post(`/api/executors/${this.executorId}/jobs/:jobId/result`, async (req, res, next) => {
      try {
        this.postCount++;
        this.requests.push(req.body);
        if (this.restartOnPoll && !req.body.delivery) { res.json({ ok: true }); return; }
        this.events.emit("next-request", "result");
        if (this.httpStatus) { res.status(this.httpStatus).json({ error: "fixture rejection" }); return; }
        if (this.dropFirst && !this.dropAfterCommit && this.postCount === 1) {
          req.socket.destroy();
          this.events.emit("dropped", req.body);
          return;
        }
        if (!req.body.delivery) {
          const accepted = completeExecutorJob(req.params.jobId, req.body.result, req.body.error, this.executorId, req.body.identity);
          res.status(accepted ? 200 : 404).json({ ok: accepted }); return;
        }
        const ack = await recordJobDeliveryReceipt(this.hubState, req.body, this.identity);
        this.submitted.push(ack);
        completeExecutorJob(req.params.jobId, req.body.delivery.result, req.body.delivery.error, this.executorId, req.body.delivery.originRuntime);
        if (this.dropAfterCommit && this.postCount === 1) {
          req.socket.destroy(); this.events.emit("dropped", req.body); return;
        }
        res.json(this.ackTransform ? this.ackTransform(ack) : this.ackOverride === undefined ? ack : this.ackOverride);
        this.events.emit("ack", ack);
      } catch (error) { next(error); }
    });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      this.events.emit("fixture-error", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    });
    this.server = createServer(app);
    const listening = this.events.next("listening");
    this.server.once("listening", () => this.events.emit("listening"));
    this.server.listen(0, "127.0.0.1");
    await listening;
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("No loopback address");
    this.hubUrl = `http://127.0.0.1:${address.port}`;
  }
  start(extra: Partial<ExecutorWorkerOptions> = {}) {
    const controller = new AbortController();
    const done = runExecutorWorker({ hubUrl: this.hubUrl, executorId: this.executorId, executorToken: this.token,
      workspaceRoot: this.workspace, stateDir: this.stateDir, signal: controller.signal,
      onStatus: (message) => { this.statuses.push(message); this.events.emit("status", message); }, ...extra,
    } as ExecutorWorkerOptions).then(() => undefined, error => error);
    const worker = { controller, done };
    this.workers.push(worker);
    return worker;
  }
  dispatch() {
    this.pending = dispatchExecutorJob(this.hubState, this.executorId, this.tool,
      { sourceProjectId: "fixture", command: this.command, commandId: this.commandId, timeoutSec: 10 }, 60_000).then(value => value, error => error);
    this.events.emit("dispatch");
  }
  async record() { return JSON.parse(await fs.readFile(path.join(this.outboxDir, `${this.job!.jobId}.json`), "utf8")); }
  async cleanup() {
    this.holdEffect?.end();
    for (const { child, exited } of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      console.info("WR owned child cleanup", JSON.stringify({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
    }
    for (const worker of this.workers) worker.controller.abort();
    await Promise.all(this.workers.map(worker => worker.done));
    if (this.job) completeExecutorJob(this.job.jobId, null, undefined, this.executorId, this.job.runtime);
    await this.pending;
    if (this.server?.listening) {
      const closed = once(this.server, "close");
      this.server.close(); this.server.closeAllConnections(); await closed;
      expect(this.server.listening).toBe(false);
    }
    this.events.close();
    await fs.rm(this.root, { recursive: true, force: true });
    await expect(fs.stat(this.root)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

let fixture: Fixture;
beforeEach(async () => {
  vi.stubEnv("JK_RUNTIME_MODE", "packaged");
  fixture = new Fixture(await fs.mkdtemp(path.join(os.tmpdir(), "jk-delivery-WR-")));
  await fixture.open();
});
afterEach(async () => { await fixture.cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function controlledRetry() {
  const scheduled = fixture.events.next("retry-scheduled");
  const original = globalThis.setTimeout;
  let release: (() => void) | undefined;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    if (ms !== 1000) return original(callback, ms, ...args);
    release = () => callback(...args);
    fixture.events.emit("retry-scheduled");
    // No timer drives this retry: the test owns its exact release signal.
    return { unref() {}, ref() {} } as NodeJS.Timeout;
  });
  return { scheduled, release: () => { if (!release) throw new Error("Retry not armed"); release(); } };
}

describe("durable native worker delivery", () => {
  it("worker-recovery R1 retries a lost result POST before polling with exactly one native effect", async () => {
    const retry = controlledRetry();
    const heartbeat = fixture.events.next("heartbeat");
    const dropped = fixture.events.next("dropped");
    fixture.start(); await heartbeat; fixture.dispatch(); await dropped; await retry.scheduled;
    expect(await fs.readFile(fixture.marker, "utf8")).toBe("effect\n");
    expect(fixture.requests[0]).toMatchObject(fixture.requests[0]?.delivery
      ? { delivery: { outcome: "returned", result: { exitCode: 0, stdoutSummary: "native-result\n" } } }
      : { result: { exitCode: 0, stdoutSummary: "native-result\n" } });
    const next = fixture.events.next("next-request");
    const ack = fixture.events.next("ack");
    retry.release();
    expect((await next)[0], "completed bytes must retry, not disappear into another poll").toBe("result");
    await ack;
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
    expect(await fs.readFile(fixture.marker, "utf8")).toBe("effect\n");
  });

  it("restart control interrupts result retry backoff and preserves completed outbox bytes", async () => {
    const retry = controlledRetry();
    const interval = globalThis.setInterval;
    let heartbeatTick: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, ms, ...args) => {
      if (ms === 1_000) {
        heartbeatTick = () => callback(...args);
        return { unref() {}, ref() {} } as NodeJS.Timeout;
      }
      return interval(callback, ms, ...args);
    });
    const heartbeat = fixture.events.next("heartbeat");
    const dropped = fixture.events.next("dropped");
    const worker = fixture.start({ heartbeatMs: 3_000 });
    await heartbeat;
    fixture.dispatch();
    await dropped;
    await retry.scheduled;
    expect((await fixture.record()).state).toBe("completed");
    expect(await effectCount()).toBe(1);
    expect(fixture.pollCount).toBe(1);

    fixture.control = { restart: { requestId: randomUUID(), reason: "retire during result retry" } };
    if (!heartbeatTick) throw new Error("heartbeat interval was not armed");
    heartbeatTick(); heartbeatTick(); heartbeatTick();
    await Promise.race([
      worker.done,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("restart waited for result retry backoff")), 500)),
    ]);
    expect((await fixture.record()).state).toBe("completed");
    expect(await effectCount()).toBe(1);
    expect(fixture.pollCount).toBe(1);
    expect(fixture.postCount).toBe(1);
  });
});

function observeRenames(operation: (state: string, commit: () => Promise<void>) => Promise<void>) {
  const rename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).startsWith(fixture.outboxDir) && String(to).endsWith(".json")) {
      const record = JSON.parse(await fs.readFile(from, "utf8"));
      await operation(record.state, () => rename(from, to));
    } else await rename(from, to);
  });
}
async function launch() {
  const heartbeat = fixture.events.next("heartbeat");
  const worker = fixture.start();
  await heartbeat;
  fixture.dispatch();
  return worker;
}
async function effectCount() {
  try { return (await fs.readFile(fixture.marker, "utf8")).split("effect\n").length - 1; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

// Each test is individually filterable for an independent behavioral RED.
describe("worker receipt lifecycle", () => {
  it("worker-recovery R2 retries a lost ACK with the identical terminal envelope and receipt revision", async () => {
    fixture.dropAfterCommit = true;
    const retry = controlledRetry();
    const dropped = fixture.events.next("dropped");
    await launch(); await dropped; await retry.scheduled;
    const first = await readJobDeliveryClaim(fixture.hubState, fixture.job!.jobId);
    const ack = fixture.events.next("ack");
    const next = fixture.events.next("next-request");
    retry.release();
    expect((await next)[0]).toBe("result");
    await ack;
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
    expect(fixture.submitted).toHaveLength(2);
    expect(fixture.submitted[1]).toEqual(fixture.submitted[0]);
    expect(await readJobDeliveryClaim(fixture.hubState, fixture.job!.jobId)).toEqual(first);
    expect(await effectCount()).toBe(1);
  });

  it("worker-recovery R4 restarts as courier from committed bytes before any new poll or old execution", async () => {
    fixture.dropFirst = false;
    const committed = fixture.events.next("completed");
    observeRenames(async (state, commit) => {
      await commit();
      if (state === "completed") { fixture.workers[0]!.controller.abort(); fixture.events.emit("completed"); }
    });
    const original = await launch(); await committed; await original.done;
    const saved = await fixture.record();
    expect(await effectCount()).toBe(1);
    expect(fixture.postCount).toBe(0);
    const next = fixture.events.next("next-request");
    const compacted = fixture.events.next("acknowledged");
    observeRenames(async (state, commit) => { await commit(); fixture.events.emit(state); });
    fixture.start();
    expect((await next)[0], "startup must courier saved output before polling").toBe("result");
    await compacted;
    const delivered = fixture.requests[0] as { delivery: unknown; courierRuntime: RuntimeIdentity };
    expect(delivered.delivery).toEqual(JSON.parse(saved.envelopeJson));
    expect(delivered.courierRuntime.instanceId).not.toBe(saved.runtime.instanceId);
    expect((await fixture.record()).executionTarget).toEqual(saved.executionTarget);
    expect((await fixture.record()).state).toBe("acknowledged");
    expect(await effectCount()).toBe(1);
  });

  it("worker-recovery R7 commits started before the native command can have effects", async () => {
    fixture.dropFirst = false;
    const held = fixture.events.next("start-held");
    const release = fixture.events.next("release-start");
    observeRenames(async (state, commit) => {
      if (state === "started") { fixture.events.emit("start-held"); await release; }
      await commit();
    });
    const ack = fixture.events.next("ack");
    await launch(); await held;
    try { expect(await effectCount(), "effects must wait for the start rename").toBe(0); }
    finally { fixture.events.emit("release-start"); }
    await ack;
    expect(await effectCount()).toBe(1);
  });

  it.each(["started", "completed"])("worker-recovery R7 %s persistence failure stops admission and preserves unknown evidence", async (phase) => {
    observeRenames(async (state, commit) => {
      if (state === phase) throw Object.assign(new Error("owned rename failure"), { code: "EACCES" });
      await commit();
    });
    const next = fixture.events.next("next-request");
    const retry = controlledRetry();
    const worker = await launch();
    const stopped = await Promise.race([worker.done, next.then(() => "continued"), retry.scheduled.then(() => "retrying")]);
    expect(stopped).toMatchObject({ reason: "UNREADABLE" });
    expect(fixture.postCount).toBe(0);
    expect(fixture.pollCount).toBe(1);
    expect(await effectCount()).toBe(phase === "started" ? 0 : 1);
    if (phase === "completed") expect((await fixture.record()).state).toBe("started");
  });

  it("worker-recovery R6 unknown effects in a started claim are never executed by a replacement worker", async () => {
    const spy = observeRenames(async (state, commit) => {
      if (state === "completed") throw Object.assign(new Error("completion unavailable"), { code: "EACCES" });
      await commit();
    });
    const original = await launch(); await original.done; spy.mockRestore();
    expect(await effectCount()).toBe(1);
    const before = await fixture.record();
    fixture.replay = true;
    const repeated = fixture.events.next("repeat-finished");
    const replacement = fixture.start();
    const outcome = await Promise.race([repeated.then(() => "poll"), replacement.done.then(() => "stopped")]);
    expect(await effectCount(), "unknown effects cannot be repeated").toBe(1);
    expect(outcome).toBe("poll");
    expect(await fixture.record()).toEqual(before);
    expect(fixture.postCount).toBe(0);
  });

  it("worker-recovery R6 acknowledged tombstones cannot execute even when a hub repeats the old claim", async () => {
    fixture.dropFirst = false;
    fixture.replay = true;
    const acknowledged = fixture.events.next("acknowledged");
    const repeated = fixture.events.next("repeat-finished");
    observeRenames(async (state, commit) => { await commit(); fixture.events.emit(state); });
    const worker = await launch(); await acknowledged;
    await Promise.race([repeated, worker.done]);
    expect(await effectCount(), "acknowledgement is a tombstone, never execution authority").toBe(1);
    expect(fixture.postCount).toBe(1);
    expect((await fixture.record()).state).toBe("acknowledged");
  });

  it("worker-recovery R7 corrupt outbox blocks capability advertisement without replacing bytes", async () => {
    const outbox = await openWorkerDeliveryOutbox(fixture.stateDir, fixture.hubUrl, fixture.executorId);
    await outbox.close();
    const file = path.join(outbox.directory, `${randomUUID()}.json`);
    await fs.writeFile(file, "{broken");
    const heartbeat = fixture.events.next("heartbeat");
    const worker = fixture.start();
    expect(await Promise.race([worker.done, heartbeat.then(() => "advertised")])).toMatchObject({ reason: "INVALID_RECORD" });
    expect(await fs.readFile(file, "utf8")).toBe("{broken");
    expect(fixture.pollCount).toBe(0);
  });

  it("worker-recovery R11 a full retained namespace refuses admission before native effects", async () => {
    const runtime = await createRuntimeIdentity("worker", fixture.workspace, fixture.executorId, ["local_shell_run", DURABLE_RESULT_CAPABILITY]);
    const executionTarget = deriveRemoteExecutionTarget(runtime, { projectId: "fixture", root: path.join(runtime.workspaceRoot, "fixture") });
    const outbox = await openWorkerDeliveryOutbox(fixture.stateDir, fixture.hubUrl, fixture.executorId);
    try {
      const dispatch = { jobId: randomUUID(), tool: "local_shell_run" as const, runtime, executionTarget, payload: { sourceProjectId: "fixture", command: "node effect.mjs" } };
      const { record } = await outbox.start({ ...dispatch, delivery: { version: 1, dispatchDigest: dispatchDeliveryDigest(dispatch), bindingDigest: "0".repeat(64), receiptCapability: "1".repeat(64) } });
      // Prepare real, schema-valid unknown start records, not terminal results.
      // Avoid quadratic admission work in setup; production open validates every file.
      const { recordDigest: _digest, ...template } = record;
      for (let index = 1; index < 256; index++) {
        const jobId = randomUUID();
        const body = { ...template, jobId, dispatchDigest: dispatchDeliveryDigest({ ...dispatch, jobId }) };
        await fs.writeFile(path.join(outbox.directory, `${jobId}.json`), JSON.stringify({ ...body, recordDigest: deliveryDigest(body) }), { mode: 0o600 });
      }
    } finally { await outbox.close(); }
    const worker = await launch();
    expect(await worker.done).toMatchObject({ reason: "CAPACITY" });
    expect(await effectCount()).toBe(0);
    expect(fixture.postCount).toBe(0);
    expect((await fs.readdir(fixture.outboxDir)).filter(name => name.endsWith(".json"))).toHaveLength(256);
  });

  it("worker-recovery R11 a second worker cannot advertise or steal the live outbox lock", async () => {
    const heartbeat = fixture.events.next("heartbeat"); fixture.start(); await heartbeat;
    const competingHeartbeat = fixture.events.next("heartbeat");
    const second = fixture.start();
    expect(await Promise.race([second.done, competingHeartbeat.then(() => "advertised")])).toMatchObject({ reason: "LOCKED" });
    expect(fixture.identity.capabilities).toContain(DURABLE_RESULT_CAPABILITY);
  });

  it.each([
    ["bare", { ok: true }], ["malformed", "not-json-ack"],
    ["jobId", "jobId"], ["bindingDigest", "bindingDigest"], ["resultRevision", "resultRevision"], ["resultDigest", "resultDigest"],
  ])("worker-recovery R11 %s ACK cannot compact completed payload", async (_name, ack) => {
    fixture.dropFirst = false;
    if (["jobId", "bindingDigest", "resultRevision", "resultDigest"].includes(String(ack))) {
      fixture.ackTransform = original => ({ ...original, [String(ack)]: ack === "jobId" ? randomUUID() : ack === "resultRevision" ? 2 : "0".repeat(64) });
    } else fixture.ackOverride = ack;
    let saved: unknown;
    observeRenames(async (state, commit) => { await commit(); if (state === "completed") saved = await fixture.record(); });
    const admitted = fixture.events.next("poll-after-job");
    const worker = await launch();
    expect(await Promise.race([worker.done, admitted.then(() => "continued")])).toMatchObject({ name: "JobDeliveryError" });
    expect(await fixture.record()).toEqual(saved);
    expect(await effectCount()).toBe(1);
  });

  it.each([401, 403, 404, 409])("worker-recovery R9 HTTP %s retains completed bytes and blocks admission", async (status) => {
    fixture.httpStatus = status;
    const retry = controlledRetry();
    const worker = await launch();
    expect(await Promise.race([worker.done, retry.scheduled.then(() => "retrying")])).toMatchObject({ reason: status === 401 || status === 403 ? "UNAUTHORIZED" : status === 404 ? "NOT_FOUND" : "CONFLICT" });
    expect((await fixture.record()).state).toBe("completed");
    expect(await effectCount()).toBe(1);
    expect(fixture.pollCount).toBe(1);
  });

  it("worker-recovery R11 escaped oversized output is privately retained without sending or truncating it", async () => {
    await fs.writeFile(path.join(fixture.workspace, "fixture", "effect.mjs"),
      "import {appendFileSync} from 'node:fs'; appendFileSync('effects.txt','effect\\n'); process.stdout.write(String.fromCharCode(1).repeat(18000));");
    const retry = controlledRetry();
    const worker = await launch();
    expect(await Promise.race([worker.done, retry.scheduled.then(() => "retrying")])).toMatchObject({ reason: "RESULT_TOO_LARGE" });
    const saved = await fixture.record();
    expect(saved.state).toBe("completed");
    expect(JSON.parse(saved.envelopeJson).result.stdoutSummary).toHaveLength(18000);
    expect(fixture.postCount).toBe(0);
    expect(await effectCount()).toBe(1);
  });

  it.each(["local_shell_run", "command_run"] as const)("worker-recovery R12 %s preserves native nonzero output instead of transport failure", async (tool) => {
    fixture.tool = tool; fixture.dropFirst = false;
    await fs.appendFile(path.join(fixture.workspace, "fixture", "effect.mjs"), "process.exitCode=7;");
    const ack = fixture.events.next("ack"); await launch(); await ack;
    const body = fixture.requests[0] as { delivery: { outcome: string; result: { exitCode: number; stdoutSummary: string }; error?: string } };
    expect(body.delivery.outcome).toBe("returned");
    expect(body.delivery.result.exitCode).toBe(7);
    expect(body.delivery.result.stdoutSummary).toContain("native-result");
    expect(body.delivery.error).toBeUndefined();
    expect(await effectCount()).toBe(1);
  });

  it("worker-recovery R12 execution throw is a retained threw outcome, not a synthetic safe exit", async () => {
    fixture.tool = "command_run"; fixture.commandId = "npm:missing"; fixture.dropFirst = false;
    const ack = fixture.events.next("ack"); await launch(); await ack;
    expect(fixture.requests[0]).toMatchObject({ delivery: { outcome: "threw", error: expect.any(String) } });
    expect((fixture.requests[0]!.delivery as object)).not.toHaveProperty("result");
    expect(await effectCount()).toBe(0);
  });

  it("worker-recovery R6 stripping delivery cannot downgrade a known claim into ephemeral execution", async () => {
    fixture.dropFirst = false; fixture.replay = true; fixture.stripReplayDelivery = true;
    const retry = controlledRetry();
    const worker = await launch();
    const outcome = await Promise.race([worker.done, retry.scheduled.then(() => "retrying")]);
    expect(await effectCount(), "removing enrollment cannot authorize the same claim again").toBe(1);
    expect(outcome).toMatchObject({ reason: "CONFLICT" });
    expect(fixture.postCount).toBe(1);
  });

  it("worker-recovery R7 raw completion cleanup error stops admission rather than becoming a transport retry", async () => {
    let completedTemp: string | undefined;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).startsWith(fixture.outboxDir) && String(to).endsWith(".json")
        && JSON.parse(await fs.readFile(from, "utf8")).state === "completed") completedTemp = String(from);
      await rename(from, to);
    });
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async file => {
      if (String(file) === completedTemp) throw Object.assign(new Error("owned cleanup denied"), { code: "EACCES" });
      await unlink(file);
    });
    const retry = controlledRetry();
    const worker = await launch();
    expect(await Promise.race([worker.done, retry.scheduled.then(() => "retrying")])).toMatchObject({ reason: "UNREADABLE" });
    expect(await effectCount()).toBe(1);
    expect((await fixture.record()).state).toBe("completed");
    expect(fixture.pollCount).toBe(1);
    expect(fixture.postCount).toBe(0);
  });

  it("worker-recovery R7 hub replacement during start commit leaves unknown work unexecuted", async () => {
    const interval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, ms, ...args) => {
      if (ms !== 1_000) return interval(callback, ms, ...args);
      tick = () => callback(...args); return { unref() {}, ref() {} } as NodeJS.Timeout;
    });
    const held = fixture.events.next("start-held");
    const release = fixture.events.next("release-start");
    observeRenames(async (state, commit) => { await commit(); if (state === "started") { fixture.events.emit("start-held"); await release; } });
    const worker = await launch(); await held;
    fixture.hub = { ...fixture.hub, instanceId: randomUUID() };
    const changed = fixture.events.next("status");
    for (let i = 0; i < 10; i += 1) tick!();
    await changed;
    fixture.events.emit("release-start"); await worker.done;
    expect(await effectCount(), "a changed hub cannot start effects after an awaited commit").toBe(0);
    expect((await fixture.record()).state).toBe("started");
    expect(fixture.postCount).toBe(0);
  });

  it("worker-recovery R7 failed startup handshake releases the owned namespace lock", async () => {
    fixture.hub = { ...fixture.hub, role: "worker" };
    const worker = fixture.start();
    expect(await worker.done).toBeInstanceOf(Error);
    let reopened: Awaited<ReturnType<typeof openWorkerDeliveryOutbox>> | undefined;
    try {
      await expect(openWorkerDeliveryOutbox(fixture.stateDir, fixture.hubUrl, fixture.executorId).then(value => { reopened = value; return value; }))
        .resolves.toHaveProperty("directory", fixture.outboxDir);
    } finally { await reopened?.close(); }
  });

  it.each(["target", "dispatch"])("worker-recovery R9 changed %s never reaches native effects", async (kind) => {
    fixture.mutateJob = job => kind === "target"
      ? { ...job, executionTarget: { ...job.executionTarget!, projectRoot: fixture.root } }
      : { ...job, payload: { ...job.payload, command: "node effect.mjs changed" } };
    const retry = controlledRetry();
    const worker = await launch();
    expect(await Promise.race([worker.done, retry.scheduled.then(() => "retrying")])).toMatchObject({ name: "JobDeliveryError" });
    expect(await effectCount()).toBe(0);
    expect(fixture.postCount).toBe(0);
  });

  it("worker-recovery R3 completes durable output before exiting on hub replacement during execution", async () => {
    await fs.writeFile(path.join(fixture.workspace, "fixture", "effect.mjs"),
      `import {appendFileSync} from 'node:fs'; import http from 'node:http'; appendFileSync('effects.txt','effect\\n'); await new Promise((resolve,reject)=>http.get('${fixture.hubUrl}/effect',res=>{res.resume();res.on('end',resolve);}).on('error',reject)); console.log('native-result');`);
    const interval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, ms, ...args) => {
      if (ms !== 1_000) return interval(callback, ms, ...args);
      tick = () => callback(...args);
      return { unref() {}, ref() {} } as NodeJS.Timeout;
    });
    const effect = fixture.events.next("effect");
    const worker = await launch(); await effect;
    expect(await effectCount()).toBe(1);
    fixture.hub = { ...fixture.hub, instanceId: randomUUID() };
    const changed = fixture.events.next("status");
    tick!(); await changed;
    fixture.holdEffect!.end();
    await worker.done;
    const record = await fixture.record();
    expect(record.state, "replacement exit must not discard an available terminal result").toBe("completed");
    expect(JSON.parse(record.envelopeJson)).toMatchObject({ outcome: "returned", result: { exitCode: 0, stdoutSummary: "native-result\n" } });
    expect(fixture.postCount).toBe(0);
  });

  it("worker-recovery R10 heartbeat restart control interrupts a held durable job and preserves unknown-outcome evidence", async () => {
    await fs.writeFile(path.join(fixture.workspace, "fixture", "effect.mjs"),
      `import {appendFileSync} from 'node:fs'; import http from 'node:http'; appendFileSync('effects.txt','effect\\n'); await new Promise((resolve,reject)=>http.get('${fixture.hubUrl}/effect',res=>{res.resume();res.on('end',resolve);}).on('error',reject)); console.log('must-not-complete');`);
    const interval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, ms, ...args) => {
      if (ms !== 1_000) return interval(callback, ms, ...args);
      tick = () => callback(...args);
      return { unref() {}, ref() {} } as NodeJS.Timeout;
    });
    const effect = fixture.events.next("effect");
    const worker = await launch();
    await effect;
    expect(await effectCount()).toBe(1);
    fixture.control = { restart: { requestId: randomUUID(), reason: "recover busy worker" } };
    tick!();

    expect(await worker.done).toBeUndefined();
    const record = await fixture.record();
    expect(record.state).toBe("started");
    expect(fixture.postCount).toBe(0);
  }, WORKER_PROCESS_TEST_TIMEOUT_MS);

  it("worker-recovery R4 actual worker process restart couriers the old result without repeating the command", async () => {
    const tokenFile = path.join(fixture.root, "executor.token");
    await fs.writeFile(tokenFile, fixture.token);
    const startProcess = () => {
      const child = spawn(process.execPath, ["node_modules/vite-node/vite-node.mjs", "--script", "src/cli.ts", "executor",
        "--hub", fixture.hubUrl, "--workspace", fixture.workspace, "--executor-id", fixture.executorId,
        "--token-file", tokenFile, "--state-dir", fixture.stateDir], { cwd: process.cwd(), windowsHide: true,
          env: { ...process.env, JK_EXECUTOR_TOKEN: undefined, JK_RUNTIME_MODE: "packaged" }, stdio: "ignore" });
      const exited = once(child, "exit", { signal: fixture.events.deadline.signal });
      fixture.children.push({ child, exited }); return { child, exited };
    };
    const heartbeat = fixture.events.next("heartbeat");
    const dropped = fixture.events.next("dropped");
    const first = startProcess(); await heartbeat; fixture.dispatch(); await dropped;
    const saved = await fixture.record();
    expect(saved.state).toBe("completed");
    expect(await effectCount()).toBe(1);
    first.child.kill(); await first.exited;
    fixture.dropFirst = false; fixture.restartOnPoll = true;
    const second = startProcess();
    expect((await second.exited)[0]).toBe(0);
    expect(fixture.requests[1]).toMatchObject({ delivery: JSON.parse(saved.envelopeJson) });
    expect((fixture.requests[1]!.courierRuntime as RuntimeIdentity).instanceId).not.toBe(saved.runtime.instanceId);
    expect((await fixture.record()).state).toBe("acknowledged");
    expect(await effectCount()).toBe(1);
  }, WORKER_PROCESS_TEST_TIMEOUT_MS);

  it.each(["flag", "environment", "default-token-file", "default-token-env"])("worker-recovery R4 CLI %s uses the stable private state root", async (mode) => {
    fixture.restartOnPoll = true;
    const tokenFile = path.join(fixture.root, "executor.token");
    await fs.writeFile(tokenFile, fixture.token);
    const stateFlag = path.join(fixture.root, "flag-state");
    const stateEnv = path.join(fixture.root, "env-state");
    const stateDefault = path.join(fixture.root, "default-state");
    const expected = mode === "flag" ? stateFlag : mode === "environment" ? stateEnv : stateDefault;
    const args = ["node_modules/vite-node/vite-node.mjs", "--script", "src/cli.ts", "executor", "--hub", fixture.hubUrl,
      "--workspace", fixture.workspace, "--executor-id", fixture.executorId, "--token-file", tokenFile,
      ...(mode === "flag" ? ["--state-dir", stateFlag] : [])];
    const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, JK_STATE_DIR: stateDefault, JK_EXECUTOR_STATE_DIR: mode.startsWith("default") ? "" : stateEnv,
        JK_EXECUTOR_TOKEN: mode === "default-token-env" ? fixture.token : undefined, JK_RUNTIME_MODE: "packaged" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { output += String(chunk); });
    const exited = once(child, "exit", { signal: fixture.events.deadline.signal });
    fixture.children.push({ child, exited });
    const [code] = await exited;
    expect(code, output).toBe(0);
    expect(fixture.identity.capabilities).toContain(DURABLE_RESULT_CAPABILITY);
    await expect(fs.readdir(path.join(expected, "executor-outbox"))).resolves.toEqual([deliveryDigest([fixture.hubUrl, fixture.executorId])]);
    for (const unused of [stateFlag, stateEnv, stateDefault].filter(item => item !== expected)) {
      await expect(fs.stat(unused)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, WORKER_PROCESS_TEST_TIMEOUT_MS);

  it("worker-recovery R12 unenrolled options keep ephemeral capability and do not create an outbox", async () => {
    const heartbeat = fixture.events.next("heartbeat");
    fixture.start({ stateDir: undefined }); await heartbeat;
    expect(fixture.identity.capabilities).not.toContain(DURABLE_RESULT_CAPABILITY);
    await expect(fs.stat(fixture.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
