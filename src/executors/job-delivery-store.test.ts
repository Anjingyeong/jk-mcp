import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLocalShell } from "../exec/local-shell.js";
import {
  createJobDeliveryClaim, deliveryDigest, dispatchDeliveryDigest, MAX_JOB_DELIVERY_RECORD_BYTES,
  normalizeDeliveryJson, normalizeDeliveryHubOrigin, offerJobDeliveryClaim, openWorkerDeliveryOutbox,
  readJobDeliveryClaim, listJobDeliveryClaims, recordJobDeliveryReceipt, resultDeliveryDigest,
  serializeDurableResultSubmission, withApprovedJobDeliveryLock,
  type CreateJobDeliveryClaimInput, type WorkerDeliveryOutbox, type WorkerDeliveryStart,
} from "./job-delivery-store.js";
import {
  createRuntimeIdentity, deriveRemoteExecutionTarget, DURABLE_RESULT_CAPABILITY,
  DurableResultEnvelopeSchema, DurableResultSubmissionSchema,
  type DurableResultEnvelope,
} from "./target-protocol.js";

const exec = promisify(execFile);
const hub = "http://127.0.0.1:32123";
let root: string;
let input: CreateJobDeliveryClaimInput;
let outboxes: WorkerDeliveryOutbox[];
let result: Awaited<ReturnType<typeof runLocalShell>>;
const error = (reason: string) => ({ name: "JobDeliveryError", reason });
const claimPath = (id = input.jobId) => path.join(root, "executors", "jobs", `${id}.json`);
async function box(stateDir = root, limits = {}) {
  const outbox = await openWorkerDeliveryOutbox(stateDir, hub, input.runtime.executorId, limits);
  outboxes.push(outbox);
  return outbox;
}
async function prepared() {
  const { claim, delivery } = await createJobDeliveryClaim(root, input);
  const job: WorkerDeliveryStart = { jobId: input.jobId, tool: input.tool, payload: input.payload,
    runtime: input.runtime, executionTarget: input.executionTarget, delivery };
  return { claim, job };
}
async function completed(offered = true) {
  const { claim, job } = await prepared();
  if (offered) await offerJobDeliveryClaim(root, input.jobId, claim.bindingDigest, input.createdAt);
  const outbox = await box();
  await outbox.start(job);
  const record = await outbox.complete(input.jobId, { outcome: "returned", result }, input.createdAt + 1);
  const envelope = DurableResultEnvelopeSchema.parse(JSON.parse(record.envelopeJson));
  const submission = { delivery: envelope, courierRuntime: input.runtime };
  return { claim, job, outbox, record, envelope, submission };
}
async function bytesUnchanged(file: string, action: () => Promise<unknown>, reason: string) {
  const before = await fs.readFile(file);
  try { await expect(action()).rejects.toMatchObject(error(reason)); }
  finally { expect(await fs.readFile(file)).toEqual(before); }
}
function resign(envelope: DurableResultEnvelope): DurableResultEnvelope {
  return { ...envelope, resultDigest: resultDeliveryDigest(envelope) };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("named filesystem barrier not reached")), 5000);
  })]); } finally { clearTimeout(timer); }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "jk-delivery-S-"));
  outboxes = [];
  await fs.writeFile(path.join(root, "effect.mjs"), 'import {appendFileSync} from "node:fs"; appendFileSync("effects", "one\\n"); console.log("saved-output"); process.exitCode=7;');
  // Real native execution, not a manufactured success/result mock.
  result = await runLocalShell(root, "node effect.mjs");
  const runtime = await createRuntimeIdentity("worker", root, "s-worker", [DURABLE_RESULT_CAPABILITY, "local_shell_run", "command_run"], "original-instance");
  input = { jobId: randomUUID(), tool: "local_shell_run", runtime,
    executionTarget: deriveRemoteExecutionTarget(runtime, {projectId:"p", root}),
    payload: { sourceProjectId:"p", command:"node effect.mjs", optional: undefined },
    ownerBinding: {approvedJobId:"a".repeat(64),projectId:"p",workSessionId:"s",goalId:"g",loopId:"l",taskIdentity:"t",
      approvalId:"b".repeat(64),bundleFingerprint:null,jobFingerprint:"f",executionKind:"local-shell",commandId:null,manifestFingerprint:null},
    createdAt: Date.now(), deadlineAt: Date.now()+60_000 };
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const outbox of outboxes) await outbox.close();
  expect(await fs.readFile(path.join(root, "effects"), "utf8")).toBe("one\n");
  await fs.rm(root, {recursive:true,force:true});
  await expect(fs.stat(root)).rejects.toMatchObject({code:"ENOENT"});
});

