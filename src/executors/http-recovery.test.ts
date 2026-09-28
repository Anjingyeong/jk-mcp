import express from "express";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { EventEmitter, once } from "node:events";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.js";
import { runLocalShell } from "../exec/local-shell.js";
import { issueExecutorToken, revokeExecutorToken } from "./auth.js";
import { registerExecutorRoutes } from "./http.js";
import { runExecutorWorker } from "./worker.js";
import { dispatchExecutorJob, getExecutorProjectRegistry, dispatchPreparedExecutorJob, pollExecutorJob, prepareExecutorJobDelivery, recordExecutorHeartbeat,
  type PreparedExecutorJobDelivery, type ExecutorHeartbeat } from "./broker.js";
import { readJobDeliveryClaim, resultDeliveryDigest, type JobDeliveryOwnerBinding } from "./job-delivery-store.js";
import { createRuntimeIdentity, DURABLE_RESULT_CAPABILITY, EXECUTOR_CONTROL_CAPABILITY, DurableResultAckSchema, ExecutorHandshakeSchema, type DurableResultSubmission } from "./target-protocol.js";

let root: string, stateDir: string, url: string, token: string;
let server: Server | undefined;
let child: ChildProcess | undefined;
let heartbeat: ExecutorHeartbeat;
let ctx: ToolContext;
let prepared: PreparedExecutorJobDelivery;
let submission: DurableResultSubmission;
let caller: Promise<unknown>;
let acknowledgementMode: "normal" | "drop" = "normal";
let heartbeatControlMode: "normal" | "drop" = "normal";
const events = new EventEmitter();
const ownerBinding: JobDeliveryOwnerBinding = { approvedJobId: "a".repeat(64), approvalId: "b".repeat(64), projectId: "fixture",
  workSessionId: "session", goalId: "goal", loopId: "loop", taskIdentity: "task", bundleFingerprint: "bundle",
  jobFingerprint: "fingerprint", executionKind: "local-shell", commandId: null, manifestFingerprint: null };
