export type TaskExecutionKind = "workspace" | "live-runtime" | "release-deploy";
export type TaskSafetyGateStatus = "unknown" | "pass" | "fail" | "not-required";

export interface TaskExecutionTarget {
  machine: string | null;
  projectRoot: string | null;
  branch: string | null;
  dirty: boolean | null;
  runtimeTarget: string | null;
}

export interface TaskExecutionSafety {
  executionKind: TaskExecutionKind;
  preflightStatus: TaskSafetyGateStatus;
  preflightEvidence: string[];
  executionTarget: TaskExecutionTarget;
  approvalPlan: string[];
  rollbackStatus: TaskSafetyGateStatus;
  releaseCollisionStatus: TaskSafetyGateStatus;
  runtimeProofStatus: TaskSafetyGateStatus;
  runtimeProofEvidence: string[];
  operationalDrift: string[];
}

export interface TaskSafetyGate {
  approvalReady: boolean;
  terminalReady: boolean;
  approvalBlockers: string[];
  terminalBlockers: string[];
}

const NON_WORKSPACE_ORDER: Record<TaskExecutionKind, number> = {
  workspace: 0,
  "live-runtime": 1,
  "release-deploy": 2,
};

export function makeDefaultTaskSafety(kind: TaskExecutionKind = "workspace"): TaskExecutionSafety {
  const workspace = kind === "workspace";
  return {
    executionKind: kind,
    preflightStatus: workspace ? "not-required" : "unknown",
    preflightEvidence: [],
    executionTarget: {
      machine: null,
      projectRoot: null,
      branch: null,
      dirty: null,
      runtimeTarget: null,
    },
    approvalPlan: [],
    rollbackStatus: workspace ? "not-required" : "unknown",
    releaseCollisionStatus: kind === "release-deploy" ? "unknown" : "not-required",
    runtimeProofStatus: workspace ? "not-required" : "unknown",
    runtimeProofEvidence: [],
    operationalDrift: [],
  };
}

export function strongerExecutionKind(left: TaskExecutionKind, right: TaskExecutionKind): TaskExecutionKind {
  return NON_WORKSPACE_ORDER[right] > NON_WORKSPACE_ORDER[left] ? right : left;
}

function cleanList(values: string[] | undefined, maxItems: number): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value.trim().slice(0, 2000);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

export function mergeTaskSafety(
  previous: TaskExecutionSafety | null | undefined,
  update: Partial<TaskExecutionSafety> | null | undefined,
  inferredKind: TaskExecutionKind = "workspace",
): TaskExecutionSafety {
  const base = previous ?? makeDefaultTaskSafety(inferredKind);
  const requestedKind = update?.executionKind ?? inferredKind;
  const kind = strongerExecutionKind(base.executionKind, strongerExecutionKind(inferredKind, requestedKind));
  const defaults = makeDefaultTaskSafety(kind);
  const escalated = NON_WORKSPACE_ORDER[kind] > NON_WORKSPACE_ORDER[base.executionKind];
  const targetUpdate = update?.executionTarget;
  const merged: TaskExecutionSafety = {
    ...defaults,
    ...base,
    ...update,
    executionKind: kind,
    executionTarget: {
      ...defaults.executionTarget,
      ...base.executionTarget,
      ...targetUpdate,
    },
    preflightEvidence: update?.preflightEvidence === undefined ? base.preflightEvidence : cleanList(update.preflightEvidence, 30),
    approvalPlan: update?.approvalPlan === undefined ? base.approvalPlan : cleanList(update.approvalPlan, 20),
    runtimeProofEvidence: update?.runtimeProofEvidence === undefined ? base.runtimeProofEvidence : cleanList(update.runtimeProofEvidence, 30),
    operationalDrift: update?.operationalDrift === undefined ? base.operationalDrift : cleanList(update.operationalDrift, 30),
  };
  if (escalated) {
    if (update?.preflightStatus === undefined) merged.preflightStatus = defaults.preflightStatus;
    if (update?.rollbackStatus === undefined) merged.rollbackStatus = defaults.rollbackStatus;
    if (update?.releaseCollisionStatus === undefined) merged.releaseCollisionStatus = defaults.releaseCollisionStatus;
    if (update?.runtimeProofStatus === undefined) merged.runtimeProofStatus = defaults.runtimeProofStatus;
  }
  if (kind !== "release-deploy" && merged.releaseCollisionStatus === "unknown") merged.releaseCollisionStatus = "not-required";
  return merged;
}

