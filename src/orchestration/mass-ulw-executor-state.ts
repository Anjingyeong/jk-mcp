import type { MassUlwDocument, MassUlwStore } from "./mass-ulw-store.js";
import type { MassUlwLaneCheckout } from "./mass-ulw-workspace.js";
import type { LaneEngine, MassUlwExecutionInput, MassUlwWorkspaceLike } from "./mass-ulw-executor-types.js";
import { encodeMassUlwAttemptFingerprint, fingerprint, laneAttempts, parseMassUlwAttemptFingerprint, recoveryHistory } from "./mass-ulw-executor-recovery.js";
import { ancestorsOf, topologicalLaneIds } from "./mass-ulw-executor-graph.js";
import { MassUlwRepairStrategiesSchema } from "./mass-ulw-store-schema.js";
import type { MassUlwFailureDiagnostic } from "./mass-ulw-failure.js";
class MassUlwRestoreError extends Error {
  readonly name = "MassUlwRestoreError";
  constructor(readonly laneId: string, reason: string) {
    super(`Lane ${laneId} requires ${reason}`);
  }
}
export class MassUlwExecutionState {
  constructor(private readonly config: { store: MassUlwStore; laneEngine: LaneEngine; now: () => number }) {}
  async prepareStrategies(input: MassUlwExecutionInput): Promise<void> {
    const supplied = MassUlwRepairStrategiesSchema.parse(input.repairStrategies ?? {});
    const approachFingerprint = this.config.laneEngine.approachFingerprint;
    if (!approachFingerprint) {
      if (Object.keys(supplied).length > 0) throw new Error("Explicit strategy generations require a fixed-input fingerprint adapter");
      return;
    }
    await this.config.store.update(input.loopId, (document) => {
      for (const id of Object.keys(supplied)) {
        if (!document.lanes[id]) throw new Error(`Unknown repair lane: ${id}`);
      }
      for (const [id, lane] of Object.entries(document.lanes)) {
        const repair = supplied[id];
        if (lane.status === "completed") {
          if (repair) throw new Error(`Completed lane cannot open a repair generation: ${id}`);
          continue;
        }
        const attempts = laneAttempts(document, id);
        const current = lane.strategyGenerations?.at(-1);
        const previous = current?.approachFingerprint ?? parseMassUlwAttemptFingerprint(attempts.at(-1)?.fingerprint)?.approachFingerprint;
        const nextFingerprint = approachFingerprint(id);
        if (repair) {
          if (current && repair.generation === current.generation && repair.approach === current.approach &&
            repair.evidence === current.evidence && nextFingerprint === current.approachFingerprint) continue;
          if (recoveryHistory(document, id).length === 0 || repair.generation !== (current?.generation ?? 0) + 1 ||
            !previous || previous === nextFingerprint || repair.approach === current?.approach) {
            throw new Error(`Lane ${id} requires the next explicit generation and a changed patch/approach`);
          }
          lane.strategyGenerations ??= [{ generation: 0, approachFingerprint: previous, approach: "legacy", evidence: "persisted-attempt" }];
          lane.strategyGenerations.push({ ...repair, approachFingerprint: nextFingerprint });
          lane.status = "planned";
        } else if (!current && attempts.length === 0) {
          lane.strategyGenerations = [{ generation: 0, approachFingerprint: nextFingerprint, approach: "initial", evidence: "approved-input" }];
        } else if (current && attempts.every((attempt) =>
          (parseMassUlwAttemptFingerprint(attempt.fingerprint)?.strategyGeneration ?? 0) !== current.generation) &&
          nextFingerprint !== current.approachFingerprint) {
          throw new Error(`Lane ${id} patch does not match its recorded strategy generation`);
        }
      }
    });
  }
  async restoreCompletedLanes(
    input: MassUlwExecutionInput,
    document: MassUlwDocument,
    workspace: MassUlwWorkspaceLike,
    checkouts: ReadonlyMap<string, MassUlwLaneCheckout>,
  ): Promise<void> {
    const completedLaneIds = topologicalLaneIds(input.plan)
      .filter((laneId) => document.lanes[laneId]?.status === "completed");
    if (completedLaneIds.length === 0) return;
    const restore = this.config.laneEngine.restore;
    if (!restore) throw new MassUlwRestoreError(completedLaneIds[0] ?? "unknown", "a durable restore adapter");

    for (const laneId of completedLaneIds) {
      const laneState = document.lanes[laneId];
      const checkout = checkouts.get(laneId);
      if (!laneState || !checkout) throw new MassUlwRestoreError(laneId, "persisted lane and checkout state");
      const completedAttempt = laneAttempts(document, laneId)
        .filter((attempt) => attempt.status === "completed")
        .at(-1);
      const outputFingerprint = parseMassUlwAttemptFingerprint(completedAttempt?.fingerprint)?.outputFingerprint;
      if (!outputFingerprint) throw new MassUlwRestoreError(laneId, "a durable completed output fingerprint");
      await workspace.prepareLane?.(laneId, ancestorsOf(input.plan, laneId));
      await restore({
        loopId: input.loopId,
        lane: laneState.lane,
        checkout,
        outputFingerprint,
      });
    }
  }
  async failPreparation(loopId: string, laneId: string, failure: MassUlwFailureDiagnostic): Promise<void> {
    await this.config.store.update(loopId, (document) => {
      const lane = document.lanes[laneId];
      if (!lane) throw new Error(`Unknown preparation lane: ${laneId}`);
      lane.status = "failed";
      lane.attempts += 1;
      const strategy = lane.strategyGenerations?.at(-1);
      document.attempts.push({ id: `${loopId}:lane:${laneId}:${lane.attempts}`, kind: "lane", laneId,
        fingerprint: encodeMassUlwAttemptFingerprint({ version: 1, approach: "initial",
          strategyGeneration: strategy?.generation ?? 0, approachFingerprint: strategy?.approachFingerprint ?? fingerprint({ laneId, stage: "checkout" }),
          failureFingerprint: fingerprint(failure), previousFailureFingerprint: null, previousApproachFingerprint: null }),
        status: "failed", startedAt: this.config.now(), completedAt: this.config.now(), failure: { ...failure, retryable: false } });
    });
  }

