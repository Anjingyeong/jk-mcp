import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveMassUlwExecutionId } from "../orchestration/mass-ulw-identity-index.js";
import { MassUlwDocumentSchema } from "../orchestration/mass-ulw-store.js";

type TaskExecutionMode = "implement" | "debug" | "research" | "review" | "plan";
type WorkflowPhase = "discover" | "plan" | "patch" | "verify" | "review" | "recovery" | "release";
type WorkflowStage = "explorer" | "oracle" | "implementer" | "reviewer" | "verifier" | "recovery";
type WorkflowVerificationStatus = "unknown" | "pass" | "fail" | "blocked";

export interface TaskExecutionSnapshot {
  projectId: string | null;
  projectName: string | null;
  goalId: string | null;
  loopId: string | null;
  currentGoal: string | null;
  currentTask: string | null;
  lastProgressSummary: string | null;
  completed: string[];
  pending: string[];
  updatedAt: number;
  lastMutation: { at?: number } | null;
  lastVerification: { success?: boolean; at?: number; tool?: string } | null;
}

interface MassUlwExecutionStatus {
  source: "execution" | "plan";
  planState: "fanout" | "sequential" | null;
  recommended: boolean | null;
  rationale: string | null;
  hardBlocks: string[];
  createdAt: number;
  updatedAt: number;
  currentWave: number | null;
  waves: Array<{
    index: number;
    laneIds: string[];
    status: "planned" | "in-flight" | "completed" | "failed";
    completedAt: number | null;
  }>;
  lanes: Array<{
    id: string;
    task: string;
    status: "planned" | "in-flight" | "completed" | "failed" | "blocked";
    dependsOn: string[];
    attempts: number;
    wave: number | null;
    completedAt: number | null;
  }>;
  runningLanes: string[];
  readonly failedLanes: readonly string[];
  readonly blockedLanes: readonly string[];
  blockedDependencies: string[];
  verification: "not-started" | "in-flight" | "passed" | "failed" | "unknown-after-interruption";
}

interface TaskExecutionView {
  projectId: string | null;
  projectName: string | null;
  goal: string | null;
  task: string | null;
  mode: TaskExecutionMode | null;
  modeSource: "loop" | "goal" | "idle";
  phase: WorkflowPhase | null;
  primaryStage: WorkflowStage | null;
  supportingStages: WorkflowStage[];
  massUlw: MassUlwExecutionStatus | null;
  verificationStatus: WorkflowVerificationStatus;
  failureCount: number;
  completedCount: number;
  pendingCount: number;
  lastProgressSummary: string | null;
  updatedAt: number;
  recoveryNeeded: boolean;
  lastVerificationFailed: boolean;
}

const MODES = new Set<TaskExecutionMode>(["implement", "debug", "research", "review", "plan"]);
const PHASES = new Set<WorkflowPhase>(["discover", "plan", "patch", "verify", "review", "recovery", "release"]);
const STAGES = new Set<WorkflowStage>(["explorer", "oracle", "implementer", "reviewer", "verifier", "recovery"]);
const VERIFICATION_STATUSES = new Set<WorkflowVerificationStatus>(["unknown", "pass", "fail", "blocked"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function validStateId(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9_.-]+$/.test(value));
}

function asMode(value: unknown): TaskExecutionMode | null {
  return typeof value === "string" && MODES.has(value as TaskExecutionMode) ? (value as TaskExecutionMode) : null;
}

function asPhase(value: unknown): WorkflowPhase | null {
  return typeof value === "string" && PHASES.has(value as WorkflowPhase) ? (value as WorkflowPhase) : null;
}

function asStage(value: unknown): WorkflowStage | null {
  return typeof value === "string" && STAGES.has(value as WorkflowStage) ? (value as WorkflowStage) : null;
}

function asVerificationStatus(value: unknown): WorkflowVerificationStatus {
  return typeof value === "string" && VERIFICATION_STATUSES.has(value as WorkflowVerificationStatus)
    ? (value as WorkflowVerificationStatus)
    : "unknown";
}

function fallbackWorkflowForMode(mode: TaskExecutionMode | null): { phase: WorkflowPhase | null; primaryStage: WorkflowStage | null } {
  if (mode === "plan") return { phase: "plan", primaryStage: "oracle" };
  if (mode === "review") return { phase: "review", primaryStage: "reviewer" };
  if (mode === "research") return { phase: "discover", primaryStage: "explorer" };
  if (mode === "implement" || mode === "debug") return { phase: "discover", primaryStage: "explorer" };
  return { phase: null, primaryStage: null };
}

