import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { canonicalMassUlwPlanFingerprint, isPortableMassUlwLaneId } from "./mass-ulw-model.js";
import { CommittedPublicationReceiptSchema } from "./mass-ulw-publish-recovery.js";
import type { MassUlwLane, MassUlwPlan } from "./mass-ulw.js";

export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;
export const LOOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

const LaneIdSchema = z.string().trim().min(1).max(80).refine(isPortableMassUlwLaneId, "must be a portable lane id");

const LaneSchema = z.object({
  id: LaneIdSchema,
  task: z.string().trim().min(1).max(500),
  estimatedWeight: z.number().int().min(1).max(5),
  readScopes: z.array(z.string().min(1).max(300)).max(20),
  writeScopes: z.array(z.string().min(1).max(300)).max(20),
  dependsOn: z.array(LaneIdSchema).max(10),
  exclusiveResources: z.array(z.string().min(1).max(120)).max(10),
  latencyBound: z.boolean(),
}).strict() satisfies z.ZodType<MassUlwLane>;

export const PlanSchema = z.object({
  state: z.enum(["fanout", "sequential"]),
  recommended: z.boolean(),
  maxLanes: z.number().int().positive(),
  candidateCount: z.number().int().nonnegative(),
  serialWork: z.number().nonnegative(),
  criticalPathWork: z.number().nonnegative(),
  coordinationCost: z.number().nonnegative(),
  latencyBonus: z.number().nonnegative(),
  coverageBonus: z.number().nonnegative(),
  readParallelBonus: z.number().nonnegative(),
  contextPollutionCost: z.number().nonnegative(),
  threshold: z.number().nonnegative(),
  netGain: z.number(),
  hardBlocks: z.array(z.string()),
  waves: z.array(z.array(z.string().min(1))),
  planFingerprint: z.string().min(1),
  lanes: z.array(LaneSchema),
  rationale: z.string().min(1),
}).strict().superRefine((plan, context) => {
  if (plan.planFingerprint !== canonicalMassUlwPlanFingerprint(plan.lanes)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["planFingerprint"],
      message: "must equal the canonical plan fingerprint",
    });
  }
  const caseFoldedIds = new Set(plan.lanes.map((lane) => lane.id.toLowerCase()));
  if (caseFoldedIds.size !== plan.lanes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lanes"], message: "lane ids must be case-fold unique" });
  }
}) satisfies z.ZodType<MassUlwPlan>;

const AttemptSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["lane", "integration-verification", "publish"]),
  laneId: z.string().min(1).optional(),
  status: z.enum(["in-flight", "completed", "failed", "interrupted"]),
  startedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  fingerprint: z.string().min(1).optional(),
}).strict();

const LaneStateSchema = z.object({
  lane: LaneSchema,
  status: z.enum(["planned", "in-flight", "completed", "failed", "blocked"]),
  attempts: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
}).strict();

const WaveStateSchema = z.object({
  index: z.number().int().nonnegative(),
  laneIds: z.array(z.string().min(1)),
  status: z.enum(["planned", "in-flight", "completed", "failed"]),
  completedAt: z.number().int().nonnegative().optional(),
}).strict();

const IntegrationVerificationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-started") }).strict(),
  z.object({
    status: z.literal("in-flight"),
    attemptId: z.string().min(1),
    fingerprint: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal("passed"),
    attemptId: z.string().min(1),
    fingerprint: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    attemptId: z.string().min(1),
    fingerprint: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal("unknown-after-interruption"),
    attemptId: z.string().min(1),
    fingerprint: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    interruptedAt: z.number().int().nonnegative(),
  }).strict(),
]);

const PublishEntrySchema = z.object({
  id: z.string().min(1),
  fingerprint: z.string().min(1),
  status: z.enum(["in-flight", "published", "failed", "unknown-after-interruption"]),
  attemptId: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  receipt: CommittedPublicationReceiptSchema.optional(),
}).strict();

export const MassUlwDocumentSchema = z.object({
  version: z.literal(1),
  loopId: z.string().regex(LOOP_ID_PATTERN),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  plan: PlanSchema,
  waves: z.array(WaveStateSchema),
  lanes: z.record(z.string(), LaneStateSchema),
  attempts: z.array(AttemptSchema),
  fingerprints: z.object({
    plan: z.string().min(1),
    lanes: z.record(z.string(), z.string().min(1)),
    integration: z.string().min(1).nullable(),
    publish: z.string().min(1).nullable(),
  }).strict(),
  currentWave: z.number().int().nonnegative().nullable(),
  integrationVerification: IntegrationVerificationSchema,
  publishJournal: z.array(PublishEntrySchema),
}).strict().superRefine((document, context) => {
  if (document.fingerprints.plan !== document.plan.planFingerprint) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fingerprints", "plan"], message: "must match the plan fingerprint" });
  }
  if (document.currentWave !== null && document.currentWave >= document.waves.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["currentWave"], message: "must identify a persisted wave" });
  }
  const laneIds = new Set(document.plan.lanes.map((lane) => lane.id));
  for (const [laneId, laneState] of Object.entries(document.lanes)) {
    if (laneState.lane.id !== laneId || !laneIds.has(laneId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["lanes", laneId], message: "must match a lane in the plan" });
    }
  }
});

export const LockFileSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  token: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
}).strict();

export type LockFile = z.infer<typeof LockFileSchema>;
export type MassUlwDocument = z.infer<typeof MassUlwDocumentSchema>;
export type MassUlwAttempt = z.infer<typeof AttemptSchema>;
export type MassUlwLaneState = z.infer<typeof LaneStateSchema>;
export type MassUlwWaveState = z.infer<typeof WaveStateSchema>;
export type MassUlwPublishEntry = z.infer<typeof PublishEntrySchema>;
export type MassUlwLoopLock = { release(): Promise<void> };
export type MassUlwStoreOptions = {
  now?: () => number;
  /** Deterministic concurrency seam used to test stale-lock recovery. */
  onStaleLockObserved?: () => void | Promise<void>;
};