describe("worker-recovery R9 normalized strict protocol", () => {
  it("normalizes JSON dispatch before hashing without losing transmitted values", () => {
    const dispatch = {jobId:input.jobId,tool:input.tool,runtime:input.runtime,executionTarget:input.executionTarget,payload:input.payload};
    expect(dispatchDeliveryDigest(dispatch)).toBe(dispatchDeliveryDigest(JSON.parse(JSON.stringify(dispatch))));
    expect(deliveryDigest({b:2,a:[undefined,3],c:undefined})).toBe(deliveryDigest({a:[null,3],b:2}));
    expect(dispatchDeliveryDigest({...dispatch,payload:{...input.payload,command:"different"}})).not.toBe(dispatchDeliveryDigest(dispatch));
  });
  it.each(["unknown-envelope", "unknown-result", "outcome", "revision", "unknown-courier"])("rejects strict wire field %s", async (variant) => {
    const { envelope, submission } = await completed();
    const value = structuredClone(submission) as any;
    if (variant === "unknown-envelope") value.delivery.extra = true;
    if (variant === "unknown-result") value.delivery.result.extra = true;
    if (variant === "outcome") value.delivery.outcome = "threw";
    if (variant === "revision") value.delivery.version = 2;
    if (variant === "unknown-courier") value.courierRuntime.extra = true;
    expect(DurableResultSubmissionSchema.safeParse(value).success).toBe(false);
    expect(DurableResultEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe("worker-recovery R2 R3 immutable hub receipts", () => {
  it("commits one offered receipt and returns byte-identical duplicate ACK after disk reopen", async () => {
    const { submission, claim } = await completed();
    const first = await recordJobDeliveryReceipt(root, submission, input.runtime);
    const saved = await fs.readFile(claimPath());
    const second = await recordJobDeliveryReceipt(root, submission, {...input.runtime,instanceId:"courier-new"}).catch((e) => e);
    expect(second).toMatchObject(error("UNAUTHORIZED"));
    const courier = {...input.runtime,instanceId:"courier-new"};
    expect(await recordJobDeliveryReceipt(root, {...submission,courierRuntime:courier}, courier)).toEqual(first);
    expect(await fs.readFile(claimPath())).toEqual(saved);
    expect(first).toEqual({ok:true,jobId:input.jobId,bindingDigest:claim.bindingDigest,resultRevision:1,resultDigest:submission.delivery.resultDigest});
    expect(saved.toString()).not.toContain(submission.delivery.receiptCapability);
    const moduleUrl = pathToFileURL(fileURLToPath(new URL("./job-delivery-store.ts", import.meta.url))).href;
    const source = `import {readJobDeliveryClaim} from ${JSON.stringify(moduleUrl)}; const r=await readJobDeliveryClaim(${JSON.stringify(root)},${JSON.stringify(input.jobId)}); console.log(r.receipt.digest);`;
    const child = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {timeout:15000});
    expect(child.stdout.trim()).toBe(first.resultDigest);
  });
  it("persists thrown outcome without inventing an exit code", async () => {
    const { claim, job } = await prepared();
    await offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.createdAt);
    const outbox = await box(); await outbox.start(job);
    let thrown: unknown;
    try { await runLocalShell(root,"node effect.mjs", "missing-directory"); } catch (failure) { thrown = failure; }
    expect(thrown).toBeInstanceOf(Error);
    const saved = await outbox.complete(input.jobId,{outcome:"threw",error:(thrown as Error).message});
    const envelope = DurableResultEnvelopeSchema.parse(JSON.parse(saved.envelopeJson));
    await expect(recordJobDeliveryReceipt(root,{delivery:envelope,courierRuntime:input.runtime},input.runtime)).resolves.toMatchObject({resultRevision:1});
    expect((await readJobDeliveryClaim(root,input.jobId))?.receipt).toMatchObject({outcome:"threw",error:(thrown as Error).message});
    expect((await readJobDeliveryClaim(root,input.jobId))?.receipt?.result).toBeUndefined();
  });
  it("rejects a conflicting result without changing accepted bytes", async () => {
    const { submission } = await completed(); await recordJobDeliveryReceipt(root,submission,input.runtime);
    const changed = resign({...submission.delivery,result:{...result,exitCode:0}});
    await bytesUnchanged(claimPath(),() => recordJobDeliveryReceipt(root,{...submission,delivery:changed},input.runtime),"CONFLICT");
  });
  it("does not accept a receipt for a prepared but never offered claim", async () => {
    const { submission } = await completed(false);
    await bytesUnchanged(claimPath(),() => recordJobDeliveryReceipt(root,submission,input.runtime),"NOT_OFFERED");
  });
  it("does not create a claim on unknown result POST", async () => {
    const { submission } = await completed();
    const unknown = resign({...submission.delivery,jobId:randomUUID()});
    await expect(recordJobDeliveryReceipt(root,{...submission,delivery:unknown},input.runtime)).rejects.toMatchObject(error("NOT_FOUND"));
    await expect(fs.stat(claimPath(unknown.jobId))).rejects.toMatchObject({code:"ENOENT"});
  });
  it.each(["capability","binding","dispatch","origin","courier-executor","courier-instance","digest"])("rejects unauthorized %s even on identical retry", async (field) => {
    const { submission } = await completed(); await recordJobDeliveryReceipt(root,submission,input.runtime);
    const changed = structuredClone(submission);
    if (field === "capability") changed.delivery.receiptCapability = "c".repeat(64);
    if (field === "binding") changed.delivery.bindingDigest = "c".repeat(64);
    if (field === "dispatch") changed.delivery.dispatchDigest = "c".repeat(64);
    if (field === "origin") changed.delivery.originRuntime.instanceId = "foreign-origin";
    if (field === "courier-executor") changed.courierRuntime.executorId = "foreign-worker";
    if (field === "courier-instance") changed.courierRuntime.instanceId = "foreign-instance";
    if (field !== "digest") changed.delivery = resign(changed.delivery);
    else changed.delivery.resultDigest = "c".repeat(64);
    await bytesUnchanged(claimPath(),() => recordJobDeliveryReceipt(root,changed,input.runtime),field === "digest" ? "INVALID_RECORD" : "UNAUTHORIZED");
  });
});

describe("worker-recovery R6 R8 nonreplayable offered claims", () => {
  it("never replaces or reoffers an immutable claim", async () => {
    const { claim } = await prepared();
    await bytesUnchanged(claimPath(),() => createJobDeliveryClaim(root,{...input,payload:{command:"changed"}}),"CONFLICT");
    await offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.createdAt);
    await bytesUnchanged(claimPath(),() => offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.createdAt),"CONFLICT");
  });
  it.each([0, 1])("worker-recovery R8 correction rejects an offer at deadline plus %i ms", async (offset) => {
    const { claim } = await prepared();
    await bytesUnchanged(claimPath(),() => offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.deadlineAt+offset),"EXPIRED");
  });
  it("worker-recovery R8 correction accepts an offer one millisecond before deadline", async () => {
    const { claim } = await prepared();
    await expect(offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.deadlineAt-1)).resolves.toMatchObject({phase:"offered"});
  });
  it("accepts an offered historical receipt after its caller deadline", async () => {
    const { submission } = await completed();
    vi.spyOn(Date,"now").mockReturnValue(input.deadlineAt+100000);
    await expect(recordJobDeliveryReceipt(root,submission,input.runtime)).resolves.toMatchObject({resultRevision:1});
  });
});

