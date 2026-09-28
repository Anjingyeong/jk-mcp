import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const EXECUTOR_PROTOCOL_VERSION = 1 as const;
export const TARGET_CAPABILITY = "execution-target-v1";
export const RUNTIME_INSTANCE_ID = randomUUID();

// Additive, opt-in transport. Legacy execution-target-v1 semantics are unchanged.
export const DURABLE_RESULT_CAPABILITY = "durable-result-v1";
export const EXECUTOR_CONTROL_CAPABILITY = "executor-control-v1";
export const MAX_DURABLE_RESULT_WIRE_BYTES = 96 * 1024;
export const DeliveryJobIdSchema = z.string().uuid();
export const DeliveryDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const nonempty = z.string().min(1);
const absolutePath = nonempty.refine((value) =>
  !value.includes("\0") && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)), "Expected absolute path");

export const RuntimeIdentitySchema = z.object({
  role: z.enum(["hub", "worker"]),
  protocolVersion: z.literal(EXECUTOR_PROTOCOL_VERSION),
  executorId: nonempty,
  instanceId: nonempty,
  workspaceRoot: absolutePath,
  os: nonempty,
  arch: nonempty,
  appVersion: nonempty.optional(),
  capabilities: z.array(nonempty).refine((items) => items.includes(TARGET_CAPABILITY), "Missing execution target capability"),
});
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

export const ExecutionTargetSchema = z.object({
  kind: z.enum(["local", "remote"]),
  protocolVersion: z.literal(EXECUTOR_PROTOCOL_VERSION),
  executorId: nonempty,
  instanceId: nonempty,
  workspaceRoot: absolutePath,
  projectId: nonempty,
  sourceProjectId: nonempty,
  projectRoot: absolutePath,
}).strict();
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

export const ExecutorControlSchema = z.object({
  restart: z.object({ requestId: z.string().uuid(), reason: z.string().max(240) }).strict().optional(),
  cancelJob: z.object({ jobId: DeliveryJobIdSchema, reason: z.string().max(240) }).strict().optional(),
}).strict();
export type ExecutorControl = z.infer<typeof ExecutorControlSchema>;

export const ExecutorHandshakeSchema = z.object({
  ok: z.literal(true),
  hub: RuntimeIdentitySchema.refine((identity) => identity.role === "hub", "Expected hub role"),
  executor: RuntimeIdentitySchema.refine((identity) => identity.role === "worker", "Expected worker role"),
  control: ExecutorControlSchema.optional(),
});

// Strict derivatives reuse the existing identity/path authority without accepting
// silently stripped fields in a signed/digested delivery envelope.
export const DurableRuntimeIdentitySchema = RuntimeIdentitySchema.strict().refine(
  (identity) => identity.role === "worker" && identity.capabilities.includes(DURABLE_RESULT_CAPABILITY)
    && Buffer.byteLength(JSON.stringify(identity), "utf8") <= 8192,
  "Expected bounded durable worker identity",
);
export const DurableExecutionTargetSchema = ExecutionTargetSchema.refine(
  (target) => target.kind === "remote" && Buffer.byteLength(JSON.stringify(target), "utf8") <= 8192,
  "Expected bounded remote target",
);
export const DurableDeliveryOfferSchema = z.object({
  version: z.literal(1), dispatchDigest: DeliveryDigestSchema, bindingDigest: DeliveryDigestSchema,
  receiptCapability: DeliveryDigestSchema,
}).strict();
export type DurableDeliveryOffer = z.infer<typeof DurableDeliveryOfferSchema>;

