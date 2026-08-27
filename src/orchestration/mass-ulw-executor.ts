import type { MassUlwPlan } from "./mass-ulw.js";
import { MassUlwStore, type MassUlwDocument } from "./mass-ulw-store.js";
import { PlanSchema } from "./mass-ulw-store-schema.js";
import { cleanupMassUlwPrivateWorkspace, createMassUlwWorkspace, type MassUlwLaneCheckout, type MassUlwWorkspaceOptions } from "./mass-ulw-workspace.js";
import { MassUlwFinalizer } from "./mass-ulw-executor-finalizer.js";
import { ancestorsOf, descendantsOf, stableTopologicalWaves, topologicalLaneIds } from "./mass-ulw-executor-graph.js";
import { MassUlwExecutionState } from "./mass-ulw-executor-state.js";
import { MassUlwLaneRunner } from "./mass-ulw-executor-lane.js";
import { acquireExecutionLock } from "./mass-ulw-executor-lock.js";
import { laneAttempts, parseMassUlwAttemptFingerprint, recoveryHistory } from "./mass-ulw-executor-recovery.js";
import { finalizeMassUlwPublicationRecovery, recoverMassUlwPublication } from "./mass-ulw-publish-recovery.js";
import type { MassUlwExecutionInput, MassUlwExecutionResult, MassUlwExecutorOptions, MassUlwWorkspaceLike } from "./mass-ulw-executor-types.js";
const MAX_LANE_ATTEMPTS = 3;
type LaneOutcome = { laneId: string; status: "completed" | "failed" };
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
    return {
      status: "completed",
      completedLaneIds: topologicalLaneIds(document.plan).filter((id) => document.lanes[id]?.status === "completed"),
      failedLaneIds: [],
      blockedLaneIds: [],
      changedPaths: [],
      laneCommits: [],
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
        changedPaths: [...recovery.receipt.changedPaths],
        laneCommits: [...recovery.receipt.laneCommits],
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

    const workspace = await this.workspaceFactory({
      repositoryRoot: this.options.repositoryRoot,
      tempRoot: this.options.tempRoot,
      recoveryRoot: this.options.stateDir,
      recoveryId: input.loopId,
      lanes: input.plan.lanes.map((lane) => ({ id: lane.id, writeScopes: lane.writeScopes })),
    });
    try {
      const checkouts = new Map(workspace.lanes.map((checkout) => [checkout.id, checkout]));
      for (const lane of input.plan.lanes) {
        if (!checkouts.has(lane.id)) throw new Error(`MASS ULW workspace omitted lane checkout: ${lane.id}`);
      }

      await this.state.restoreCompletedLanes(input, document, workspace, checkouts);
      const failedLaneIds = new Set<string>();
      for (const lane of input.plan.lanes) {
        if (document.lanes[lane.id]?.status !== "completed" && recoveryHistory(document, lane.id).length >= MAX_LANE_ATTEMPTS) {
          failedLaneIds.add(lane.id);
        }
      }
      let blockedLaneIds = descendantsOf(input.plan, failedLaneIds);
      if (failedLaneIds.size > 0) await this.state.persistBlockedLanes(input.loopId, failedLaneIds, blockedLaneIds);

      for (let waveIndex = 0; waveIndex < input.plan.waves.length; waveIndex += 1) {
        document = await this.store.load(input.loopId);
        const wave = input.plan.waves[waveIndex]!;
        const newlyBlocked = new Set<string>();
        const runnable: string[] = [];
        for (const laneId of wave) {
          const laneState = document.lanes[laneId]!;
          if (laneState.status === "completed" || failedLaneIds.has(laneId) || blockedLaneIds.has(laneId)) continue;
          const lane = laneState.lane;
          const failedDependency = lane.dependsOn.some((dependency) => document.lanes[dependency]?.status === "failed");
          if (failedDependency) newlyBlocked.add(laneId);
          else if (lane.dependsOn.every((dependency) => document.lanes[dependency]?.status === "completed")) runnable.push(laneId);
          else throw new Error(`MASS ULW lane became runnable before its dependencies: ${laneId}`);
        }
        if (newlyBlocked.size > 0) {
          for (const laneId of newlyBlocked) blockedLaneIds.add(laneId);
          blockedLaneIds = new Set([...blockedLaneIds, ...descendantsOf(input.plan, new Set([...failedLaneIds, ...blockedLaneIds]))]);
          await this.state.persistBlockedLanes(input.loopId, failedLaneIds, blockedLaneIds);
        }
        if (runnable.length === 0) {
          await this.state.finishWave(input.loopId, waveIndex);
          continue;
        }

        await Promise.all(runnable.map((laneId) => workspace.prepareLane?.(laneId, ancestorsOf(input.plan, laneId))));
        await this.state.startWave(input.loopId, waveIndex);
        const outcomes: LaneOutcome[] = [];
        const beneficialParallelWave = input.plan.state === "fanout" && input.plan.recommended && runnable.length > 1;
        if (beneficialParallelWave) {
          const settled = await Promise.allSettled(
            runnable.map((laneId) => this.laneRunner.run(input, checkouts.get(laneId)!, laneId)),
          );
          const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (rejected) throw rejected.reason;
          outcomes.push(...settled.map((result) => (result as PromiseFulfilledResult<LaneOutcome>).value));
        } else {
          for (const laneId of runnable) outcomes.push(await this.laneRunner.run(input, checkouts.get(laneId)!, laneId));
        }
        for (const outcome of outcomes) if (outcome.status === "failed") failedLaneIds.add(outcome.laneId);
        if (outcomes.some((outcome) => outcome.status === "failed")) {
          blockedLaneIds = descendantsOf(input.plan, failedLaneIds);
          await this.state.persistBlockedLanes(input.loopId, failedLaneIds, blockedLaneIds);
        }
        await this.state.finishWave(input.loopId, waveIndex);
      }

      document = await this.store.load(input.loopId);
      if (failedLaneIds.size > 0 || blockedLaneIds.size > 0) {
        return {
          status: "blocked",
          completedLaneIds: topologicalLaneIds(input.plan).filter((id) => document.lanes[id]?.status === "completed"),
          failedLaneIds: [...failedLaneIds].sort((left, right) => left.localeCompare(right)),
          blockedLaneIds: [...blockedLaneIds].sort((left, right) => left.localeCompare(right)),
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
          changedPaths: integration.changedPaths,
          laneCommits: integration.laneCommits,
          integrationFingerprint: integration.commit,
          finalVerificationInvocationCount: verification.invocationCount,
        };
      }
      const published = await this.finalizer.publish(input.loopId, workspace, integration);
      return {
        status: "completed",
        completedLaneIds: topologicalLaneIds(input.plan),
        failedLaneIds: [],
        blockedLaneIds: [],
        changedPaths: [...published.changedPaths].sort((left, right) => left.localeCompare(right)),
        laneCommits: [...integration.laneCommits].sort((left, right) => left.id.localeCompare(right.id)),
        integrationFingerprint: integration.commit,
        finalVerificationInvocationCount: verification.invocationCount,
      };
    } finally {
      await workspace.cleanup();
    }
  }


}

export async function executeMassUlw(options: MassUlwExecutorOptions & MassUlwExecutionInput): Promise<MassUlwExecutionResult> {
  const { loopId, plan, ...dependencies } = options;
  return new MassUlwExecutor(dependencies).execute({ loopId, plan });
}