  async startWave(loopId: string, waveIndex: number): Promise<void> {
    await this.config.store.update(loopId, (document) => {
      document.scheduler = "dependency-ready";
      const wave = document.waves[waveIndex]!;
      wave.status = "in-flight";
      delete wave.completedAt;
      document.currentWave = document.waves.find((candidate) => candidate.status === "planned" || candidate.status === "in-flight")?.index ?? null;
    });
  }

  async finishWave(loopId: string, waveIndex: number): Promise<void> {
    await this.config.store.update(loopId, (document) => {
      const wave = document.waves[waveIndex]!;
      const statuses = wave.laneIds.map((laneId) => document.lanes[laneId]!.status);
      if (statuses.every((status) => status === "completed")) {
        wave.status = "completed";
        wave.completedAt ??= this.config.now();
      } else if (statuses.every((status) => status === "completed" || status === "failed" || status === "blocked")) {
        wave.status = "failed";
        delete wave.completedAt;
      } else {
        wave.status = wave.status === "in-flight" || statuses.includes("in-flight") ? "in-flight" : "planned";
        delete wave.completedAt;
      }
      document.currentWave = document.waves.find((candidate) => candidate.status === "planned" || candidate.status === "in-flight")?.index ?? null;
    });
  }

  async persistBlockedLanes(
    loopId: string,
    failedLaneIds: ReadonlySet<string>,
    blockedLaneIds: ReadonlySet<string>,
  ): Promise<void> {
    await this.config.store.update(loopId, (document) => {
      for (const laneId of failedLaneIds) {
        const lane = document.lanes[laneId];
        if (lane && lane.status !== "completed") {
          lane.status = "failed";
          delete lane.completedAt;
        }
      }
      for (const laneId of blockedLaneIds) {
        const lane = document.lanes[laneId];
        if (lane && lane.status !== "completed") {
          lane.status = "blocked";
          delete lane.completedAt;
        }
      }
      for (const wave of document.waves) {
        const statuses = wave.laneIds.map((laneId) => document.lanes[laneId]!.status);
        if (statuses.every((status) => status === "completed")) {
          wave.status = "completed";
          wave.completedAt ??= this.config.now();
        } else if (statuses.every((status) => status === "completed" || status === "failed" || status === "blocked")) {
          wave.status = "failed";
          delete wave.completedAt;
        }
      }
      document.currentWave = document.waves.find((wave) => wave.status === "planned" || wave.status === "in-flight")?.index ?? null;
    });
  }


}