export const DurableCommandResultSchema = z.object({
  exitCode: z.number().int(), stdoutSummary: z.string().max(128 * 1024),
  stderrSummary: z.string().max(128 * 1024), durationMs: z.number().finite().nonnegative(),
  outputTruncated: z.boolean(), cwd: z.string().max(8192).optional(),
}).strict();
export const DurableResultEnvelopeSchema = z.object({
  version: z.literal(1), jobId: DeliveryJobIdSchema, originRuntime: DurableRuntimeIdentitySchema,
  dispatchDigest: DeliveryDigestSchema, bindingDigest: DeliveryDigestSchema,
  receiptCapability: DeliveryDigestSchema, workerCompletedAt: z.number().int().nonnegative(),
  outcome: z.enum(["returned", "threw"]), result: DurableCommandResultSchema.optional(),
  error: z.string().max(128 * 1024).optional(), resultDigest: DeliveryDigestSchema,
}).strict().superRefine((value, ctx) => {
  if (value.outcome === "returned" ? value.result === undefined || value.error !== undefined
    : value.error === undefined || value.result !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Outcome does not match terminal envelope" });
  }
});
export type DurableResultEnvelope = z.infer<typeof DurableResultEnvelopeSchema>;
export const DurableResultSubmissionSchema = z.object({
  delivery: DurableResultEnvelopeSchema, courierRuntime: DurableRuntimeIdentitySchema,
}).strict();
export type DurableResultSubmission = z.infer<typeof DurableResultSubmissionSchema>;
export const DurableResultAckSchema = z.object({
  ok: z.literal(true), jobId: DeliveryJobIdSchema, bindingDigest: DeliveryDigestSchema,
  resultRevision: z.literal(1), resultDigest: DeliveryDigestSchema,
}).strict();
export type DurableResultAck = z.infer<typeof DurableResultAckSchema>;

export async function canonicalDirectory(root: string): Promise<string> {
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${root}`);
  return canonical;
}

export async function createRuntimeIdentity(
  role: RuntimeIdentity["role"], workspaceRoot: string, executorId = "local",
  capabilities: string[] = [], instanceId: string = RUNTIME_INSTANCE_ID,
): Promise<RuntimeIdentity> {
  return RuntimeIdentitySchema.parse({
    role, executorId, instanceId, workspaceRoot: await canonicalDirectory(workspaceRoot),
    protocolVersion: EXECUTOR_PROTOCOL_VERSION, os: process.platform, arch: process.arch,
    capabilities: Array.from(new Set([TARGET_CAPABILITY, ...capabilities])),
  });
}

export function sameRuntimeIdentity(a: RuntimeIdentity, b: RuntimeIdentity): boolean {
  return a.role === b.role && a.protocolVersion === b.protocolVersion && a.executorId === b.executorId
    && a.instanceId === b.instanceId && a.workspaceRoot === b.workspaceRoot;
}

export function deriveRemoteExecutionTarget(
  identity: RuntimeIdentity,
  project: { projectId: string; root: string },
  projectId = project.projectId,
): ExecutionTarget {
  RuntimeIdentitySchema.parse(identity);
  if (identity.role !== "worker") throw new Error("Remote target requires worker identity");
  return ExecutionTargetSchema.parse({
    kind: "remote", protocolVersion: identity.protocolVersion, executorId: identity.executorId,
    instanceId: identity.instanceId, workspaceRoot: identity.workspaceRoot,
    projectId, sourceProjectId: project.projectId, projectRoot: project.root,
  });
}

export async function deriveLocalExecutionTarget(
  workspaceRoot: string, project: { projectId: string; root: string },
): Promise<ExecutionTarget> {
  return ExecutionTargetSchema.parse({
    kind: "local", protocolVersion: EXECUTOR_PROTOCOL_VERSION, executorId: "local",
    instanceId: RUNTIME_INSTANCE_ID, workspaceRoot: await canonicalDirectory(workspaceRoot),
    projectId: project.projectId, sourceProjectId: project.projectId,
    projectRoot: await canonicalDirectory(project.root),
  });
}

export function sameExecutionTarget(a: ExecutionTarget, b: ExecutionTarget): boolean {
  return a.kind === b.kind && a.protocolVersion === b.protocolVersion && a.executorId === b.executorId
    && a.instanceId === b.instanceId && a.workspaceRoot === b.workspaceRoot
    && a.projectId === b.projectId && a.sourceProjectId === b.sourceProjectId && a.projectRoot === b.projectRoot;
}