async function readJson(target: string): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await readFile(target, "utf8")));
  } catch {
    return null;
  }
}

async function readMassUlwExecutionStatus(
  stateDir: string,
  projectId: string | null,
  loopId: string,
): Promise<MassUlwExecutionStatus | null> {
  const mappedExecutionId = projectId
    ? await resolveMassUlwExecutionId(stateDir, { projectId, externalLoopId: loopId })
    : null;
  const executionId = mappedExecutionId ?? loopId;
  const raw = await readJson(path.join(stateDir, "orchestration", "mass-ulw", `${executionId}.json`));
  const parsed = MassUlwDocumentSchema.safeParse(raw);
  if (!parsed.success || parsed.data.loopId !== executionId) return null;
  const document = parsed.data;
  return {
    source: "execution",
    planState: document.plan.state,
    recommended: document.plan.recommended,
    rationale: document.plan.rationale,
    hardBlocks: [...document.plan.hardBlocks],
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    currentWave: document.currentWave,
    waves: document.waves.map((wave) => ({
      index: wave.index,
      laneIds: [...wave.laneIds],
      status: wave.status,
      completedAt: wave.completedAt ?? null,
    })),
    lanes: document.plan.lanes.map((lane) => {
      const state = document.lanes[lane.id];
      const wave = document.waves.find((candidate) => candidate.laneIds.includes(lane.id));
      return {
        id: lane.id,
        task: lane.task,
        status: state?.status ?? "planned",
        dependsOn: [...lane.dependsOn],
        attempts: state?.attempts ?? 0,
        wave: wave?.index ?? null,
        completedAt: state?.completedAt ?? null,
      };
    }),
    runningLanes: document.plan.lanes
      .filter((lane) => document.lanes[lane.id]?.status === "in-flight")
      .map((lane) => lane.id),
    failedLanes: document.plan.lanes
      .filter((lane) => document.lanes[lane.id]?.status === "failed")
      .map((lane) => lane.id),
    blockedLanes: document.plan.lanes
      .filter((lane) => document.lanes[lane.id]?.status === "blocked")
      .map((lane) => lane.id),
    blockedDependencies: [...new Set(document.plan.lanes.flatMap((lane) => {
      const status = document.lanes[lane.id]?.status;
      return status === "planned" || status === "blocked"
        ? lane.dependsOn.filter((dependencyId) => {
            const dependencyStatus = document.lanes[dependencyId]?.status;
            return dependencyStatus === "failed" || dependencyStatus === "blocked";
          })
        : [];
    }))],
    verification: document.integrationVerification.status,
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function projectMassUlwPlan(orchestration: Record<string, unknown>, updatedAt: number): MassUlwExecutionStatus | null {
  const plan = asRecord(orchestration.massUlw);
  const planState = plan.state === "fanout" || plan.state === "sequential" ? plan.state : null;
  const rawLanes = Array.isArray(plan.lanes) ? plan.lanes : [];
  const rawWaves = Array.isArray(plan.waves) ? plan.waves : [];
  if (!planState || rawLanes.length === 0 || rawWaves.length === 0) return null;

  const waves = rawWaves.map((rawWave, index) => ({
    index,
    laneIds: stringList(rawWave),
    status: "planned" as const,
    completedAt: null,
  })).filter((wave) => wave.laneIds.length > 0);
  if (waves.length === 0) return null;

  const waveByLane = new Map<string, number>();
  for (const wave of waves) for (const laneId of wave.laneIds) waveByLane.set(laneId, wave.index);
  const lanes = rawLanes.map((rawLane) => {
    const lane = asRecord(rawLane);
    if (typeof lane.id !== "string" || lane.id.length === 0 || typeof lane.task !== "string" || lane.task.length === 0) return null;
    return {
      id: lane.id,
      task: lane.task,
      status: "planned" as const,
      dependsOn: stringList(lane.dependsOn),
      attempts: 0,
      wave: waveByLane.get(lane.id) ?? null,
      completedAt: null,
    };
  }).filter((lane): lane is NonNullable<typeof lane> => lane !== null);
  if (lanes.length === 0) return null;

  return {
    source: "plan",
    planState,
    recommended: typeof plan.recommended === "boolean" ? plan.recommended : null,
    rationale: typeof plan.rationale === "string" ? plan.rationale : null,
    hardBlocks: stringList(plan.hardBlocks),
    createdAt: updatedAt,
    updatedAt,
    currentWave: waves[0]?.index ?? null,
    waves,
    lanes,
    runningLanes: [],
    failedLanes: [],
    blockedLanes: [],
    blockedDependencies: [],
    verification: "not-started",
  };
}

function latestOrchestration(loop: Record<string, unknown>): Record<string, unknown> | null {
  const turns = Array.isArray(loop.turns) ? loop.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = asRecord(turns[index]);
    const orchestration = asRecord(turn.orchestration);
    if (Object.keys(orchestration).length > 0) return orchestration;
  }
  return null;
}

function normalizeSupportingStages(orchestration: Record<string, unknown>): WorkflowStage[] {
  const raw = Array.isArray(orchestration.supportingStages)
    ? orchestration.supportingStages
    : Array.isArray(orchestration.supportingRoles)
      ? orchestration.supportingRoles
      : [];
  const result: WorkflowStage[] = [];
  for (const value of raw) {
    const stage = asStage(value);
    if (stage && !result.includes(stage)) result.push(stage);
  }
  return result;
}

export async function readTaskExecutionView(
  stateDir: string,
  snapshot: TaskExecutionSnapshot | null,
): Promise<TaskExecutionView> {
  if (!snapshot) {
    return {
      projectId: null,
      projectName: null,
      goal: null,
      task: null,
      mode: null,
      modeSource: "idle",
      phase: null,
      primaryStage: null,
      supportingStages: [],
      massUlw: null,
      verificationStatus: "unknown",
      failureCount: 0,
      completedCount: 0,
      pendingCount: 0,
      lastProgressSummary: null,
      updatedAt: 0,
      recoveryNeeded: false,
      lastVerificationFailed: false,
    };
  }

  let mode: TaskExecutionMode | null = null;
  let modeSource: TaskExecutionView["modeSource"] = "idle";
  let phase: WorkflowPhase | null = null;
  let primaryStage: WorkflowStage | null = null;
  let supportingStages: WorkflowStage[] = [];
  let massUlw: MassUlwExecutionStatus | null = null;
  let verificationStatus: WorkflowVerificationStatus = "unknown";
  let failureCount = 0;

  if (validStateId(snapshot.loopId)) {
    const [loop, persistedMassUlw] = await Promise.all([
      readJson(path.join(stateDir, "goals", `${snapshot.loopId}.loop.json`)),
      readMassUlwExecutionStatus(stateDir, snapshot.projectId, snapshot.loopId),
    ]);
    massUlw = persistedMassUlw;
    if (loop) {
      mode = asMode(loop.mode);
      if (mode) modeSource = "loop";
      const orchestration = latestOrchestration(loop);
      if (orchestration) {
        massUlw ??= projectMassUlwPlan(orchestration, snapshot.updatedAt);
        phase = asPhase(orchestration.phase);
        primaryStage = asStage(orchestration.primaryStage) ?? asStage(orchestration.primaryRole);
        supportingStages = normalizeSupportingStages(orchestration);
        verificationStatus = asVerificationStatus(orchestration.verificationStatus);
        failureCount = typeof orchestration.failureCount === "number" && Number.isFinite(orchestration.failureCount)
          ? Math.max(0, Math.floor(orchestration.failureCount))
          : 0;
      }
    }
  }

  if (!mode && validStateId(snapshot.goalId)) {
    const goal = await readJson(path.join(stateDir, "goals", `${snapshot.goalId}.json`));
    mode = asMode(goal?.mode);
    if (mode) modeSource = "goal";
  }

  if (!phase || !primaryStage) {
    const fallback = fallbackWorkflowForMode(mode);
    phase ??= fallback.phase;
    primaryStage ??= fallback.primaryStage;
  }

  const recoveryNeeded = phase === "recovery" || primaryStage === "recovery" || verificationStatus === "blocked" || failureCount >= 3;

  return {
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    goal: snapshot.currentGoal,
    task: snapshot.currentTask,
    mode,
    modeSource,
    phase,
    primaryStage,
    supportingStages,
    massUlw,
    verificationStatus,
    failureCount,
    completedCount: snapshot.completed.length,
    pendingCount: snapshot.pending.length,
    lastProgressSummary: snapshot.lastProgressSummary,
    updatedAt: snapshot.updatedAt,
    recoveryNeeded,
    lastVerificationFailed: snapshot.lastVerification?.success === false,
  };
}
