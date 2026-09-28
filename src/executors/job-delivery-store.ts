import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { acquireMassUlwLock } from "../orchestration/mass-ulw-lock.js";
import {
  DeliveryDigestSchema, DeliveryJobIdSchema, DurableCommandResultSchema, DurableDeliveryOfferSchema,
  DurableExecutionTargetSchema, DurableRuntimeIdentitySchema, DurableResultAckSchema,
  DurableResultEnvelopeSchema, DurableResultSubmissionSchema, MAX_DURABLE_RESULT_WIRE_BYTES,
  sameRuntimeIdentity, type DurableDeliveryOffer, type DurableResultAck, type DurableResultEnvelope,
  type DurableResultSubmission, type RuntimeIdentity,
} from "./target-protocol.js";

export type JobDeliveryErrorReason = "INVALID_RECORD" | "INVALID_ID" | "UNREADABLE" | "CONFLICT"
  | "NOT_FOUND" | "NOT_OFFERED" | "UNAUTHORIZED" | "EXPIRED" | "CAPACITY" | "RESULT_TOO_LARGE" | "LOCKED" | "CLOSED";
export class JobDeliveryError extends Error {
  constructor(readonly reason: JobDeliveryErrorReason, cause?: unknown) {
    super(`Executor delivery blocked: ${reason}`, { cause });
    this.name = "JobDeliveryError";
  }
}
function fail(reason: JobDeliveryErrorReason): never { throw new JobDeliveryError(reason); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new JobDeliveryError("INVALID_RECORD", parsed.error);
  return parsed.data;
}
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function jsonOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonOrder);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, jsonOrder(item)]));
  return value;
}
/** Round-trip first: hashes represent JSON sent over the wire, not JS undefined fields. */
export function normalizeDeliveryJson(value: unknown): string {
  try { return JSON.stringify(jsonOrder(JSON.parse(JSON.stringify(value)))); }
  catch (error) { throw new JobDeliveryError("INVALID_RECORD", error); }
}
export function deliveryDigest(value: unknown): string {
  return createHash("sha256").update(normalizeDeliveryJson(value), "utf8").digest("hex");
}
function capabilityHash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
const boundedText = z.string().min(1).max(8192);
const nullableText = boundedText.nullable();
export const JobDeliveryOwnerBindingSchema = z.object({
  approvedJobId: DeliveryDigestSchema, projectId: boundedText, workSessionId: nullableText,
  goalId: nullableText, loopId: nullableText, taskIdentity: nullableText, approvalId: DeliveryDigestSchema,
  bundleFingerprint: nullableText, jobFingerprint: boundedText, executionKind: z.enum(["local-shell", "command-run"]),
  commandId: nullableText, manifestFingerprint: nullableText,
}).strict();
export type JobDeliveryOwnerBinding = z.infer<typeof JobDeliveryOwnerBindingSchema>;
const toolSchema = z.enum(["local_shell_run", "command_run"]);
const timestamp = z.number().int().nonnegative();
const DispatchSchema = z.object({
  jobId: DeliveryJobIdSchema, tool: toolSchema, runtime: DurableRuntimeIdentitySchema,
  executionTarget: DurableExecutionTargetSchema, payload: z.record(z.unknown()),
}).strict();
export type JobDeliveryDispatch = z.infer<typeof DispatchSchema>;
export function dispatchDeliveryDigest(dispatch: JobDeliveryDispatch): string {
  const { jobId, tool, runtime, executionTarget, payload } = dispatch;
  return deliveryDigest(parse(DispatchSchema, { jobId, tool, runtime, executionTarget, payload }));
}
const ClaimInputSchema = DispatchSchema.extend({
  ownerBinding: JobDeliveryOwnerBindingSchema, createdAt: timestamp, deadlineAt: timestamp,
}).strict();
export type CreateJobDeliveryClaimInput = z.infer<typeof ClaimInputSchema>;
const claimFields = {
  version: z.literal(1), jobId: DeliveryJobIdSchema, tool: toolSchema,
  runtime: DurableRuntimeIdentitySchema, executionTarget: DurableExecutionTargetSchema,
  ownerBinding: JobDeliveryOwnerBindingSchema, createdAt: timestamp, deadlineAt: timestamp,
  dispatchDigest: DeliveryDigestSchema, bindingDigest: DeliveryDigestSchema, receiptCapabilityHash: DeliveryDigestSchema,
};
const ReceiptSchema = z.object({
  resultRevision: z.literal(1), originRuntime: DurableRuntimeIdentitySchema, outcome: z.enum(["returned", "threw"]),
  result: DurableCommandResultSchema.optional(), error: z.string().max(128 * 1024).optional(),
  digest: DeliveryDigestSchema, workerCompletedAt: timestamp, hubRecordedAt: timestamp,
}).strict();
export const JobDeliveryClaimSchema = z.object({
  ...claimFields, phase: z.enum(["prepared", "offered", "completed"]), revision: z.number().int().min(1).max(3),
  offeredAt: timestamp.optional(), receipt: ReceiptSchema.optional(), recordDigest: DeliveryDigestSchema,
}).strict();
export type JobDeliveryClaim = z.infer<typeof JobDeliveryClaimSchema>;
export function bindingDeliveryDigest(value: Omit<z.infer<z.ZodObject<typeof claimFields>>, "bindingDigest">): string {
  const { version, jobId, tool, runtime, executionTarget, ownerBinding, createdAt, deadlineAt, dispatchDigest, receiptCapabilityHash } = value;
  return deliveryDigest({ version, jobId, tool, runtime, executionTarget, ownerBinding, createdAt, deadlineAt, dispatchDigest, receiptCapabilityHash });
}
export function resultDeliveryDigest(value: Omit<DurableResultEnvelope, "resultDigest"> | DurableResultEnvelope): string {
  const { version, jobId, originRuntime, dispatchDigest, bindingDigest, workerCompletedAt, outcome, result, error } = value;
  return deliveryDigest({ version, jobId, originRuntime, dispatchDigest, bindingDigest, workerCompletedAt, outcome, result, error });
}
function seal<T extends object>(value: T): T & { recordDigest: string } { return { ...value, recordDigest: deliveryDigest(value) }; }
function checkSeal(record: { recordDigest: string }): void {
  const { recordDigest, ...body } = record;
  if (recordDigest !== deliveryDigest(body)) fail("INVALID_RECORD");
}
function validateTarget(dispatch: Pick<JobDeliveryDispatch, "runtime" | "executionTarget" | "tool">): void {
  const { runtime, executionTarget: target, tool } = dispatch;
  if (runtime.executorId !== target.executorId || runtime.instanceId !== target.instanceId
    || runtime.workspaceRoot !== target.workspaceRoot || !runtime.capabilities.includes(tool)) fail("INVALID_RECORD");
}
function validateEnvelope(value: unknown): DurableResultEnvelope {
  const envelope = parse(DurableResultEnvelopeSchema, value);
  if (envelope.resultDigest !== resultDeliveryDigest(envelope)) fail("INVALID_RECORD");
  return envelope;
}
function receiptEnvelope(claim: JobDeliveryClaim): DurableResultEnvelope {
  const receipt = claim.receipt!;
  return validateEnvelope({ version: 1, jobId: claim.jobId, originRuntime: receipt.originRuntime,
    dispatchDigest: claim.dispatchDigest, bindingDigest: claim.bindingDigest,
    receiptCapability: "0".repeat(64), workerCompletedAt: receipt.workerCompletedAt,
    outcome: receipt.outcome, result: receipt.result, error: receipt.error, resultDigest: receipt.digest });
}
function validateClaim(value: unknown): JobDeliveryClaim {
  const record = parse(JobDeliveryClaimSchema, value);
  checkSeal(record);
  validateTarget(record);
  if (record.bindingDigest !== bindingDeliveryDigest(record) || record.deadlineAt < record.createdAt
    || record.ownerBinding.projectId !== record.executionTarget.projectId
    || record.ownerBinding.executionKind !== (record.tool === "command_run" ? "command-run" : "local-shell")
    || (record.tool === "command_run" && (!record.ownerBinding.commandId || !record.ownerBinding.manifestFingerprint))) fail("INVALID_RECORD");
  if (record.phase === "prepared") {
    if (record.revision !== 1 || record.offeredAt !== undefined || record.receipt !== undefined) fail("INVALID_RECORD");
  } else {
    if (record.offeredAt === undefined || record.offeredAt > record.deadlineAt) fail("INVALID_RECORD");
    if (record.phase === "offered" ? record.revision !== 2 || record.receipt !== undefined : record.revision !== 3 || !record.receipt) fail("INVALID_RECORD");
  }
  if (record.receipt && (!sameRuntimeIdentity(receiptEnvelope(record).originRuntime, record.runtime)
    || deliveryDigest(record.receipt.originRuntime) !== deliveryDigest(record.runtime))) fail("INVALID_RECORD");
  return record;
}

