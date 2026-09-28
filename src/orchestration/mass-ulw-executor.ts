import type { MassUlwPlan } from "./mass-ulw.js";
import { MassUlwStore, type MassUlwDocument } from "./mass-ulw-store.js";
import { PlanSchema } from "./mass-ulw-store-schema.js";
import { cleanupMassUlwPrivateWorkspace, createMassUlwWorkspace, type MassUlwWorkspaceOptions } from "./mass-ulw-workspace.js";
import { MassUlwFinalizer } from "./mass-ulw-executor-finalizer.js";
import { ancestorsOf, descendantsOf, stableTopologicalWaves, topologicalLaneIds } from "./mass-ulw-executor-graph.js";
import { MassUlwExecutionState } from "./mass-ulw-executor-state.js";
import { MassUlwLaneRunner } from "./mass-ulw-executor-lane.js";
import { acquireExecutionLock } from "./mass-ulw-executor-lock.js";
import { recoveryHistory } from "./mass-ulw-executor-recovery.js";
import { finalizeMassUlwPublicationRecovery, recoverMassUlwPublication } from "./mass-ulw-publish-recovery.js";
import type { MassUlwExecutionInput, MassUlwExecutionResult, MassUlwExecutorOptions, MassUlwWorkspaceLike } from "./mass-ulw-executor-types.js";
import type { MassUlwFailureDiagnostic } from "./mass-ulw-failure.js";
import { MassUlwStageError } from "./mass-ulw-failure.js";
const MAX_LANE_ATTEMPTS = 3;
type LaneOutcome = { laneId: string; status: "completed" | "failed" | "halted" };
function laneFailureDiagnostics(document: MassUlwDocument, laneIds: ReadonlySet<string>): MassUlwFailureDiagnostic[] {
  return document.attempts
    .filter((attempt) => attempt.kind === "lane" && attempt.status === "failed" && attempt.laneId && laneIds.has(attempt.laneId) && attempt.failure)
    .map((attempt) => attempt.failure!)
    .sort((left, right) => (left.laneId ?? "").localeCompare(right.laneId ?? "") || left.stage.localeCompare(right.stage));
}
export { encodeMassUlwAttemptFingerprint, parseMassUlwAttemptFingerprint } from "./mass-ulw-executor-recovery.js";
export type { IntegratedVerificationRequest, LaneEngine, LaneExecutionRequest, LaneExecutionResult, LaneRestoreRequest, LaneVerificationRequest, MassUlwAttemptFingerprint, MassUlwExecutionInput, MassUlwExecutionResult, MassUlwExecutorOptions, MassUlwRecoveryApproach, MassUlwWorkspaceLike, VerificationEngine, VerificationResult } from "./mass-ulw-executor-types.js";
export class MassUlwExecutor {
  private readonly store: MassUlwStore;
  private readonly now: () => number;
  private readonly laneRunner: MassUlwLaneRunner;
  private readonly state: MassUlwExecutionState;
  private readonly finalizer: MassUlwFinalizer;
  private readonly workspaceFactory: (options: MassUlwWorkspaceOptions) => Promise<MassUlwWorkspaceLike>;

  constructor(private readonly options: MassUlwExecutorOptions) {
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new MassUlwStore(options.stateDir, { now: this.now });
    this.workspaceFactory = options.workspaceFactory ?? createMassUlwWorkspace;
    this.state = new MassUlwExecutionState({ store: this.store, laneEngine: options.laneEngine, now: this.now });
    this.laneRunner = new MassUlwLaneRunner({
      store: this.store,
      laneEngine: options.laneEngine,
      verificationEngine: options.verificationEngine,
      now: this.now,
      authorizeLaneExecutionStart: options.authorizeLaneExecutionStart ?? options.authorizeLaneStart ?? (async () => undefined),
      authorizeLaneVerificationStart: options.authorizeLaneVerificationStart ?? (async () => undefined),
    });
    this.finalizer = new MassUlwFinalizer({
      store: this.store,
      verificationEngine: options.verificationEngine,
      now: this.now,
      authorizeIntegratedVerification: options.authorizeIntegratedVerification ?? (async () => undefined),
      authorizePublish: options.authorizePublish ?? (async () => undefined),
    });
  }