function post(route: string, body: unknown, bearer: string | null = token) {
  return fetch(`${url}${route}`, { method: "POST", headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
}
function result(body: unknown = submission, bearer: string | null = token, jobId = prepared.job.jobId, executorId = "worker") {
  return post(`/api/executors/${executorId}/jobs/${jobId}/result`, body, bearer);
}
function claimFile() { return path.join(stateDir, "executors/jobs", `${prepared.job.jobId}.json`); }
async function closeServer() {
  if (!server) return;
  const closed = once(server, "close", { signal: AbortSignal.timeout(8000) });
  server.closeAllConnections(); server.close(); await closed; server = undefined;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "jk-delivery-BR-http-")); stateDir = path.join(root, "state");
  await fs.writeFile(path.join(root, "effect.mjs"), 'import {appendFileSync} from "node:fs"; appendFileSync("effects","one\\n"); console.log("saved-native-output"); process.exitCode=7;');
  token = await issueExecutorToken(stateDir, "worker");
  ctx = { workspaceRoot: root, stateDir, registry: [], ledger: { append: async () => {} },
    store: { loadProjects: async () => [], saveProjects: async () => {}, getSession: async () => null, setSession: async () => {} },
    config: { workspaceRoot: root, stateDir, maxReadBytes: 10000, maxPatchBytes: 10000, defaultCommandTimeoutSec: 10, defaultLeaseTtlMs: 10000 } };
  const app = express(); app.use(express.json()); acknowledgementMode = "normal"; heartbeatControlMode = "normal";
  app.use((req, res, next) => {
    if (req.path.endsWith("/heartbeat")) {
      const json = res.json.bind(res);
      res.json = body => {
        if (heartbeatControlMode === "drop" && body?.control?.restart) {
          heartbeatControlMode = "normal"; events.emit("control-response-dropped", body.control); res.destroy(); return res;
        }
        return json(body);
      };
    }
    if (req.path.endsWith("/result")) {
      const json = res.json.bind(res);
      res.json = body => {
        if (acknowledgementMode === "drop" && body?.ok && body?.resultRevision === 1) {
          acknowledgementMode = "normal"; events.emit("ack-committed", body); res.destroy(); return res;
        }
        if (body?.ok && !body?.resultRevision) events.emit("legacy-result", { route: req.path, submission: req.body });
        return json(body);
      };
    }
    next();
  });
  registerExecutorRoutes(app, ctx);
  server = app.listen(0, "127.0.0.1"); await once(server, "listening", { signal: AbortSignal.timeout(8000) });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("owned socket missing");
  url = `http://127.0.0.1:${address.port}`;
  heartbeat = { ...await createRuntimeIdentity("worker", root, "worker", ["local_shell_run", DURABLE_RESULT_CAPABILITY]),
    platform: process.platform, projects: [{ projectId: "fixture", name: "fixture", root, aliases: [] }] };
  expect((await post("/api/executors/heartbeat", heartbeat)).status).toBe(200);
  prepared = await prepareExecutorJobDelivery(stateDir, "worker", "local_shell_run", { sourceProjectId: "fixture", command: "node effect.mjs" }, ownerBinding, 60000);
  const waiting = pollExecutorJob("worker", 20000, heartbeat, stateDir);
  caller = dispatchPreparedExecutorJob(stateDir, prepared, { approvedJobId: ownerBinding.approvedJobId,
    brokerJobId: prepared.job.jobId, bindingDigest: prepared.claim.bindingDigest }).then(value => ({ value }), error => ({ error }));
  expect((await waiting)?.jobId).toBe(prepared.job.jobId);
  const output = await runLocalShell(root, "node effect.mjs");
  const body = { jobId: prepared.job.jobId, originRuntime: prepared.job.runtime,
    ...prepared.job.delivery!, workerCompletedAt: Date.now(), outcome: "returned" as const, result: output };
  submission = { delivery: { ...body, resultDigest: resultDeliveryDigest(body) }, courierRuntime: prepared.job.runtime };
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (child) {
    const exited = once(child, "exit", { signal: AbortSignal.timeout(8000) }); child.send("stop");
    const [code] = await exited; expect(code).toBe(0); child = undefined;
  }
  await closeServer();
  await recordExecutorHeartbeat(stateDir, { ...heartbeat, instanceId: "cleanup" }); await caller;
  expect(await fs.readFile(path.join(root, "effects"), "utf8")).toBe("one\n");
  await fs.rm(root, { recursive: true, force: true });
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("worker-recovery authenticated receipts", () => {
  it("restart control is retried when the heartbeat response carrying it is lost", async () => {
    heartbeat = { ...heartbeat, capabilities: [...heartbeat.capabilities, "executor_restart", EXECUTOR_CONTROL_CAPABILITY] };
    expect((await post("/api/executors/heartbeat", heartbeat)).status).toBe(200);
    let settled = false;
    const restart = dispatchExecutorJob(stateDir, "worker", "executor_restart", { reason: "retry lost control response" }, 5_000)
      .then(value => { settled = true; return value; });
    heartbeatControlMode = "drop";
    const droppedEvent = once(events, "control-response-dropped", { signal: AbortSignal.timeout(8_000) });
    const dropped = post("/api/executors/heartbeat", heartbeat).then(() => "unexpected success", () => "socket lost");
    const [firstControl] = await droppedEvent as [{ restart: { requestId: string; reason: string } }];
    expect(await dropped).toBe("socket lost");
    await Promise.resolve();
    expect(settled).toBe(false);

    const retry = await post("/api/executors/heartbeat", heartbeat);
    expect(retry.status).toBe(200);
    const retriedBody = await retry.json() as { control?: { restart?: { requestId: string; reason: string } } };
    expect(retriedBody.control?.restart).toEqual(firstControl.restart);
    await expect(restart).resolves.toMatchObject({ scheduled: true, reason: "retry lost control response", via: "heartbeat-control" });
  });

  it("worker-recovery R12 real legacy worker runs native command once and duplicate stays 404", async () => {
    const projectRoot = path.join(root, "fixture"); await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "package.json"), "{}");
    await fs.writeFile(path.join(projectRoot, "effect.mjs"), 'import {appendFileSync} from "node:fs"; appendFileSync("worker-effects","one\\n"); console.log("worker-native");');
    const ready = once(events, "worker-ready", { signal: AbortSignal.timeout(8000) });
    const controller = new AbortController();
    const worker = runExecutorWorker({ hubUrl: url, workspaceRoot: root, executorId: "worker", executorToken: token,
      signal: controller.signal, onStatus: status => { if (status.startsWith("executor ready ")) events.emit("worker-ready"); } });
    try {
      await ready;
      const project = (await getExecutorProjectRegistry(stateDir, [])).find(project => project.projectId === "fixture");
      if (!project) throw new Error("worker canonical project missing");
      const completed = once(events, "legacy-result", { signal: AbortSignal.timeout(8000) });
      const output = await dispatchExecutorJob<{ stdoutSummary: string }>(stateDir, "worker", "local_shell_run",
        { sourceProjectId: "fixture", executionTarget: project.executionTarget, command: "node effect.mjs" }, 8000);
      const [receipt] = await completed as [{ route: string; submission: unknown }];
      expect(output.stdoutSummary).toContain("worker-native");
      expect(await fs.readFile(path.join(projectRoot, "worker-effects"), "utf8")).toBe("one\n");
      expect((await post(receipt.route, receipt.submission)).status).toBe(404);
    } finally { controller.abort(); await worker; }
  }, 15000);
  it("worker-recovery R12 advertises durable handler capability", async () => {
    const response = await post("/api/executors/heartbeat", heartbeat);
    expect(ExecutorHandshakeSchema.parse(await response.json()).hub.capabilities).toContain(DURABLE_RESULT_CAPABILITY);
  });
  it("worker-recovery R2 duplicate POST returns identical typed ACK and immutable receipt", async () => {
    const first = await result(); expect(first.status).toBe(200); const ack = DurableResultAckSchema.parse(await first.json());
    const bytes = await fs.readFile(claimFile());
    const duplicate = await result(); expect(duplicate.status).toBe(200); expect(await duplicate.json()).toEqual(ack);
    expect(await fs.readFile(claimFile())).toEqual(bytes);
    expect(await caller).toEqual({ value: submission.delivery.result });
  });
  it("worker-recovery R2 lost HTTP ACK retries same receipt without repeating native effects", async () => {
    const committed = once(events, "ack-committed", { signal: AbortSignal.timeout(8000) });
    acknowledgementMode = "drop";
    const dropped = result().then(() => "unexpected success", () => "socket lost");
    const [ack] = await committed; expect(await dropped).toBe("socket lost");
    expect((await readJobDeliveryClaim(stateDir, prepared.job.jobId))?.phase).toBe("completed");
    const retry = await result(); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(ack);
  });
  it("worker-recovery R2 conflicting terminal body rejects instead of replacing first receipt", async () => {
    expect((await result()).status).toBe(200); const bytes = await fs.readFile(claimFile());
    const conflict = structuredClone(submission); conflict.delivery.workerCompletedAt += 1;
    conflict.delivery.resultDigest = resultDeliveryDigest(conflict.delivery);
    expect((await result(conflict)).status).toBe(409); expect(await fs.readFile(claimFile())).toEqual(bytes);
  });
  it("worker-recovery R7 receipt write failure cannot ACK or resolve and preserves offered bytes", async () => {
    const bytes = await fs.readFile(claimFile()); const rename = fs.rename; let resolved = false; void caller.then(() => { resolved = true; });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === claimFile() && JSON.parse(await fs.readFile(from, "utf8")).phase === "completed") throw Object.assign(new Error("owned failure"), { code: "EIO" });
      return rename(from, to);
    });
    expect((await result()).status).toBe(503); expect(resolved).toBe(false); expect(await fs.readFile(claimFile())).toEqual(bytes);
  });
  it.each(["missing", "wrong", "revoked", "other-executor"])("worker-recovery R9 %s token cannot record receipt", async kind => {
    let bearer: string | null = token;
    if (kind === "missing") bearer = null;
    if (kind === "wrong") bearer = "jkexec_wrong_credential_12345678901234567890";
    if (kind === "revoked") await revokeExecutorToken(stateDir, "worker");
    if (kind === "other-executor") bearer = await issueExecutorToken(stateDir, "other");
    const bytes = await fs.readFile(claimFile()); expect((await result(submission, bearer)).status).toBe(401);
    expect(await fs.readFile(claimFile())).toEqual(bytes);
  });
  it.each(["capability", "binding", "dispatch", "origin-instance", "origin-root", "courier-instance", "courier-executor", "route-id"])(
    "worker-recovery R9 wrong %s cannot mutate original claim", async field => {
      const changed = JSON.parse(JSON.stringify(submission)) as DurableResultSubmission;
      if (field === "capability") changed.delivery.receiptCapability = "0".repeat(64);
      if (field === "binding") changed.delivery.bindingDigest = "0".repeat(64);
      if (field === "dispatch") changed.delivery.dispatchDigest = "0".repeat(64);
      if (field === "origin-instance") changed.delivery.originRuntime.instanceId = "wrong";
      if (field === "origin-root") changed.delivery.originRuntime.workspaceRoot = path.join(root, "wrong");
      if (field === "courier-instance") changed.courierRuntime.instanceId = "wrong";
      if (field === "courier-executor") changed.courierRuntime.executorId = "other";
      changed.delivery.resultDigest = resultDeliveryDigest(changed.delivery);
      const bytes = await fs.readFile(claimFile());
      expect((await result(changed, token, field === "route-id" ? "00000000-0000-4000-8000-000000000099" : prepared.job.jobId)).status).toBe(404);
      expect(await fs.readFile(claimFile())).toEqual(bytes);
    });
  it.each(["revision", "digest", "target", "owner", "manifest"])("worker-recovery R9 invalid %s protocol rejects", async field => {
    const changed = JSON.parse(JSON.stringify(submission)) as DurableResultSubmission;
    if (field === "digest") changed.delivery.resultDigest = "invalid";
    else Object.assign(changed.delivery, { [field]: "not-in-envelope" });
    const bytes = await fs.readFile(claimFile()); expect((await result(changed)).status).toBe(400);
    expect(await fs.readFile(claimFile())).toEqual(bytes);
  });
  it("worker-recovery R9 well-shaped but incorrect result digest is invalid protocol", async () => {
    const changed = JSON.parse(JSON.stringify(submission)) as DurableResultSubmission;
    changed.delivery.resultDigest = "0".repeat(64);
    const bytes = await fs.readFile(claimFile()); expect((await result(changed)).status).toBe(400);
    expect(await fs.readFile(claimFile())).toEqual(bytes);
  });
  it("worker-recovery R9 unknown claim never creates on POST", async () => {
    const changed = JSON.parse(JSON.stringify(submission)) as DurableResultSubmission; changed.delivery.jobId = "00000000-0000-4000-8000-000000000099";
    changed.delivery.resultDigest = resultDeliveryDigest(changed.delivery);
    expect((await result(changed, token, changed.delivery.jobId)).status).toBe(404);
    await expect(fs.stat(path.join(stateDir, "executors/jobs", `${changed.delivery.jobId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("worker-recovery R9 independent state directory with same worker cannot complete origin claim", async () => {
    const isolated = path.join(root, "other-state");
    const otherApp = express(); otherApp.use(express.json()); registerExecutorRoutes(otherApp, { ...ctx, stateDir: isolated });
    const otherToken = await issueExecutorToken(isolated, "worker");
    await recordExecutorHeartbeat(isolated, heartbeat);
    const otherServer = otherApp.listen(0, "127.0.0.1"); await once(otherServer, "listening", { signal: AbortSignal.timeout(8000) });
    const address = otherServer.address(); if (!address || typeof address === "string") throw new Error("owned socket missing");
    const previous = url; url = `http://127.0.0.1:${address.port}`;
    try {
      const bytes = await fs.readFile(claimFile()); expect((await result(submission, otherToken)).status).toBe(404);
      expect(await fs.readFile(claimFile())).toEqual(bytes);
    } finally {
      url = previous; const closed = once(otherServer, "close", { signal: AbortSignal.timeout(8000) });
      otherServer.closeAllConnections(); otherServer.close(); await closed;
    }
  });
  it("worker-recovery R9 current courier without durable capability rejects", async () => {
    await post("/api/executors/heartbeat", { ...heartbeat, capabilities: heartbeat.capabilities.filter(value => value !== DURABLE_RESULT_CAPABILITY) });
    const bytes = await fs.readFile(claimFile()); expect((await result()).status).toBe(404);
    expect(await fs.readFile(claimFile())).toEqual(bytes);
  });
  it("worker-recovery R7 corrupt saved claim blocks receipt without rewriting bytes", async () => {
    await fs.writeFile(claimFile(), "{truncated");
    expect((await result()).status).toBe(503); expect(await fs.readFile(claimFile(), "utf8")).toBe("{truncated");
  });
  it("worker-recovery R11 concurrent uploads receive one immutable receipt revision", async () => {
    const responses = await Promise.all([result(), result()]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect((await readJobDeliveryClaim(stateDir, prepared.job.jobId))?.revision).toBe(3);
  });
  it("worker-recovery R9 legacy stale origin cannot use durable claim as completion", async () => {
    expect((await result({ identity: { ...heartbeat, instanceId: "stale" }, result: submission.delivery.result })).status).toBe(404);
    expect((await readJobDeliveryClaim(stateDir, prepared.job.jobId))?.phase).toBe("offered");
  });
  it("worker-recovery R4 current courier may carry old origin after target change but cannot poll old claim", async () => {
    const courier = { ...heartbeat, instanceId: "courier", projects: [{ ...heartbeat.projects[0]!, root: path.join(root, "replacement") }] };
    expect((await post("/api/executors/heartbeat", courier)).status).toBe(200);
    submission.courierRuntime = { ...prepared.job.runtime, instanceId: "courier" };
    expect((await result()).status).toBe(200);
    expect((await readJobDeliveryClaim(stateDir, prepared.job.jobId))?.runtime).toEqual(prepared.claim.runtime);
    const poll = await post("/api/executors/worker/poll", { identity: submission.courierRuntime, waitMs: 0 });
    expect(await poll.json()).toEqual({ job: null });
  });
  it("worker-recovery R3 fresh hub process accepts stored origin with empty pending Map and never reconstructs queue", async () => {
    await closeServer();
    const fixture = path.join(root, "hub.mjs");
    await fs.writeFile(fixture, `import express from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("express")).href)};\nimport {registerExecutorRoutes} from ${JSON.stringify(new URL("./http.ts", import.meta.url).href)};\nconst app=express(); app.use(express.json()); registerExecutorRoutes(app,${JSON.stringify(ctx)});\nconst server=app.listen(0,"127.0.0.1",()=>process.send({url:'http://127.0.0.1:'+server.address().port,pid:process.pid}));\nprocess.on('message',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});`);
    child = fork(fixture, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(8000) }) as [{ url: string; pid: number }];
    expect(message.pid).not.toBe(process.pid); url = message.url;
    expect((await post("/api/executors/heartbeat", { ...heartbeat, instanceId: "courier" })).status).toBe(200);
    submission.courierRuntime = { ...prepared.job.runtime, instanceId: "courier" };
    const response = await result(); expect(response.status).toBe(200); const ack = await response.json();
    expect(await (await result()).json()).toEqual(ack);
    expect(await (await post("/api/executors/worker/poll", { identity: submission.courierRuntime, waitMs: 0 })).json()).toEqual({ job: null });
    expect((await readJobDeliveryClaim(stateDir, prepared.job.jobId))?.receipt?.result).toEqual(submission.delivery.result);
  }, 15000);
});
