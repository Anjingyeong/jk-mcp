import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor, encodeMassUlwAttemptFingerprint } from "./mass-ulw-executor.js";
import { MassUlwStore } from "./mass-ulw-store.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import {
  cleanupExecutorRoots,
  fakeWorkspace,
  lane,
  passVerification,
  temporaryExecutorRoot,
} from "./mass-ulw-runner-fixtures.js";

afterEach(cleanupExecutorRoots);

async function completedLaneFixture(stateDir: string, loopId: string, durableOutput: boolean) {
  const plan = buildMassUlwPlan({
    executionProfile: "max",
    candidates: [lane("A"), lane("B", { dependsOn: ["A"] })],
  });
  const store = new MassUlwStore(stateDir, { now: () => 200 });
  await store.create(loopId, plan);
  await store.update(loopId, (document) => {
    const laneState = document.lanes.A;
    const wave = document.waves[0];
    if (!laneState || !wave) throw new TypeError("completed lane fixture is incomplete");
    laneState.status = "completed";
    laneState.attempts = 1;
    laneState.completedAt = 200;
    wave.status = "completed";
    wave.completedAt = 200;
    document.currentWave = 1;
    document.attempts.push({
      id: `${loopId}:lane:A:1`,
      kind: "lane",
      laneId: "A",
      status: "completed",
      startedAt: 100,
      completedAt: 200,
      fingerprint: encodeMassUlwAttemptFingerprint({
        version: 1,
        approach: "initial",
        approachFingerprint: "approach-A",
        previousFailureFingerprint: null,
        previousApproachFingerprint: null,
        ...(durableOutput ? { outputFingerprint: "output-A" } : {}),
      }),
    });
  });
  return { plan, store };
}

describe("MASS ULW completed-output recovery", () => {
  it("rejects recovery when the lane engine omits a durable restore adapter", async () => {
    // Given
    const stateDir = await temporaryExecutorRoot("mass-ulw-restore-adapter-");
    const { plan } = await completedLaneFixture(stateDir, "missing-adapter", true);
    const events: string[] = [];
    const executor = new MassUlwExecutor({
      stateDir,
      repositoryRoot: stateDir,
      laneEngine: {
        async execute(request) {
          events.push(`execute:${request.lane.id}`);
          return { outputFingerprint: `output-${request.lane.id}`, approachFingerprint: "initial" };
        },
      },
      verificationEngine: passVerification(events),
      workspaceFactory: async () => fakeWorkspace(plan, events, () => undefined),
    });

    // When
    const execution = executor.execute({ loopId: "missing-adapter", plan });

    // Then
    await expect(execution).rejects.toThrow(/durable restore adapter/iu);
    expect(events.some((event) => event.startsWith("execute:"))).toBe(false);
  });

  it("rejects recovery when a completed attempt has no durable output fingerprint", async () => {
    // Given
    const stateDir = await temporaryExecutorRoot("mass-ulw-restore-output-");
    const { plan } = await completedLaneFixture(stateDir, "missing-output", false);
    const events: string[] = [];
    const executor = new MassUlwExecutor({
      stateDir,
      repositoryRoot: stateDir,
      laneEngine: {
        async restore(request) {
          events.push(`restore:${request.lane.id}`);
        },
        async execute(request) {
          return { outputFingerprint: `output-${request.lane.id}`, approachFingerprint: "initial" };
        },
      },
      verificationEngine: passVerification(events),
      workspaceFactory: async () => fakeWorkspace(plan, events, () => undefined),
    });

    // When
    const execution = executor.execute({ loopId: "missing-output", plan });

    // Then
    await expect(execution).rejects.toThrow(/durable completed output/iu);
    expect(events).not.toContain("restore:A");
  });

  it("persists blocked descendants separately from failed lanes", async () => {
    // Given
    const stateDir = await temporaryExecutorRoot("mass-ulw-blocked-lane-");
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [lane("root"), lane("child", { dependsOn: ["root"] })],
    });
    const store = new MassUlwStore(stateDir, { now: () => 300 });
    await store.create("blocked-lane", plan);
    await store.update("blocked-lane", (document) => {
      const root = document.lanes.root;
      if (!root) throw new TypeError("root lane fixture is incomplete");
      root.status = "failed";
      root.attempts = 3;
      for (let index = 0; index < 3; index += 1) {
        document.attempts.push({
          id: `root-${index}`,
          kind: "lane",
          laneId: "root",
          status: "failed",
          startedAt: index,
          completedAt: index + 1,
          fingerprint: `failure-${index}`,
        });
      }
    });
    const events: string[] = [];
    const executor = new MassUlwExecutor({
      stateDir,
      repositoryRoot: stateDir,
      laneEngine: {
        async execute(request) {
          return { outputFingerprint: request.lane.id, approachFingerprint: "initial" };
        },
      },
      verificationEngine: passVerification(events),
      workspaceFactory: async () => fakeWorkspace(plan, events, () => undefined),
    });

    // When
    const result = await executor.execute({ loopId: "blocked-lane", plan });

    // Then
    expect(result).toMatchObject({ failedLaneIds: ["root"], blockedLaneIds: ["child"] });
    expect((await store.load("blocked-lane")).lanes).toMatchObject({
      root: { status: "failed" },
      child: { status: "blocked" },
    });
  });
});
