import { promises as fs } from "node:fs";
import { EventEmitter, once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLocalShell } from "../exec/local-shell.js";
import { listCommands, runCommand } from "../exec/command-runner.js";
import { acknowledgeExecutorControl, completeDurableExecutorJob, completeExecutorJob, dispatchExecutorJob, dispatchPreparedExecutorJob, pollExecutorJob,
  prepareExecutorJobDelivery, recordExecutorHeartbeat, setProjectExecutorRoute, takeExecutorControl,
  type PreparedExecutorJobDelivery, type ExecutorHeartbeat } from "./broker.js";
import { readJobDeliveryClaim, resultDeliveryDigest, type JobDeliveryOwnerBinding } from "./job-delivery-store.js";
import { createRuntimeIdentity, DURABLE_RESULT_CAPABILITY, EXECUTOR_CONTROL_CAPABILITY, type DurableResultEnvelope } from "./target-protocol.js";

let root: string;
let heartbeat: ExecutorHeartbeat;
let jobs: Promise<unknown>[];
const events = new EventEmitter();
const binding: JobDeliveryOwnerBinding = { approvedJobId: "a".repeat(64), approvalId: "b".repeat(64),
  projectId: "fixture", workSessionId: "session", goalId: "goal", loopId: "loop", taskIdentity: "task",
  bundleFingerprint: "bundle", jobFingerprint: "fingerprint", executionKind: "local-shell", commandId: null, manifestFingerprint: null };
function signal(name: string) { return once(events, name, { signal: AbortSignal.timeout(8000) }); }
function timerSignal(_delay: number) {
  const ready = signal("timer");
  const original = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    const timer = original(callback, ms, ...args);
    spy.mockRestore(); events.emit("timer");
    return timer;
  });
  return ready;
}
function prepare(timeout = 10000) { return prepareExecutorJobDelivery(root, "worker", "local_shell_run",
  { sourceProjectId: "fixture", command: "node effect.mjs" }, binding, timeout); }
