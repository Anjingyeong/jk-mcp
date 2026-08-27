import type { MassUlwPlan } from "../orchestration/mass-ulw.js";
import { MassUlwArtifactStore } from "../orchestration/mass-ulw-artifacts.js";
import {
  removeMassUlwIdentityIndex,
  writeMassUlwIdentityIndex,
} from "../orchestration/mass-ulw-identity-index.js";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { DomainError, ErrorCode } from "../types.js";
import type { MassUlwExecutionIdentity } from "./mass-ulw-identity.js";

type MassUlwLifecycleState = "approved" | "preserved" | "revoked" | "read-only" | "inactive";

export type MassUlwLifecycleResult = {
  readonly state: MassUlwLifecycleState;
  readonly executable: boolean;
  readonly reasonCode: "PLAN_APPROVED" | "CONTINUATION_RESUME" | "EXPLICIT_REVOCATION" | "READ_ONLY_GOAL_MODE" | "NO_APPROVED_PLAN";
  readonly executionId: string;
  readonly planFingerprint: string | null;
};

async function loadPlan(store: MassUlwStore, executionId: string): Promise<MassUlwPlan | null> {
  try {
    return (await store.load(executionId)).plan;
  } catch (error) {
    if (error instanceof Error && /MASS ULW state does not exist/u.test(error.message)) return null;
    throw error;
  }
}

async function persistPlan(store: MassUlwStore, executionId: string, plan: MassUlwPlan): Promise<void> {
  try {
    await store.create(executionId, plan);
  } catch (error) {
    if (!(error instanceof Error) || !/MASS ULW state already exists/u.test(error.message)) throw error;
    const existing = await store.load(executionId);
    if (existing.plan.planFingerprint !== plan.planFingerprint) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "MASS ULW execution already has a different approved plan", {
        expectedPlanFingerprint: existing.plan.planFingerprint,
        receivedPlanFingerprint: plan.planFingerprint,
      });
    }
  }
}

export async function updateMassUlwLifecycle(input: {
  readonly stateDir: string;
  readonly identity: MassUlwExecutionIdentity;
  readonly candidatePlan: MassUlwPlan | null;
  readonly explicitFanoutDecision: boolean;
  readonly writeEnabled: boolean;
}): Promise<MassUlwLifecycleResult> {
  const store = new MassUlwStore(input.stateDir);
  const executionId = input.identity.executionId;
  if (input.candidatePlan && !input.writeEnabled) {
    return { state: "read-only", executable: false, reasonCode: "READ_ONLY_GOAL_MODE", executionId, planFingerprint: null };
  }
  if (input.candidatePlan) {
    await persistPlan(store, executionId, input.candidatePlan);
    await writeMassUlwIdentityIndex(input.stateDir, {
      version: 1,
      projectId: input.identity.projectId,
      externalLoopId: input.identity.externalLoopId,
      executionId,
    });
    return { state: "approved", executable: true, reasonCode: "PLAN_APPROVED", executionId, planFingerprint: input.candidatePlan.planFingerprint };
  }
  if (input.explicitFanoutDecision) {
    await store.remove(executionId);
    await new MassUlwArtifactStore(input.stateDir, executionId).cleanup();
    await removeMassUlwIdentityIndex(input.stateDir, input.identity);
    return { state: "revoked", executable: false, reasonCode: "EXPLICIT_REVOCATION", executionId, planFingerprint: null };
  }
  const existing = await loadPlan(store, executionId);
  if (existing) {
    await writeMassUlwIdentityIndex(input.stateDir, {
      version: 1,
      projectId: input.identity.projectId,
      externalLoopId: input.identity.externalLoopId,
      executionId,
    });
    return { state: "preserved", executable: true, reasonCode: "CONTINUATION_RESUME", executionId, planFingerprint: existing.planFingerprint };
  }
  return { state: "inactive", executable: false, reasonCode: "NO_APPROVED_PLAN", executionId, planFingerprint: null };
}

export async function cleanupReconciledMassUlwTerminal(input: {
  readonly stateDir: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly externalLoopId: string;
}): Promise<boolean> {
  const store = new MassUlwStore(input.stateDir);
  const document = await store.load(input.executionId);
  const reconciled = document.integrationVerification.status === "passed"
    && document.publishJournal.some((entry) => entry.status === "published");
  if (!reconciled) return false;
  await store.remove(input.executionId);
  await new MassUlwArtifactStore(input.stateDir, input.executionId).cleanup();
  await removeMassUlwIdentityIndex(input.stateDir, input);
  return true;
}