export function inferTaskExecutionKind(text: string): TaskExecutionKind {
  const value = text.toLowerCase();
  if (
    /\b(?:wrangler\s+deploy|gh\s+release\s+upload|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish)\b/u.test(value) ||
    /\b(?:deploy|publish|release)\s+(?:the\s+)?(?:app|site|worker|package|release|build|service)\b/u.test(value) ||
    /(?:배포해|배포하|배포까지|업로드해|업로드하|릴리스해|릴리스하)/u.test(text)
  ) return "release-deploy";
  if (
    /\b(?:systemctl\s+(?:restart|reload)|restart|reload)\s+(?:the\s+)?(?:jk|runtime|service|server|process)\b/u.test(value) ||
    /(?:재시작해|재시작하|런타임\s*재시작|서비스\s*재시작)/u.test(text)
  ) return "live-runtime";
  return "workspace";
}

export function inferCommandExecutionKind(command: string): TaskExecutionKind {
  const value = command.toLowerCase();
  if (/(?:^|[\\/])reload-jk-runtime\.(?:sh|ps1)(?:\s|$)/u.test(value) && /(?:^|\s)--check(?:\s|$)/u.test(value)) {
    return "workspace";
  }
  if (/\b(?:wrangler\s+deploy|gh\s+release\s+upload|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish)\b/u.test(value)) {
    return "release-deploy";
  }
  if (/\bsystemctl\s+(?:restart|reload)\b/u.test(value) || /(?:^|[\\/])reload-jk-runtime\.(?:sh|ps1)(?:\s|$)/u.test(value)) {
    return "live-runtime";
  }
  return "workspace";
}

function targetComplete(target: TaskExecutionTarget): boolean {
  return Boolean(
    target.machine?.trim() &&
    target.projectRoot?.trim() &&
    target.branch?.trim() &&
    typeof target.dirty === "boolean" &&
    target.runtimeTarget?.trim(),
  );
}

function passedOrNotRequired(status: TaskSafetyGateStatus): boolean {
  return status === "pass" || status === "not-required";
}

export function buildTaskSafetyGate(safety: TaskExecutionSafety): TaskSafetyGate {
  if (safety.executionKind === "workspace") {
    return { approvalReady: true, terminalReady: true, approvalBlockers: [], terminalBlockers: [] };
  }

  const approvalBlockers: string[] = [];
  if (safety.preflightStatus !== "pass") approvalBlockers.push("preflight-status");
  if (safety.preflightEvidence.length === 0) approvalBlockers.push("preflight-evidence");
  if (!targetComplete(safety.executionTarget)) approvalBlockers.push("execution-target");
  if (safety.approvalPlan.length === 0) approvalBlockers.push("approval-plan");
  if (!passedOrNotRequired(safety.rollbackStatus)) approvalBlockers.push("rollback-readiness");
  if (safety.executionKind === "release-deploy" && !passedOrNotRequired(safety.releaseCollisionStatus)) {
    approvalBlockers.push("release-collision-preflight");
  }

  const terminalBlockers = [...approvalBlockers];
  if (safety.runtimeProofStatus !== "pass") terminalBlockers.push("runtime-proof-status");
  if (safety.runtimeProofEvidence.length === 0) terminalBlockers.push("runtime-proof-evidence");
  if (safety.operationalDrift.length > 0) terminalBlockers.push("operational-drift");

  return {
    approvalReady: approvalBlockers.length === 0,
    terminalReady: terminalBlockers.length === 0,
    approvalBlockers,
    terminalBlockers,
  };
}

export function approvalPlanContains(safety: TaskExecutionSafety, command: string): boolean {
  return safety.approvalPlan.some((planned) => planned === command);
}
