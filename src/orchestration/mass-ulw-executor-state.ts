import type { MassUlwPlan } from "./mass-ulw.js";
import type { MassUlwDocument, MassUlwStore } from "./mass-ulw-store.js";
import type { MassUlwLaneCheckout } from "./mass-ulw-workspace.js";
import type { LaneEngine, MassUlwExecutionInput, MassUlwWorkspaceLike } from "./mass-ulw-executor-types.js";
import { laneAttempts, parseMassUlwAttemptFingerprint } from "./mass-ulw-executor-recovery.js";
import { ancestorsOf, topologicalLaneIds } from "./mass-ulw-executor-graph.js";
class MassUlwRestoreError extends Error {
  readonly name = "MassUlwRestoreError";
  constructor(readonly laneId: string, reason: string) {
    super(`Lane ${laneId} requires ${reason}`);
  }
}
export class MassUlwExecutionState {
  constructor(private readonly config: { store: MassUlwStore; laneEngine: LaneEngine; now: () => number }) {}
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
  async startWave(loopId: string, waveIndex: number): Promise<void> {
    await this.config.store.update(loopId, (document) => {
      const wave = document.waves[waveIndex]!;
      wave.status = "in-flight";
      delete wave.completedAt;
      document.currentWave = waveIndex;
    });
  }

  async finishWave(loopId: string, waveIndex: number): Promise<void> {
    await this.config.store.update(loopId, (document) => {
      const wave = document.waves[waveIndex]!;
      const statuses = wave.laneIds.map((laneId) => document.lanes[laneId]!.status);
      if (statuses.every((status) => status === "completed")) {
        wave.status = "completed";
        wave.completedAt ??= this.config.now();
      } else if (statuses.some((status) => status === "failed" || status === "blocked")) {
        wave.status = "failed";
        delete wave.completedAt;
      } else {
        wave.status = "planned";
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
        } else if (statuses.some((status) => status === "failed" || status === "blocked")) {
          wave.status = "failed";
          delete wave.completedAt;
        }
      }
      document.currentWave = document.waves.find((wave) => wave.status === "planned" || wave.status === "in-flight")?.index ?? null;
    });
  }


}
