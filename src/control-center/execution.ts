import { readFile } from "node:fs/promises";
import path from "node:path";

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
  let verificationStatus: WorkflowVerificationStatus = "unknown";
  let failureCount = 0;

  if (validStateId(snapshot.loopId)) {
    const loop = await readJson(path.join(stateDir, "goals", `${snapshot.loopId}.loop.json`));
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