// A reservation includes worst-case escaping of both bounded result streams.
// Logical reservation is not a filesystem free-space guarantee.
export const MAX_JOB_DELIVERY_RECORD_BYTES = 2 * 1024 * 1024;
export interface JobDeliveryLimits {
  /** Maximum unsettled claims/deliveries, not lifetime retained history. */
  maxRecords?: number;
  /** Active completion reservations plus actual settled-record and orphan-temp bytes. */
  maxBytes?: number;
}
const defaultLimits = { maxRecords: 256, maxBytes: 512 * 1024 * 1024 };
const queues = new Map<string, Promise<void>>();
function keyFor(file: string): string { const key = path.resolve(file); return process.platform === "win32" ? key.toLowerCase() : key; }
async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(key, tail);
  try { return await result; } finally { if (queues.get(key) === tail) queues.delete(key); }
}
async function privateDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) fail("UNREADABLE");
    await fs.chmod(directory, 0o700);
  } catch (error) {
    if (error instanceof JobDeliveryError) throw error;
    throw new JobDeliveryError("UNREADABLE", error);
  }
}
async function lock(file: string): Promise<{ release(): Promise<void> }> {
  try { return await acquireMassUlwLock({ path: file, now: Date.now, lockedMessage: "DELIVERY_LOCKED" }); }
  catch (error) {
    if (error instanceof Error && error.message === "DELIVERY_LOCKED") throw new JobDeliveryError("LOCKED", error);
    throw new JobDeliveryError("UNREADABLE", error);
  }
}
async function locked<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return serial(keyFor(file), async () => {
    await privateDirectory(path.dirname(file));
    const handle = await lock(file);
    try { return await operation(); } finally { await handle.release(); }
  });
}
function idPath(directory: string, jobId: string): string {
  if (!DeliveryJobIdSchema.safeParse(jobId).success) fail("INVALID_ID");
  return path.join(directory, `${jobId}.json`);
}
function claimDirectory(stateDir: string): string { return path.join(stateDir, "executors", "jobs"); }
async function readRecord<T extends { jobId: string }>(directory: string, jobId: string, validate: (value: unknown) => T): Promise<T | null> {
  const file = idPath(directory, jobId);
  let bytes: Buffer;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > MAX_JOB_DELIVERY_RECORD_BYTES) fail("INVALID_RECORD");
    bytes = await fs.readFile(file);
  } catch (error) {
    if (absent(error)) return null;
    if (error instanceof JobDeliveryError) throw error;
    throw new JobDeliveryError("UNREADABLE", error);
  }
  if (!bytes.equals(Buffer.from(bytes.toString("utf8"), "utf8"))) fail("INVALID_RECORD");
  let record: T;
  try { record = validate(JSON.parse(bytes.toString("utf8"))); }
  catch (error) { throw new JobDeliveryError("INVALID_RECORD", error); }
  if (record.jobId !== jobId) fail("INVALID_RECORD");
  return record;
}
async function names(directory: string): Promise<string[]> {
  try { return await fs.readdir(directory); }
  catch (error) { if (absent(error)) return []; throw new JobDeliveryError("UNREADABLE", error); }
}
async function listRecords<T extends { jobId: string }>(directory: string, validate: (value: unknown) => T): Promise<T[]> {
  const records: T[] = [];
  for (const name of (await names(directory)).filter((name) => name.endsWith(".json")).sort()) {
    const record = await readRecord(directory, name.slice(0, -5), validate);
    if (record === null) fail("UNREADABLE");
    records.push(record);
  }
  return records;
}
async function admit<T extends { jobId: string }>(
  directory: string, validate: (value: unknown) => T, limits: JobDeliveryLimits, isSettled: (record: T) => boolean,
): Promise<void> {
  const bound = { ...defaultLimits, ...limits };
  if (!Number.isSafeInteger(bound.maxRecords) || bound.maxRecords < 0 || !Number.isSafeInteger(bound.maxBytes) || bound.maxBytes < 0) fail("CAPACITY");
  const records = await listRecords(directory, validate);
  let pendingRecords = 0;
  let retainedBytes = 0;
  for (const record of records) {
    if (isSettled(record)) {
      try { retainedBytes += (await fs.lstat(idPath(directory, record.jobId))).size; }
      catch (cause) { throw new JobDeliveryError("UNREADABLE", cause); }
    } else pendingRecords++;
  }
  let orphanBytes = 0;
  for (const name of await names(directory)) {
    if (name.endsWith(".tmp")) orphanBytes += (await fs.lstat(path.join(directory, name))).size;
  }
  if (pendingRecords + 1 > bound.maxRecords
    || (pendingRecords + 1) * MAX_JOB_DELIVERY_RECORD_BYTES + retainedBytes + orphanBytes > bound.maxBytes) fail("CAPACITY");
}
async function writeRecord(directory: string, record: { jobId: string }): Promise<void> {
  const final = idPath(directory, record.jobId);
  const bytes = normalizeDeliveryJson(record);
  if (Buffer.byteLength(bytes, "utf8") > MAX_JOB_DELIVERY_RECORD_BYTES) fail("RESULT_TOO_LARGE");
  const temporary = `${final}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, final);
  } catch (error) { if (error instanceof JobDeliveryError) throw error; throw new JobDeliveryError("UNREADABLE", error); }
  finally {
    try { if (handle) await handle.close(); }
    finally {
      if (created) await fs.unlink(temporary).catch((error: unknown) => { if (!absent(error)) throw error; });
    }
  }
}
function claimAccess<T>(stateDir: string, operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = claimDirectory(stateDir);
  // One short namespace lock also makes count/byte admission atomic. Never held for effects or network IO.
  return locked(path.join(directory, ".store.lock"), () => operation(directory));
}
export async function withApprovedJobDeliveryLock<T>(stateDir: string, approvedJobId: string, operation: () => Promise<T>): Promise<T> {
  if (!DeliveryDigestSchema.safeParse(approvedJobId).success) fail("INVALID_ID");
  return locked(path.join(stateDir, "executors", "job-transitions", `${approvedJobId}.lock`), operation);
}
export async function createJobDeliveryClaim(stateDir: string, value: CreateJobDeliveryClaimInput, limits: JobDeliveryLimits = {}): Promise<{ claim: JobDeliveryClaim; delivery: DurableDeliveryOffer }> {
  const input = parse(ClaimInputSchema, JSON.parse(normalizeDeliveryJson(value)));
  validateTarget(input);
  if (Buffer.byteLength(normalizeDeliveryJson(input), "utf8") > MAX_DURABLE_RESULT_WIRE_BYTES) fail("RESULT_TOO_LARGE");
  const receiptCapability = randomBytes(32).toString("hex");
  const { payload: _payload, ...immutable } = input;
  const fields = { ...immutable, version: 1 as const, dispatchDigest: dispatchDeliveryDigest(input), receiptCapabilityHash: capabilityHash(receiptCapability) };
  const claim = validateClaim(seal({ ...fields, bindingDigest: bindingDeliveryDigest(fields), phase: "prepared", revision: 1 }));
  return claimAccess(stateDir, async (directory) => {
    if (await readRecord(directory, input.jobId, validateClaim)) fail("CONFLICT");
    await admit(directory, validateClaim, limits, (record) => record.phase === "completed");
    await writeRecord(directory, claim);
    return { claim, delivery: { version: 1, dispatchDigest: claim.dispatchDigest, bindingDigest: claim.bindingDigest, receiptCapability } };
  });
}
export function readJobDeliveryClaim(stateDir: string, jobId: string): Promise<JobDeliveryClaim | null> {
  return claimAccess(stateDir, (directory) => readRecord(directory, jobId, validateClaim));
}
export function listJobDeliveryClaims(stateDir: string): Promise<JobDeliveryClaim[]> {
  return claimAccess(stateDir, (directory) => listRecords(directory, validateClaim));
}
export function offerJobDeliveryClaim(stateDir: string, jobId: string, bindingDigest: string, now = Date.now()): Promise<JobDeliveryClaim> {
  return claimAccess(stateDir, async (directory) => {
    const claim = await readRecord(directory, jobId, validateClaim);
    if (!claim) fail("NOT_FOUND");
    if (claim.bindingDigest !== bindingDigest) fail("UNAUTHORIZED");
    if (claim.phase !== "prepared") fail("CONFLICT");
    if (now >= claim.deadlineAt) fail("EXPIRED");
    const { recordDigest: _digest, ...body } = claim;
    const offered = validateClaim(seal({ ...body, phase: "offered", revision: 2, offeredAt: now }));
    await writeRecord(directory, offered);
    return offered;
  });
}
function ackFor(claim: JobDeliveryClaim): DurableResultAck {
  return { ok: true, jobId: claim.jobId, bindingDigest: claim.bindingDigest, resultRevision: 1, resultDigest: claim.receipt!.digest };
}
export function recordJobDeliveryReceipt(stateDir: string, value: DurableResultSubmission, authorizedCourier: RuntimeIdentity): Promise<DurableResultAck> {
  return claimAccess(stateDir, async (directory) => {
    const submission = parse(DurableResultSubmissionSchema, value);
    const courier = parse(DurableRuntimeIdentitySchema, authorizedCourier);
    const envelope = validateEnvelope(submission.delivery);
    serializeDurableResultSubmission(envelope, submission.courierRuntime);
    if (!sameRuntimeIdentity(submission.courierRuntime, courier)) fail("UNAUTHORIZED");
    const claim = await readRecord(directory, envelope.jobId, validateClaim);
    if (!claim) fail("NOT_FOUND");
    if (courier.executorId !== claim.runtime.executorId || deliveryDigest(envelope.originRuntime) !== deliveryDigest(claim.runtime)
      || envelope.dispatchDigest !== claim.dispatchDigest || envelope.bindingDigest !== claim.bindingDigest
      || capabilityHash(envelope.receiptCapability) !== claim.receiptCapabilityHash) fail("UNAUTHORIZED");
    if (claim.phase === "prepared") fail("NOT_OFFERED");
    if (claim.receipt) {
      if (normalizeDeliveryJson({ ...envelope, receiptCapability: "0".repeat(64) }) !== normalizeDeliveryJson(receiptEnvelope(claim))) fail("CONFLICT");
      return ackFor(claim);
    }
    const { recordDigest: _digest, ...body } = claim;
    const receipt = { resultRevision: 1 as const, originRuntime: envelope.originRuntime, outcome: envelope.outcome,
      result: envelope.result, error: envelope.error, digest: envelope.resultDigest,
      workerCompletedAt: envelope.workerCompletedAt, hubRecordedAt: Date.now() };
    const completed = validateClaim(seal({ ...body, phase: "completed", revision: 3, receipt }));
    await writeRecord(directory, completed);
    return ackFor(completed);
  });
}

export function normalizeDeliveryHubOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch (error) { throw new JobDeliveryError("INVALID_RECORD", error); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail("INVALID_RECORD");
  // Match worker base-URL normalization, but retain a deployment path to avoid cross-hub retargeting.
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}
const outboxFields = {
  version: z.literal(1), jobId: DeliveryJobIdSchema, hubOrigin: boundedText, tool: toolSchema,
  runtime: DurableRuntimeIdentitySchema, executionTarget: DurableExecutionTargetSchema,
  dispatchDigest: DeliveryDigestSchema, bindingDigest: DeliveryDigestSchema, receiptCapabilityHash: DeliveryDigestSchema,
  recordDigest: DeliveryDigestSchema,
};
export const WorkerDeliveryOutboxRecordSchema = z.discriminatedUnion("state", [
  z.object({ ...outboxFields, state: z.literal("started"), receiptCapability: DeliveryDigestSchema }).strict(),
  z.object({ ...outboxFields, state: z.literal("completed"), receiptCapability: DeliveryDigestSchema,
    envelopeJson: z.string().max(MAX_JOB_DELIVERY_RECORD_BYTES), resultDigest: DeliveryDigestSchema }).strict(),
  z.object({ ...outboxFields, state: z.literal("acknowledged"), resultDigest: DeliveryDigestSchema, resultRevision: z.literal(1) }).strict(),
]);
export type WorkerDeliveryOutboxRecord = z.infer<typeof WorkerDeliveryOutboxRecordSchema>;
function validateOutbox(value: unknown): WorkerDeliveryOutboxRecord {
  const record = parse(WorkerDeliveryOutboxRecordSchema, value);
  checkSeal(record); validateTarget(record);
  if (record.hubOrigin !== normalizeDeliveryHubOrigin(record.hubOrigin)) fail("INVALID_RECORD");
  if (record.state !== "acknowledged" && capabilityHash(record.receiptCapability) !== record.receiptCapabilityHash) fail("INVALID_RECORD");
  if (record.state === "completed") {
    const envelope = validateEnvelope(JSON.parse(record.envelopeJson));
    if (record.envelopeJson !== normalizeDeliveryJson(envelope) || record.resultDigest !== envelope.resultDigest
      || envelope.jobId !== record.jobId || envelope.bindingDigest !== record.bindingDigest || envelope.dispatchDigest !== record.dispatchDigest
      || envelope.receiptCapability !== record.receiptCapability || deliveryDigest(envelope.originRuntime) !== deliveryDigest(record.runtime)) fail("INVALID_RECORD");
  }
  return record;
}
export function serializeDurableResultSubmission(envelope: DurableResultEnvelope, courierRuntime: RuntimeIdentity): string {
  const submission = parse(DurableResultSubmissionSchema, { delivery: validateEnvelope(envelope), courierRuntime });
  const wire = normalizeDeliveryJson(submission);
  if (Buffer.byteLength(wire, "utf8") > MAX_DURABLE_RESULT_WIRE_BYTES) fail("RESULT_TOO_LARGE");
  return wire;
}
export type WorkerDeliverySettlement = { outcome: "returned"; result: z.infer<typeof DurableCommandResultSchema> } | { outcome: "threw"; error: string };
export type WorkerDeliveryStart = JobDeliveryDispatch & { delivery: DurableDeliveryOffer };
export interface WorkerDeliveryOutbox {
  readonly directory: string;
  start(job: WorkerDeliveryStart): Promise<{ record: WorkerDeliveryOutboxRecord; shouldExecute: boolean }>;
  complete(jobId: string, settlement: WorkerDeliverySettlement, workerCompletedAt?: number): Promise<WorkerDeliveryOutboxRecord & { state: "completed" }>;
  read(jobId: string): Promise<WorkerDeliveryOutboxRecord | null>;
  list(): Promise<WorkerDeliveryOutboxRecord[]>;
  acknowledge(jobId: string, ack: unknown): Promise<WorkerDeliveryOutboxRecord>;
  close(): Promise<void>;
}
export async function openWorkerDeliveryOutbox(stateDir: string, hubUrl: string, executorId: string, limits: JobDeliveryLimits = {}): Promise<WorkerDeliveryOutbox> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(executorId)) fail("INVALID_ID");
  const hubOrigin = normalizeDeliveryHubOrigin(hubUrl);
  const directory = path.join(stateDir, "executor-outbox", deliveryDigest([hubOrigin, executorId]));
  await privateDirectory(directory);
  const owner = await lock(path.join(directory, ".owner.lock"));
  let closed = false;
  const validate = (value: unknown) => {
    const record = validateOutbox(value);
    if (record.hubOrigin !== hubOrigin || record.runtime.executorId !== executorId) fail("INVALID_RECORD");
    return record;
  };
  try { await listRecords(directory, validate); } catch (error) { await owner.release(); throw error; }
  const access = <T>(operation: () => Promise<T>) => serial(keyFor(directory), async () => {
    if (closed) fail("CLOSED");
    return operation();
  });
  return {
    directory,
    read: (jobId) => access(() => readRecord(directory, jobId, validate)),
    list: () => access(() => listRecords(directory, validate)),
    start: (job) => access(async () => {
      const dispatch = parse(DispatchSchema, { jobId: job.jobId, tool: job.tool, runtime: job.runtime, executionTarget: job.executionTarget, payload: job.payload });
      const delivery = parse(DurableDeliveryOfferSchema, job.delivery);
      validateTarget(dispatch);
      if (dispatch.runtime.executorId !== executorId || dispatchDeliveryDigest(dispatch) !== delivery.dispatchDigest) fail("UNAUTHORIZED");
      const common = { version: 1 as const, jobId: dispatch.jobId, hubOrigin, tool: dispatch.tool,
        runtime: dispatch.runtime, executionTarget: dispatch.executionTarget, dispatchDigest: delivery.dispatchDigest,
        bindingDigest: delivery.bindingDigest, receiptCapabilityHash: capabilityHash(delivery.receiptCapability) };
      const existing = await readRecord(directory, dispatch.jobId, validate);
      if (existing) {
        for (const key of Object.keys(common) as Array<keyof typeof common>) {
          if (deliveryDigest(existing[key]) !== deliveryDigest(common[key])) fail("CONFLICT");
        }
        return { record: existing, shouldExecute: false };
      }
      await admit(directory, validate, limits, (record) => record.state === "acknowledged");
      const started = validate(seal({ ...common, state: "started", receiptCapability: delivery.receiptCapability }));
      await writeRecord(directory, started);
      return { record: started, shouldExecute: true };
    }),
    complete: (jobId, settlement, workerCompletedAt = Date.now()) => access(async () => {
      const record = await readRecord(directory, jobId, validate);
      if (!record) fail("NOT_FOUND");
      if (record.state !== "started") fail("CONFLICT");
      const body = { version: 1 as const, jobId, originRuntime: record.runtime, dispatchDigest: record.dispatchDigest,
        bindingDigest: record.bindingDigest, receiptCapability: record.receiptCapability, workerCompletedAt, ...settlement };
      const envelope = validateEnvelope(JSON.parse(normalizeDeliveryJson({ ...body, resultDigest: resultDeliveryDigest(body) })));
      const { recordDigest: _digest, ...fields } = record;
      const completed = validate(seal({ ...fields, state: "completed", envelopeJson: normalizeDeliveryJson(envelope), resultDigest: envelope.resultDigest }));
      if (completed.state !== "completed") fail("INVALID_RECORD");
      await writeRecord(directory, completed);
      return completed;
    }),
    acknowledge: (jobId, value) => access(async () => {
      const ack = parse(DurableResultAckSchema, value);
      const record = await readRecord(directory, jobId, validate);
      if (!record) fail("NOT_FOUND");
      if (record.state === "started" || ack.jobId !== jobId || ack.bindingDigest !== record.bindingDigest
        || ack.resultDigest !== record.resultDigest) fail("CONFLICT");
      if (record.state === "acknowledged") return record;
      const { recordDigest: _digest, receiptCapability: _secret, envelopeJson: _envelope, ...fields } = record;
      const acknowledged = validate(seal({ ...fields, state: "acknowledged", resultRevision: ack.resultRevision }));
      await writeRecord(directory, acknowledged);
      return acknowledged;
    }),
    close: () => serial(keyFor(directory), async () => {
      if (!closed) { closed = true; await owner.release(); }
    }),
  };
}