  async execute(input: MassUlwExecutionInput): Promise<MassUlwExecutionResult> {
    const executionLock = await acquireExecutionLock(this.options.stateDir, input.loopId, this.now);
    try {
      return await this.executeLocked(input);
    } finally {
      await executionLock.release();
    }
  }

  private validatePlan(plan: MassUlwPlan): void {
    PlanSchema.parse(plan);
    if (plan.lanes.length > 4) throw new Error("MASS ULW execution admits at most four approved lanes");
    if (plan.hardBlocks.length > 0) throw new Error(`MASS ULW plan is blocked: ${plan.hardBlocks.join(", ")}`);
    const stableWaves = stableTopologicalWaves(plan.lanes);
    if (JSON.stringify(stableWaves) !== JSON.stringify(plan.waves)) {
      throw new Error("MASS ULW plan waves are not the stable topological waves for its lanes");
    }
  }

  private async prepareDocument(input: MassUlwExecutionInput): Promise<MassUlwDocument> {
    let existing: MassUlwDocument;
    try {
      existing = await this.store.load(input.loopId);
    } catch (error) {
      if (!/MASS ULW state does not exist/u.test((error as Error).message)) throw error;
      return this.store.create(input.loopId, input.plan);
    }
    if (existing.plan.planFingerprint !== input.plan.planFingerprint) {
      throw new Error(`MASS ULW loop ${input.loopId} cannot resume a different plan`);
    }
    return this.store.resume(input.loopId);
  }

