import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveMassUlwExecutionId } from "../orchestration/mass-ulw-identity-index.js";
import { MassUlwDocumentSchema } from "../orchestration/mass-ulw-store.js";

export type TaskExecutionMode = "implement" | "debug" | "research" | "review" | "plan";
export type WorkflowPhase = "discover" | "plan" | "patch" | "verify" | "review" | "recovery" | "release";
export type WorkflowStage = "explorer" | "oracle" | "implementer" | "reviewer" | "verifier" | "recovery";
export type WorkflowVerificationStatus = "unknown" | "pass" | "fail" | "blocked";

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

export interface MassUlwExecutionStatus {
  currentWave: number | null;
  runningLanes: string[];
  readonly failedLanes: readonly string[];
  readonly blockedLanes: readonly string[];
  blockedDependencies: string[];
  verification: "not-started" | "in-flight" | "passed" | "failed" | "unknown-after-interruption";
}

export interface TaskExecutionView {
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
    currentWave: document.currentWave,
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