describe("worker-recovery R7 fail-closed persistent bytes", () => {
  it.each(["hub","worker"])("fails closed on unreadable %s directory", async (which) => {
    const file=path.join(root,which === "hub" ? "executors" : "executor-outbox");
    await fs.writeFile(file,"owned obstruction");
    await bytesUnchanged(file,()=>which === "hub" ? readJobDeliveryClaim(root,input.jobId) : openWorkerDeliveryOutbox(root,hub,input.runtime.executorId),"UNREADABLE");
  });
  it("rejects invalid UTF8 rather than decoding corrupt bytes into an accepted claim", async () => {
    input.ownerBinding.taskIdentity = "replacement-\ufffd";
    await prepared();
    const bytes = await fs.readFile(claimPath());
    const marker = Buffer.from("\ufffd"); const index = bytes.indexOf(marker);
    expect(index).toBeGreaterThan(0);
    await fs.writeFile(claimPath(),Buffer.concat([bytes.subarray(0,index),Buffer.from([0xff]),bytes.subarray(index+marker.length)]));
    await bytesUnchanged(claimPath(),() => readJobDeliveryClaim(root,input.jobId),"INVALID_RECORD");
  });
  it.each(["truncated","wrong-id","owner","target","phase","receipt"])("preserves %s corrupted claim bytes during reads and receipt retry", async (variant) => {
    const { submission } = await completed(); await recordJobDeliveryReceipt(root,submission,input.runtime);
    const record = JSON.parse(await fs.readFile(claimPath(),"utf8"));
    if (variant === "wrong-id") record.jobId = randomUUID();
    if (variant === "owner") record.ownerBinding.loopId = "other-loop";
    if (variant === "target") record.executionTarget.projectRoot += "-changed";
    if (variant === "phase") record.phase = "prepared";
    if (variant === "receipt") record.receipt.result.stdoutSummary = "corrupt";
    await fs.writeFile(claimPath(),variant === "truncated" ? '{"jobId":' : JSON.stringify(record));
    await bytesUnchanged(claimPath(),() => readJobDeliveryClaim(root,input.jobId),"INVALID_RECORD");
    await bytesUnchanged(claimPath(),() => recordJobDeliveryReceipt(root,submission,input.runtime),"INVALID_RECORD");
  });
  it("treats only ENOENT as absence", async () => {
    expect(await readJobDeliveryClaim(root,input.jobId)).toBeNull();
    await fs.mkdir(claimPath());
    await expect(readJobDeliveryClaim(root,input.jobId)).rejects.toMatchObject(error("INVALID_RECORD"));
    expect((await fs.stat(claimPath())).isDirectory()).toBe(true);
  });
  it("rejects path traversal without writing outside authority", async () => {
    await expect(readJobDeliveryClaim(root,"../foreign")).rejects.toMatchObject(error("INVALID_ID"));
    await expect(fs.stat(path.join(root,"executors","foreign.json"))).rejects.toMatchObject({code:"ENOENT"});
  });
  it.each(["prepare","offer","start","complete","ack"])("preserves prior bytes when %s rename fails", async (transition) => {
    let action: () => Promise<unknown>;
    let file = claimPath();
    if (transition === "prepare") action = () => createJobDeliveryClaim(root,input);
    else if (transition === "offer") {
      const { claim } = await prepared(); action = () => offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.createdAt);
    } else if (transition === "ack") {
      const {outbox,submission} = await completed();
      const ack = await recordJobDeliveryReceipt(root,submission,input.runtime);
      file = path.join(outbox.directory,`${input.jobId}.json`); action = () => outbox.acknowledge(input.jobId,ack);
    } else {
      const {job} = await prepared(); const outbox = await box(); file = path.join(outbox.directory,`${input.jobId}.json`);
      if (transition === "start") action = () => outbox.start(job);
      else { await outbox.start(job); action = () => outbox.complete(input.jobId,{outcome:"returned",result}); }
    }
    const before = await fs.readFile(file).catch((e) => { if(e.code === "ENOENT") return null; throw e; });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs,"rename").mockImplementation(async (from,to) => {
      if (String(to) === file) throw Object.assign(new Error("owned rename failure"),{code:"EIO"});
      return rename(from,to);
    });
    await expect(action()).rejects.toMatchObject(error("UNREADABLE"));
    const after = await fs.readFile(file).catch((e) => { if(e.code === "ENOENT") return null; throw e; });
    expect(after).toEqual(before);
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it.each(["writeFile", "sync", "close"] as const)("worker-recovery R7 correction does not publish when owned %s fails", async (operation) => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs,"open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        if (operation === "close") {
          const close = handle.close.bind(handle);
          vi.spyOn(handle,"close").mockImplementationOnce(async () => {
            await close();
            throw Object.assign(new Error("owned close failure"),{code:"EIO"});
          });
        } else vi.spyOn(handle,operation).mockRejectedValueOnce(Object.assign(new Error(`owned ${operation} failure`),{code:"EIO"}));
      }
      return handle;
    });
    await expect(createJobDeliveryClaim(root,input)).rejects.toMatchObject(error("UNREADABLE"));
    await expect(fs.stat(claimPath())).rejects.toMatchObject({code:"ENOENT"});
    expect((await fs.readdir(path.dirname(claimPath()))).filter(name=>name.endsWith(".tmp"))).toEqual([]);
  });
  it.each(["hub", "worker"])("worker-recovery R7 correction preserves a real exclusive-create collision sentinel for %s", async (side) => {
    let action: () => Promise<unknown> = () => createJobDeliveryClaim(root,input);
    if (side === "worker") {
      const {job}=await prepared(); const outbox=await box(); action=()=>outbox.start(job);
    }
    const sentinel=Buffer.from("another writer owns this exact temporary pathname\n");
    let collisionPath: string | undefined;
    const open=fs.open.bind(fs);
    vi.spyOn(fs,"open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".tmp") && args[1] === "wx") {
        collisionPath=String(args[0]);
        const other=await open(...args);
        try { await other.writeFile(sentinel); await other.sync(); } finally { await other.close(); }
      }
      // Actual exclusive open must encounter the real sentinel, not an injected EEXIST.
      return open(...args);
    });
    await expect(action()).rejects.toMatchObject({...error("UNREADABLE"),cause:{code:"EEXIST"}});
    expect(collisionPath).toBeDefined();
    await expect(fs.readFile(collisionPath!)).resolves.toEqual(sentinel);
  });
});