  private completedResult(document: MassUlwDocument): MassUlwExecutionResult {
    const receipt = document.publishJournal.findLast((entry) => entry.status === "published" &&
      entry.fingerprint === document.fingerprints.publish &&
      entry.receipt?.integrationCommit === document.fingerprints.integration)?.receipt;
    return {
      status: "completed",
      completedLaneIds: topologicalLaneIds(document.plan).filter((id) => document.lanes[id]?.status === "completed"),
      failedLaneIds: [],
      blockedLaneIds: [],
      failureDiagnostics: [],
      changedPaths: [...(receipt?.changedPaths ?? [])].sort((left, right) => left.localeCompare(right)),
      laneCommits: [...(receipt?.laneCommits ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
      integrationFingerprint: document.fingerprints.integration,
      finalVerificationInvocationCount: document.integrationVerification.status === "passed" ? 1 : 0,
    };
  }

  private async executeLocked(input: MassUlwExecutionInput): Promise<MassUlwExecutionResult> {
    this.validatePlan(input.plan);
    let document = await this.prepareDocument(input);
    const recovery = await recoverMassUlwPublication({
      recoveryRoot: this.options.stateDir,
      recoveryId: input.loopId,
      repositoryRoot: this.options.repositoryRoot,
    });
    if (recovery.kind === "committed") {
      await this.finalizer.reconcilePublished(input.loopId, recovery.receipt);
      await cleanupMassUlwPrivateWorkspace(this.options.tempRoot, this.options.stateDir, input.loopId);
      await finalizeMassUlwPublicationRecovery(this.options.stateDir, input.loopId);
      return {
        status: "completed",
        completedLaneIds: topologicalLaneIds(document.plan),
        failedLaneIds: [],
        blockedLaneIds: [],
        failureDiagnostics: [],
        changedPaths: [...recovery.receipt.changedPaths],
        laneCommits: [...recovery.receipt.laneCommits].sort((left, right) => left.id.localeCompare(right.id)),
        integrationFingerprint: recovery.receipt.integrationCommit,
        finalVerificationInvocationCount: 1,
      };
    }
    document = await this.store.load(input.loopId);
    if (
      document.integrationVerification.status === "passed" &&
      document.publishJournal.some((entry) => entry.status === "published")
    ) {
      return this.completedResult(document);
    }
    if (document.integrationVerification.status === "unknown-after-interruption") {
      return {
        status: "blocked", completedLaneIds: topologicalLaneIds(input.plan).filter((id) => document.lanes[id]?.status === "completed"),
        failedLaneIds: [], blockedLaneIds: [], failureDiagnostics: [], changedPaths: [], laneCommits: [],
        integrationFingerprint: document.integrationVerification.fingerprint, finalVerificationInvocationCount: 0,
        recovery: { reason: "final-verification-outcome-unknown", attemptId: document.integrationVerification.attemptId,
          automaticReplay: false, authorizationRequired: true, nextAction: "inspect-outcome-and-start-new-approved-run" },
      };
    }

    await this.state.prepareStrategies(input);
    document = await this.store.load(input.loopId);
    const workspace = await this.workspaceFactory({
      repositoryRoot: this.options.repositoryRoot,
      tempRoot: this.options.tempRoot,
      recoveryRoot: this.options.stateDir,
      recoveryId: input.loopId,
      lanes: input.plan.lanes.map((lane) => ({ id: lane.id, writeScopes: lane.writeScopes, dependsOn: lane.dependsOn })),
    });
    let publicationRecorded = false;
    try {
      const checkouts = new Map(workspace.lanes.map((checkout) => [checkout.id, checkout]));
      for (const lane of input.plan.lanes) {
        if (!checkouts.has(lane.id)) throw new Error(`MASS ULW workspace omitted lane checkout: ${lane.id}`);
      }

      await this.state.restoreCompletedLanes(input, document, workspace, checkouts);
      const failedLaneIds = new Set<string>();
      const maxAttempts = this.options.laneEngine.failurePolicy === "repair-required" ? 1 : MAX_LANE_ATTEMPTS;
      for (const lane of input.plan.lanes) {
        if (document.lanes[lane.id]?.status !== "completed" && recoveryHistory(document, lane.id).length >= maxAttempts) {
          failedLaneIds.add(lane.id);
        }
      }
      let blockedLaneIds = descendantsOf(input.plan, failedLaneIds);
      if (failedLaneIds.size > 0) await this.state.persistBlockedLanes(input.loopId, failedLaneIds, blockedLaneIds);

      const pending = new Set(topologicalLaneIds(input.plan).filter((id) =>
        document.lanes[id]?.status !== "completed" && !failedLaneIds.has(id) && !blockedLaneIds.has(id)));
      const active = new Map<string, Promise<LaneOutcome>>();
      const concurrency = input.plan.state === "fanout" && input.plan.recommended ? Math.min(4, input.plan.maxLanes) : 1;
      let globalFailure: { error: unknown } | undefined;
      const assertAdmissionOpen = (): void => { if (globalFailure) throw globalFailure.error; };
      const start = async (laneId: string): Promise<LaneOutcome> => {
        try {
          try {
            await workspace.prepareLane?.(laneId, ancestorsOf(input.plan, laneId));
          } catch (error) {
            if (!(error instanceof MassUlwStageError) || error.diagnostic.laneId !== laneId || error.diagnostic.stage !== "checkout") throw error;
            await this.state.failPreparation(input.loopId, laneId, error.diagnostic);
            return { laneId, status: "failed" };
          }
          if (globalFailure) return { laneId, status: "halted" };
          const checkout = checkouts.get(laneId);
          if (!checkout) throw new Error(`Missing checkout: ${laneId}`);
          return await this.laneRunner.run(input, checkout, laneId);
        } catch (error) {
          globalFailure ??= { error };
          return { laneId, status: "halted" };
        }
      };

      try {
        while (pending.size > 0 || active.size > 0) {
          assertAdmissionOpen();
          document = await this.store.load(input.loopId);
          for (const laneId of pending) {
            if (globalFailure || active.size >= concurrency) break;
            const lane = document.lanes[laneId]?.lane;
            if (!lane || !lane.dependsOn.every((id) => document.lanes[id]?.status === "completed")) continue;
            await this.state.startWave(input.loopId, input.plan.waves.findIndex((wave) => wave.includes(laneId)));
            if (globalFailure) break;
            pending.delete(laneId);
            active.set(laneId, start(laneId));
          }
          assertAdmissionOpen();
          if (active.size === 0) {
            if (pending.size > 0) throw new Error("MASS ULW has pending lanes without completed prerequisites");
            break;
          }
          const outcome = await Promise.race(active.values());
          active.delete(outcome.laneId);
          assertAdmissionOpen();
          if (outcome.status === "failed") {
            failedLaneIds.add(outcome.laneId);
            blockedLaneIds = descendantsOf(input.plan, failedLaneIds);
            for (const id of blockedLaneIds) pending.delete(id);
            await this.state.persistBlockedLanes(input.loopId, failedLaneIds, blockedLaneIds);
          }
          for (let index = 0; index < input.plan.waves.length; index += 1) await this.state.finishWave(input.loopId, index);
        }
      } catch (error) {
        globalFailure ??= { error };
        throw error;
      } finally {
        // Admission and cleanup share execution ownership, including preparations.
        await Promise.all(active.values());
      }

      document = await this.store.load(input.loopId);
      if (failedLaneIds.size > 0 || blockedLaneIds.size > 0) {
        return {
          status: "blocked",
          completedLaneIds: topologicalLaneIds(input.plan).filter((id) => document.lanes[id]?.status === "completed"),
          failedLaneIds: [...failedLaneIds].sort((left, right) => left.localeCompare(right)),
          blockedLaneIds: [...blockedLaneIds].sort((left, right) => left.localeCompare(right)),
          failureDiagnostics: laneFailureDiagnostics(document, failedLaneIds),
          ...(this.options.laneEngine.failurePolicy === "repair-required" ? {
            recovery: { reason: "repair-required" as const, laneIds: [...failedLaneIds].sort(), automaticReplay: false as const },
          } : {}),
          changedPaths: [],
          laneCommits: [],
          integrationFingerprint: null,
          finalVerificationInvocationCount: 0,
        };
      }

      const integration = await workspace.integrate();
      const verification = await this.finalizer.verifyIntegrated(input.loopId, workspace, integration);
      if (!verification.passed) {
        return {
          status: "blocked",
          completedLaneIds: topologicalLaneIds(input.plan),
          failedLaneIds: [],
          blockedLaneIds: [],
          failureDiagnostics: verification.failure ? [verification.failure] : [],
          changedPaths: integration.changedPaths,
          laneCommits: integration.laneCommits,
          integrationFingerprint: integration.commit,
          finalVerificationInvocationCount: verification.invocationCount,
        };
      }
      const published = await this.finalizer.publish(input.loopId, workspace, integration);
      publicationRecorded = true;
      return {
        status: "completed",
        completedLaneIds: topologicalLaneIds(input.plan),
        failedLaneIds: [],
        blockedLaneIds: [],
        failureDiagnostics: [],
        changedPaths: [...published.changedPaths].sort((left, right) => left.localeCompare(right)),
        laneCommits: [...integration.laneCommits].sort((left, right) => left.id.localeCompare(right.id)),
        integrationFingerprint: integration.commit,
        finalVerificationInvocationCount: verification.invocationCount,
      };
    } finally {
      // Filesystem commit alone is not durable executor completion.
      await workspace.cleanup({ preservePublicationReceipt: true });
      if (publicationRecorded) await finalizeMassUlwPublicationRecovery(this.options.stateDir, input.loopId);
    }
  }


}

export async function executeMassUlw(options: MassUlwExecutorOptions & MassUlwExecutionInput): Promise<MassUlwExecutionResult> {
  const { loopId, plan, repairStrategies, ...dependencies } = options;
  return new MassUlwExecutor(dependencies).execute({ loopId, plan, repairStrategies });
}