function dispatch(prepared: PreparedExecutorJobDelivery) {
  const result = dispatchPreparedExecutorJob(root, prepared, { approvedJobId: binding.approvedJobId,
    brokerJobId: prepared.job.jobId, bindingDigest: prepared.claim.bindingDigest });
  const settled = result.then(value => ({ value }), error => ({ error }));
  jobs.push(settled);
  return settled;
}
async function enqueue(prepared: PreparedExecutorJobDelivery) { const ready = timerSignal(10000); const result = dispatch(prepared); await ready; return { result }; }
function gate(phase: string, fail = false) {
  const reached = signal("rename");
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const original = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).includes(`${path.sep}jobs${path.sep}`) && String(to).endsWith(".json")
      && JSON.parse(await fs.readFile(from, "utf8")).phase === phase) {
      events.emit("rename"); await released;
      if (fail) throw Object.assign(new Error("owned write failure"), { code: "EIO" });
    }
    return original(from, to);
  });
  return { reached, release };
}
async function envelope(prepared: PreparedExecutorJobDelivery): Promise<DurableResultEnvelope> {
  const result = await runLocalShell(root, "node effect.mjs");
  const body = { jobId: prepared.job.jobId, originRuntime: prepared.job.runtime,
    ...prepared.job.delivery!, workerCompletedAt: Date.now(), outcome: "returned" as const, result };
  return { ...body, resultDigest: resultDeliveryDigest(body) };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "jk-delivery-BR-broker-")); jobs = [];
  await fs.writeFile(path.join(root, "effect.mjs"), 'import {appendFileSync} from "node:fs"; appendFileSync("effects","one\\n"); console.log("native-result"); process.exitCode=7;');
  heartbeat = { ...await createRuntimeIdentity("worker", root, "worker", ["local_shell_run", DURABLE_RESULT_CAPABILITY]),
    platform: process.platform, projects: [{ projectId: "fixture", name: "fixture", root, aliases: [] }] };
  await recordExecutorHeartbeat(root, heartbeat);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  await recordExecutorHeartbeat(root, { ...heartbeat, instanceId: "cleanup" });
  await Promise.all(jobs);
  await fs.rm(root, { recursive: true, force: true });
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("worker-recovery broker", () => {
  it("delivers restart control without waiting for the serialized job poll", async () => {
    heartbeat = { ...heartbeat, capabilities: [...heartbeat.capabilities, "executor_restart", EXECUTOR_CONTROL_CAPABILITY] };
    await recordExecutorHeartbeat(root, heartbeat);
    const restart = dispatchExecutorJob(root, "worker", "executor_restart", { reason: "recover busy worker" }, 5_000);

    expect(await pollExecutorJob("worker", 0, heartbeat, root)).toBeNull();
    const control = await takeExecutorControl(root, "worker", heartbeat);

    expect(control).toMatchObject({ restart: { reason: "recover busy worker" } });
    expect(acknowledgeExecutorControl(root, "worker", heartbeat, control!.restart!.requestId)).toBe(true);
    await expect(restart).resolves.toMatchObject({ scheduled: true, reason: "recover busy worker", via: "heartbeat-control" });
  });

  it("worker-recovery R7 prepared claim is durable but not executable before linkage", async () => {
    const prepared = await prepare();
    expect(await readJobDeliveryClaim(root, prepared.job.jobId)).toMatchObject({ phase: "prepared", ownerBinding: binding });
    expect(await pollExecutorJob("worker", 0, heartbeat, root)).toBeNull();
  });
  it("worker-recovery R7 failed preparation exposes no executable work", async () => {
    const held = gate("prepared", true);
    const preparation = prepare(); const rejected = expect(preparation).rejects.toMatchObject({ reason: "UNREADABLE" });
    try { await held.reached; held.release(); await rejected; expect(await pollExecutorJob("worker", 0, heartbeat, root)).toBeNull(); }
    finally { held.release(); }
  });
  it("worker-recovery R7 mismatched approved linkage cannot dispatch", async () => {
    const prepared = await prepare();
    await expect(dispatchPreparedExecutorJob(root, prepared, { approvedJobId: "c".repeat(64), brokerJobId: prepared.job.jobId,
      bindingDigest: prepared.claim.bindingDigest })).rejects.toMatchObject({ reason: "UNAUTHORIZED" });
    expect((await readJobDeliveryClaim(root, prepared.job.jobId))?.phase).toBe("prepared");
  });
  it("worker-recovery R6 copied preparation cannot reconstruct executable queues", async () => {
    const prepared = await prepare();
    await expect(dispatchPreparedExecutorJob(root, structuredClone(prepared), { approvedJobId: binding.approvedJobId,
      brokerJobId: prepared.job.jobId, bindingDigest: prepared.claim.bindingDigest })).rejects.toMatchObject({ reason: "UNAUTHORIZED" });
  });
  it.each(["queued", "waiting"])("worker-recovery R7 %s poll commits offered before delivery", async mode => {
    const prepared = await prepare();
    const held = gate("offered"); let delivered = false;
    let polling: ReturnType<typeof pollExecutorJob>;
    try {
      if (mode === "waiting") {
        const ready = timerSignal(20000); polling = pollExecutorJob("worker", 20000, heartbeat, root).then(job => { delivered = true; return job; });
        await ready; dispatch(prepared);
      } else { await enqueue(prepared); polling = pollExecutorJob("worker", 0, heartbeat, root).then(job => { delivered = true; return job; }); }
      await held.reached;
      expect.soft(delivered).toBe(false);
      expect(JSON.parse(await fs.readFile(path.join(root, "executors/jobs", `${prepared.job.jobId}.json`), "utf8")).phase).toBe("prepared");
      held.release();
      expect((await polling)?.delivery).toEqual(prepared.job.delivery);
      expect((await readJobDeliveryClaim(root, prepared.job.jobId))?.phase).toBe("offered");
    } finally { held.release(); }
  });
  it.each(["queued", "waiting"])("worker-recovery R7 %s offer write failure refuses delivery", async mode => {
    const prepared = await prepare(); const held = gate("offered", true);
    try {
      let polling: ReturnType<typeof pollExecutorJob>;
      if (mode === "waiting") { const ready = timerSignal(20000); polling = pollExecutorJob("worker", 20000, heartbeat, root); await ready; dispatch(prepared); }
      else { await enqueue(prepared); polling = pollExecutorJob("worker", 0, heartbeat, root); }
      await held.reached; held.release();
      expect(await polling).toBeNull();
      expect((await readJobDeliveryClaim(root, prepared.job.jobId))?.phase).toBe("prepared");
    } finally { held.release(); }
  });
  it.each(["queued", "waiting"].flatMap(mode => ["instance", "route", "target", "capability"].map(changed => [mode, changed])))(
    "worker-recovery R9 %s rechecks %s after offer persistence", async (mode, changed) => {
    const prepared = await prepare();
    const held = gate("offered");
    let polling: ReturnType<typeof pollExecutorJob>;
    if (mode === "waiting") { const ready = timerSignal(20000); polling = pollExecutorJob("worker", 20000, heartbeat, root); await ready; dispatch(prepared); }
    else { await enqueue(prepared); polling = pollExecutorJob("worker", 0, heartbeat, root); }
    try {
      await held.reached;
      if (changed === "route") await setProjectExecutorRoute(root, "fixture", "local");
      else await recordExecutorHeartbeat(root, { ...heartbeat, ...(changed === "instance" ? { instanceId: "new-worker" }
        : changed === "capability" ? { capabilities: heartbeat.capabilities.filter(value => value !== DURABLE_RESULT_CAPABILITY) }
        : { projects: [{ ...heartbeat.projects[0]!, root: path.join(root, "replacement") }] }) });
      held.release();
      expect(await polling).toBeNull();
      expect((await readJobDeliveryClaim(root, prepared.job.jobId))?.phase).toBe("offered");
      await expect(fs.stat(path.join(root, "effects"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { held.release(); }
  });
  it("worker-recovery R8 queued caller deadline removes executable work but retains preparation", async () => {
    vi.useFakeTimers(); const prepared = await prepare(1000); const ready = timerSignal(1000); const result = dispatch(prepared); await ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ error: { code: "TIMEOUT" } });
    expect(await pollExecutorJob("worker", 0, heartbeat, root)).toBeNull();
    expect((await readJobDeliveryClaim(root, prepared.job.jobId))?.phase).toBe("prepared");
  });
  it("worker-recovery R4 late offered result survives original instance replacement without pending Map", async () => {
    const prepared = await prepare(); await enqueue(prepared); await pollExecutorJob("worker", 0, heartbeat, root);
    const delivery = await envelope(prepared);
    await recordExecutorHeartbeat(root, { ...heartbeat, instanceId: "courier" });
    await expect(completeDurableExecutorJob(root, "worker", prepared.job.jobId, { delivery, courierRuntime: { ...prepared.job.runtime, instanceId: "courier" } }))
      .resolves.toMatchObject({ jobId: prepared.job.jobId, resultRevision: 1, resultDigest: delivery.resultDigest });
    expect(await fs.readFile(path.join(root, "effects"), "utf8")).toBe("one\n");
  });
  it("worker-recovery R8 offered receipt survives actual caller timeout", async () => {
    vi.useFakeTimers();
    const prepared = await prepare(1000); const ready = timerSignal(1000); const result = dispatch(prepared); await ready;
    await pollExecutorJob("worker", 0, heartbeat, root); const delivery = await envelope(prepared);
    await vi.advanceTimersByTimeAsync(1000); expect(await result).toMatchObject({ error: { code: "TIMEOUT" } });
    await expect(completeDurableExecutorJob(root, "worker", prepared.job.jobId, { delivery, courierRuntime: prepared.job.runtime }))
      .resolves.toMatchObject({ jobId: prepared.job.jobId, resultRevision: 1 });
    expect(await pollExecutorJob("worker", 0, heartbeat, root)).toBeNull();
  });
  it("worker-recovery R8 deadline during offer commit refuses delivery", async () => {
    vi.useFakeTimers();
    const prepared = await prepare(1000); const ready = timerSignal(1000); dispatch(prepared); await ready;
    const held = gate("offered"); const polling = pollExecutorJob("worker", 0, heartbeat, root);
    try {
      await held.reached; vi.setSystemTime(prepared.claim.deadlineAt + 1); held.release();
      expect(await polling).toBeNull();
      expect((await readJobDeliveryClaim(root, prepared.job.jobId))?.phase).toBe("offered");
    } finally { held.release(); }
  });
  it("worker-recovery R2 legacy completion cannot bypass durable persistence", async () => {
    const prepared = await prepare(); await enqueue(prepared); await pollExecutorJob("worker", 0, heartbeat, root);
    const delivery = await envelope(prepared);
    expect(completeExecutorJob(prepared.job.jobId, delivery.result, undefined, "worker", heartbeat)).toBe(false);
    expect((await readJobDeliveryClaim(root, prepared.job.jobId))?.phase).toBe("offered");
  });
  it("worker-recovery R2 persist first result before resolving caller", async () => {
    const prepared = await prepare(); const { result } = await enqueue(prepared); await pollExecutorJob("worker", 0, heartbeat, root);
    const delivery = await envelope(prepared); let resolved = false; void result.then(() => { resolved = true; });
    const held = gate("completed");
    const completion = completeDurableExecutorJob(root, "worker", prepared.job.jobId, { delivery, courierRuntime: prepared.job.runtime });
    try {
      await held.reached; expect.soft(resolved).toBe(false); held.release(); await completion;
      expect(await result).toEqual({ value: delivery.result });
      expect((await readJobDeliveryClaim(root, prepared.job.jobId))?.receipt?.result).toEqual(delivery.result);
    } finally { held.release(); }
  });
  it("worker-recovery R12 durable manifest command preserves real nonzero result", async () => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node effect.mjs" } }));
    const command = (await listCommands(root)).find(command => command.commandId === "npm:test");
    if (!command) throw new Error("native manifest command missing");
    await recordExecutorHeartbeat(root, { ...heartbeat, capabilities: [...heartbeat.capabilities, "command_run"] });
    const prepared = await prepareExecutorJobDelivery(root, "worker", "command_run", { sourceProjectId: "fixture", commandId: command.commandId,
      expectedManifestFingerprint: command.manifestFingerprint }, { ...binding, executionKind: "command-run",
      commandId: command.commandId, manifestFingerprint: command.manifestFingerprint }, 10000);
    const { result } = await enqueue(prepared); await pollExecutorJob("worker", 0, prepared.job.runtime, root);
    const output = await runCommand(root, command.commandId, [], 10, command.manifestFingerprint);
    const body = { jobId: prepared.job.jobId, originRuntime: prepared.job.runtime, ...prepared.job.delivery!,
      workerCompletedAt: Date.now(), outcome: "returned" as const, result: output };
    await completeDurableExecutorJob(root, "worker", prepared.job.jobId, { delivery: { ...body, resultDigest: resultDeliveryDigest(body) }, courierRuntime: prepared.job.runtime });
    expect(await result).toMatchObject({ value: { exitCode: 7, outputTruncated: false } });
    expect(await fs.readFile(path.join(root, "effects"), "utf8")).toBe("one\n");
  });
  it("worker-recovery R12 missing durable capability blocks preparation", async () => {
    await recordExecutorHeartbeat(root, { ...heartbeat, capabilities: heartbeat.capabilities.filter(value => value !== DURABLE_RESULT_CAPABILITY) });
    await expect(prepare()).rejects.toMatchObject({ reason: "UNAUTHORIZED" });
  });
});