describe("worker-recovery R4 R6 R11 private worker outbox", () => {
  it.each(["started","completed","acknowledged"])("does not grant execution after reopening %s tombstone", async (state) => {
    const {claim,job} = await prepared(); const outbox = await box();
    expect((await outbox.start(job)).shouldExecute).toBe(true);
    if (state !== "started") {
      await offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.createdAt);
      const saved = await outbox.complete(input.jobId,{outcome:"returned",result});
      if (state === "acknowledged") {
        const envelope = DurableResultEnvelopeSchema.parse(JSON.parse(saved.envelopeJson));
        const ack = await recordJobDeliveryReceipt(root,{delivery:envelope,courierRuntime:input.runtime},input.runtime);
        await outbox.acknowledge(input.jobId,ack);
      }
    }
    const before = await fs.readFile(path.join(outbox.directory,`${input.jobId}.json`));
    await outbox.close(); const reopened = await box();
    expect((await reopened.start(job)).shouldExecute).toBe(false);
    expect((await reopened.read(input.jobId))?.state).toBe(state);
    expect(await fs.readFile(path.join(reopened.directory,`${input.jobId}.json`))).toEqual(before);
    if (state === "acknowledged") expect(before.toString()).not.toContain(job.delivery.receiptCapability);
  });
  it("refuses altered same-ID dispatch and keeps start bytes", async () => {
    const {job} = await prepared(); const outbox = await box(); await outbox.start(job);
    const changed = {...job,payload:{command:"changed"}};
    changed.delivery = {...job.delivery,dispatchDigest:dispatchDeliveryDigest(changed)};
    await bytesUnchanged(path.join(outbox.directory,`${input.jobId}.json`),() => outbox.start(changed),"CONFLICT");
  });
  it.each(["bare-200","wrong-job","wrong-binding","wrong-digest","wrong-revision"])("retains completed result on %s ACK", async (variant) => {
    const {outbox,submission} = await completed();
    const ack: any = await recordJobDeliveryReceipt(root,submission,input.runtime);
    if (variant === "bare-200") { for (const key of Object.keys(ack)) delete ack[key]; ack.ok=true; }
    if (variant === "wrong-job") ack.jobId=randomUUID();
    if (variant === "wrong-binding") ack.bindingDigest="d".repeat(64);
    if (variant === "wrong-digest") ack.resultDigest="d".repeat(64);
    if (variant === "wrong-revision") ack.resultRevision=2;
    await bytesUnchanged(path.join(outbox.directory,`${input.jobId}.json`),() => outbox.acknowledge(input.jobId,ack),
      variant === "bare-200" || variant === "wrong-revision" ? "INVALID_RECORD" : "CONFLICT");
  });
  it("validates actual saved envelope before compacting for a valid ACK", async () => {
    const {outbox,submission} = await completed(); const ack = await recordJobDeliveryReceipt(root,submission,input.runtime);
    const file = path.join(outbox.directory,`${input.jobId}.json`); const record = JSON.parse(await fs.readFile(file,"utf8"));
    const envelope = JSON.parse(record.envelopeJson); envelope.result.stdoutSummary="tampered";
    record.envelopeJson=normalizeDeliveryJson(envelope);
    const {recordDigest:_digest,...body}=record; record.recordDigest=deliveryDigest(body);
    await fs.writeFile(file,JSON.stringify(record));
    await bytesUnchanged(file,() => outbox.acknowledge(input.jobId,ack),"INVALID_RECORD");
  });
  it("keeps oversized serialized output privately rather than truncating for HTTP", async () => {
    await fs.writeFile(path.join(root,"large.mjs"),'process.stdout.write(String.fromCharCode(1).repeat(18000));');
    const large = await runLocalShell(root,"node large.mjs");
    const {job} = await prepared(); const outbox = await box(); await outbox.start(job);
    const saved = await outbox.complete(input.jobId,{outcome:"returned",result:large});
    const envelope = DurableResultEnvelopeSchema.parse(JSON.parse(saved.envelopeJson));
    expect(envelope.result).toEqual(large);
    const file = path.join(outbox.directory,`${input.jobId}.json`); const before = await fs.readFile(file);
    expect(() => serializeDurableResultSubmission(envelope,input.runtime)).toThrowError(expect.objectContaining(error("RESULT_TOO_LARGE")));
    expect(await fs.readFile(file)).toEqual(before);
    await outbox.close(); const reopened = await box();
    expect((await reopened.read(input.jobId))?.state).toBe("completed");
  });
  it("rejects oversized receipt at the hub boundary without changing offered bytes", async () => {
    await fs.writeFile(path.join(root,"large.mjs"),'process.stdout.write(String.fromCharCode(1).repeat(18000));');
    const large = await runLocalShell(root,"node large.mjs");
    const {claim,job} = await prepared();
    await offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.createdAt);
    const outbox=await box();await outbox.start(job);
    const saved=await outbox.complete(input.jobId,{outcome:"returned",result:large});
    const envelope=DurableResultEnvelopeSchema.parse(JSON.parse(saved.envelopeJson));
    await bytesUnchanged(claimPath(),()=>recordJobDeliveryReceipt(root,{delivery:envelope,courierRuntime:input.runtime},input.runtime),"RESULT_TOO_LARGE");
  });
  it("validates full wire JSON while preserving a bounded result", async () => {
    const {envelope} = await completed(); const wire=serializeDurableResultSubmission(envelope,input.runtime);
    expect(DurableResultSubmissionSchema.parse(JSON.parse(wire)).delivery).toEqual(envelope);
    expect(envelope.result?.exitCode).toBe(7); expect(envelope.result?.outputTruncated).toBe(false);
    expect(envelope.result?.cwd).toBe(".");
  });
  it("refuses a second live namespace owner without stealing its lock", async () => {
    const outbox = await box(); const file=path.join(outbox.directory,".owner.lock"); const before=await fs.readFile(file);
    await expect(openWorkerDeliveryOutbox(root,hub,input.runtime.executorId)).rejects.toMatchObject(error("LOCKED"));
    expect(await fs.readFile(file)).toEqual(before);
    await outbox.close(); await expect(fs.stat(file)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("isolates hub namespaces and normalizes only equivalent base URLs", async () => {
    const {job} = await prepared(); const a=await box(); await a.start(job);
    expect(normalizeDeliveryHubOrigin(hub+"/mcp/?ignored=1")).toBe(hub);
    const other=await openWorkerDeliveryOutbox(root,hub+"/other",input.runtime.executorId); outboxes.push(other);
    expect(await other.list()).toEqual([]); expect(other.directory).not.toBe(a.directory);
    await fs.copyFile(path.join(a.directory,`${input.jobId}.json`),path.join(other.directory,`${input.jobId}.json`));
    await expect(other.read(input.jobId)).rejects.toMatchObject(error("INVALID_RECORD"));
  });
  it("blocks admission on corrupted existing outbox and releases failed-open ownership", async () => {
    const {outbox} = await completed(); const file=path.join(outbox.directory,`${input.jobId}.json`);
    await outbox.close(); await fs.writeFile(file,"broken");
    await bytesUnchanged(file,() => openWorkerDeliveryOutbox(root,hub,input.runtime.executorId),"INVALID_RECORD");
    await expect(fs.stat(path.join(outbox.directory,".owner.lock"))).rejects.toMatchObject({code:"ENOENT"});
  });
  it.each(["hub-count","hub-bytes","worker-count","worker-bytes"])("reserves completion capacity before %s admission", async (variant) => {
    const limits = variant.endsWith("count") ? {maxRecords:0} : {maxBytes:MAX_JOB_DELIVERY_RECORD_BYTES-1};
    if (variant.startsWith("hub")) {
      await expect(createJobDeliveryClaim(root,input,limits)).rejects.toMatchObject(error("CAPACITY"));
      await expect(fs.stat(claimPath())).rejects.toMatchObject({code:"ENOENT"});
    } else {
      const {job}=await prepared(); const outbox=await box(root,limits);
      await expect(outbox.start(job)).rejects.toMatchObject(error("CAPACITY"));
      expect(await outbox.list()).toEqual([]);
    }
  });
  it.each(["hub-count", "hub-bytes", "worker-count", "worker-bytes"])("worker-recovery R11 correction releases settled reservation for %s without replacing history", async (variant) => {
    const {outbox,submission,job}=await completed(); const ack=await recordJobDeliveryReceipt(root,submission,input.runtime);
    await outbox.acknowledge(input.jobId,ack);
    const file=variant.startsWith("hub") ? claimPath() : path.join(outbox.directory,`${input.jobId}.json`);
    const saved=await fs.readFile(file);
    // Valid persisted whitespace must count too: charge actual file bytes, not reserialized fields.
    const retained=Buffer.concat([saved,Buffer.from("\n".repeat(257))]); await fs.writeFile(file,retained);
    const limits=variant.endsWith("count") ? {maxRecords:1} : {maxRecords:10,maxBytes:MAX_JOB_DELIVERY_RECORD_BYTES+retained.length};
    const next={...input,jobId:randomUUID()};
    if (variant.startsWith("hub")) {
      await expect(createJobDeliveryClaim(root,next,limits)).resolves.toMatchObject({claim:{phase:"prepared"}});
    } else {
      await outbox.close(); const reopened=await box(root,limits);
      const {delivery}=await createJobDeliveryClaim(root,next);
      await expect(reopened.start({...next,delivery})).resolves.toMatchObject({shouldExecute:true});
      expect((await reopened.start(job)).shouldExecute).toBe(false);
    }
    expect(await fs.readFile(file)).toEqual(retained);
    expect(await recordJobDeliveryReceipt(root,submission,input.runtime)).toEqual(ack);
    expect(await fs.readFile(file)).toEqual(retained);
  });
  it.each(["hub", "worker"])("worker-recovery R11 correction blocks %s when retained actual bytes leave no new reservation", async (side) => {
    const {outbox,submission,job}=await completed(); const ack=await recordJobDeliveryReceipt(root,submission,input.runtime);
    await outbox.acknowledge(input.jobId,ack);
    const file=side === "hub" ? claimPath() : path.join(outbox.directory,`${input.jobId}.json`);
    const retained=Buffer.concat([await fs.readFile(file),Buffer.from("\n".repeat(257))]); await fs.writeFile(file,retained);
    const limits={maxRecords:10,maxBytes:MAX_JOB_DELIVERY_RECORD_BYTES+retained.length-1};
    const next={...input,jobId:randomUUID()};
    if (side === "hub") await expect(createJobDeliveryClaim(root,next,limits)).rejects.toMatchObject(error("CAPACITY"));
    else {
      await outbox.close(); const reopened=await box(root,limits); const {delivery}=await createJobDeliveryClaim(root,next);
      await expect(reopened.start({...next,delivery})).rejects.toMatchObject(error("CAPACITY"));
      expect((await reopened.start(job)).shouldExecute).toBe(false);
    }
    expect(await fs.readFile(file)).toEqual(retained);
  });
  it.each(["prepared", "offered", "started", "completed"])("worker-recovery R11 correction keeps %s backlog in the active count", async (state) => {
    const {claim,job}=await prepared();
    const worker=state === "started" || state === "completed";
    const outbox=worker ? await box(root,{maxRecords:1}) : undefined;
    if (state === "offered") await offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.createdAt);
    if (outbox) {
      await outbox.start(job);
      if (state === "completed") await outbox.complete(input.jobId,{outcome:"returned",result});
    }
    const file=outbox ? path.join(outbox.directory,`${input.jobId}.json`) : claimPath();
    const before=await fs.readFile(file); const next={...input,jobId:randomUUID()};
    if (outbox) {
      const {delivery}=await createJobDeliveryClaim(root,next);
      await expect(outbox.start({...next,delivery})).rejects.toMatchObject(error("CAPACITY"));
      expect((await outbox.start(job)).shouldExecute).toBe(false);
    } else await expect(createJobDeliveryClaim(root,next,{maxRecords:1})).rejects.toMatchObject(error("CAPACITY"));
    expect(await fs.readFile(file)).toEqual(before);
  });
  it.each(["hub", "worker"])("worker-recovery R11 correction keeps full %s backlog reservation under the byte cap", async (side) => {
    const {job}=await prepared(); const limits={maxRecords:10,maxBytes:2*MAX_JOB_DELIVERY_RECORD_BYTES-1};
    const next={...input,jobId:randomUUID()};
    if (side === "hub") await expect(createJobDeliveryClaim(root,next,limits)).rejects.toMatchObject(error("CAPACITY"));
    else {
      const outbox=await box(root,limits); await outbox.start(job); const {delivery}=await createJobDeliveryClaim(root,next);
      await expect(outbox.start({...next,delivery})).rejects.toMatchObject(error("CAPACITY"));
      expect((await outbox.list()).map(record=>record.state)).toEqual(["started"]);
    }
  });
  it("worker-recovery R11 correction permits sequential native completions beyond the active-job limit without replay", async () => {
    await fs.writeFile(path.join(root,"sequential.mjs"),'import {appendFileSync} from "node:fs"; appendFileSync("sequential-effects", "once\\n"); console.log("sequential-result");');
    const limits={maxRecords:1,maxBytes:MAX_JOB_DELIVERY_RECORD_BYTES+64*1024};
    const outbox=await box(root,limits);
    const history: Array<{job:WorkerDeliveryStart;hubBytes:Buffer;workerBytes:Buffer}>=[];
    for (let index=0;index<3;index++) {
      const next={...input,jobId:randomUUID(),payload:{...input.payload,command:"node sequential.mjs"}};
      const pending=createJobDeliveryClaim(root,next,limits);
      await expect(pending).resolves.toMatchObject({claim:{phase:"prepared"}});
      const {claim,delivery}=await pending; const job={...next,delivery};
      await offerJobDeliveryClaim(root,next.jobId,claim.bindingDigest,input.createdAt);
      await expect(outbox.start(job)).resolves.toMatchObject({shouldExecute:true});
      const native=await runLocalShell(root,"node sequential.mjs");
      const saved=await outbox.complete(next.jobId,{outcome:"returned",result:native});
      const envelope=DurableResultEnvelopeSchema.parse(JSON.parse(saved.envelopeJson));
      const ack=await recordJobDeliveryReceipt(root,{delivery:envelope,courierRuntime:input.runtime},input.runtime);
      await outbox.acknowledge(next.jobId,ack);
      history.push({job,hubBytes:await fs.readFile(claimPath(next.jobId)),workerBytes:await fs.readFile(path.join(outbox.directory,`${next.jobId}.json`))});
    }
    await outbox.close(); const reopened=await box(root,limits);
    for (const saved of history) {
      expect((await reopened.start(saved.job)).shouldExecute).toBe(false);
      expect(await fs.readFile(claimPath(saved.job.jobId))).toEqual(saved.hubBytes);
      expect(await fs.readFile(path.join(reopened.directory,`${saved.job.jobId}.json`))).toEqual(saved.workerBytes);
    }
    expect(await fs.readFile(path.join(root,"sequential-effects"),"utf8")).toBe("once\n".repeat(3));
  });
  it("serializes same-state readers behind actual rename while another directory progresses", async () => {
    const {claim}=await prepared(); const entered=signal(); const release=signal(); const readerDone=signal();
    const rename=fs.rename.bind(fs); let readerSettled=false;
    vi.spyOn(fs,"rename").mockImplementation(async (from,to) => {
      if(String(to)===claimPath()) { entered.resolve(); await bounded(release.promise); }
      await rename(from,to);
    });
    const offered=offerJobDeliveryClaim(root,input.jobId,claim.bindingDigest,input.createdAt);
    await bounded(entered.promise);
    const read=readJobDeliveryClaim(root,input.jobId).finally(()=>{readerSettled=true;readerDone.resolve();});
    try {
      const independent=await createJobDeliveryClaim(path.join(root,"independent"),{...input,jobId:randomUUID()});
      expect(independent.claim.phase).toBe("prepared"); expect(readerSettled).toBe(false);
    } finally { release.resolve(); }
    await offered; await bounded(readerDone.promise); expect((await read)?.phase).toBe("offered");
  });
  it("serializes duplicate receipt uploads into one immutable revision", async () => {
    const {submission}=await completed();
    const uploads=await Promise.allSettled(Array.from({length:5},()=>recordJobDeliveryReceipt(root,submission,input.runtime)));
    expect(uploads.map(upload=>upload.status)).toEqual(Array(5).fill("fulfilled"));
    const acks=uploads.flatMap(upload=>upload.status === "fulfilled" ? [upload.value] : []);
    expect(acks.every(ack=>normalizeDeliveryJson(ack)===normalizeDeliveryJson(acks[0]))).toBe(true);
    expect((await listJobDeliveryClaims(root))[0]?.revision).toBe(3);
  });
  it("uses approved-job transition lock and releases after failure", async () => {
    const entered=signal();const release=signal(); const order:string[]=[];
    const first=withApprovedJobDeliveryLock(root,input.ownerBinding.approvedJobId,async()=>{order.push("first");entered.resolve();await bounded(release.promise);});
    await bounded(entered.promise);
    const second=withApprovedJobDeliveryLock(root,input.ownerBinding.approvedJobId,async()=>{order.push("second");});
    try { await withApprovedJobDeliveryLock(root,"c".repeat(64),async()=>{order.push("independent");}); }
    finally { release.resolve(); }
    await Promise.all([first,second]);expect(order).toEqual(["first","independent","second"]);
    await expect(withApprovedJobDeliveryLock(root,input.ownerBinding.approvedJobId,async()=>{throw new Error("owned");})).rejects.toThrow("owned");
    await expect(withApprovedJobDeliveryLock(root,input.ownerBinding.approvedJobId,async()=>42)).resolves.toBe(42);
  });
});
