import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor, type LaneEngine } from "./mass-ulw-executor.js";
import { MassUlwStore } from "./mass-ulw-store.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import { cleanupExecutorRoots, deferred, eventOrFinished, fakeWorkspace, lane, passVerification, temporaryExecutorRoot } from "./mass-ulw-runner-fixtures.js";
afterEach(cleanupExecutorRoots);
describe("Mass ULW execution", () => {
  it("authorizes each lane start before invoking the lane engine", async () => {
    // Given
    const stateDir = await temporaryExecutorRoot("mass-ulw-lane-authorization-");
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [lane("A"), lane("B")],
    });
    const events: string[] = [];
    const executor = new MassUlwExecutor({
      stateDir,
      repositoryRoot: stateDir,
      laneEngine: {
        async execute(request) {
          events.push(`execute:${request.lane.id}:${request.attemptNumber}`);
          return { outputFingerprint: `output-${request.lane.id}`, approachFingerprint: "initial" };
        },
      },
      verificationEngine: passVerification(events),
      authorizeLaneStart: async (request) => {
        events.push(`authorize:${request.lane.id}:${request.attemptNumber}`);
      },
      workspaceFactory: async () => fakeWorkspace(plan, events, () => undefined),
    });

    // When
    await executor.execute({ loopId: "lane-authorization", plan });

    // Then
    for (const laneId of ["A", "B"]) {
      const authorization = `authorize:${laneId}:1`;
      expect(events).toContain(authorization);
      expect(events.indexOf(authorization)).toBeLessThan(events.indexOf(`execute:${laneId}:1`));
    }
  });

  it("authorizes lane execution and lane verification at separate spawn boundaries", async () => {
    // Given
    const stateDir = await temporaryExecutorRoot("mass-ulw-spawn-authorization-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B")] });
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
      authorizeLaneExecutionStart: async (request) => { events.push(`authorize-execute:${request.lane.id}`); },
      authorizeLaneVerificationStart: async (request) => { events.push(`authorize-verify:${request.lane.id}`); },
      workspaceFactory: async () => fakeWorkspace(plan, events, () => undefined),
    });

    // When
    await executor.execute({ loopId: "spawn-authorization", plan });

    // Then
    for (const laneId of ["A", "B"]) {
      expect(events.indexOf(`authorize-execute:${laneId}`)).toBeLessThan(events.indexOf(`execute:${laneId}`));
      expect(events.indexOf(`authorize-verify:${laneId}`)).toBeGreaterThan(events.indexOf(`execute:${laneId}`));
      expect(events.indexOf(`authorize-verify:${laneId}`)).toBeLessThan(events.indexOf(`verify:${laneId}`));
    }
  });

  it("executes topological waves with parallel independent lanes", async () => {
    const stateDir = await temporaryExecutorRoot("mass-ulw-executor-state-");
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [
        lane("D", { dependsOn: ["C", "B"], writeScopes: ["src/d"] }),
        lane("C", { dependsOn: ["A"], writeScopes: ["src/c"] }),
        lane("B", { dependsOn: ["A"], writeScopes: ["src/b"] }),
        lane("A", { writeScopes: ["src/a"] }),
      ],
    });
    expect(plan).toMatchObject({ state: "fanout", recommended: true, waves: [["A"], ["B", "C"], ["D"]] });

    const events: string[] = [];
    const aStarted = deferred();
    const parallelStarted = deferred();
    const dStarted = deferred();
    const releaseA = deferred();
    const releaseParallel = deferred();
    const releaseD = deferred();
    let active = 0;
    let parallelCount = 0;
    let maxConcurrency = 0;
    let cleaned = false;
    const laneEngine: LaneEngine = {
      async execute(request) {
        events.push(`execute:${request.lane.id}:start`);
        active += 1;
        maxConcurrency = Math.max(maxConcurrency, active);
        if (request.lane.id === "A") {
          aStarted.resolve();
          await releaseA.promise;
        } else if (request.lane.id === "B" || request.lane.id === "C") {
          parallelCount += 1;
          if (parallelCount === 2) parallelStarted.resolve();
          await releaseParallel.promise;
        } else {
          dStarted.resolve();
          await releaseD.promise;
        }
        active -= 1;
        events.push(`execute:${request.lane.id}:end`);
        return { outputFingerprint: `output-${request.lane.id}`, approachFingerprint: `approach-${request.approach}` };
      },
    };
    let clock = 100;
    const executor = new MassUlwExecutor({
      stateDir,
      repositoryRoot: stateDir,
      laneEngine,
      verificationEngine: passVerification(events),
      now: () => ++clock,
      workspaceFactory: async () => fakeWorkspace(plan, events, () => { cleaned = true; }),
    });
    const execution = executor.execute({ loopId: "waves", plan });

    try {
      expect(await eventOrFinished(aStarted.promise, execution)).toBe(true);
      const atA = await new MassUlwStore(stateDir).load("waves");
      expect(atA.waves.map((waveState) => waveState.status)).toEqual(["in-flight", "planned", "planned"]);
      expect(atA.lanes.A?.status).toBe("in-flight");
      expect(events.some((event) => event.includes("execute:B"))).toBe(false);
      releaseA.resolve();

      expect(await eventOrFinished(parallelStarted.promise, execution)).toBe(true);
      const atParallel = await new MassUlwStore(stateDir).load("waves");
      expect(atParallel.waves.map((waveState) => waveState.status)).toEqual(["completed", "in-flight", "planned"]);
      expect([atParallel.lanes.B?.status, atParallel.lanes.C?.status]).toEqual(["in-flight", "in-flight"]);
      expect(active).toBe(2);
      expect(events.some((event) => event.includes("execute:D"))).toBe(false);
      releaseParallel.resolve();

      expect(await eventOrFinished(dStarted.promise, execution)).toBe(true);
      const atD = await new MassUlwStore(stateDir).load("waves");
      expect(atD.waves.map((waveState) => waveState.status)).toEqual(["completed", "completed", "in-flight"]);
      expect(atD.lanes.D?.status).toBe("in-flight");
      releaseD.resolve();

      const result = await execution;
      expect(result).toMatchObject({
        status: "completed",
        completedLaneIds: ["A", "B", "C", "D"],
        failedLaneIds: [],
        blockedLaneIds: [],
        finalVerificationInvocationCount: 1,
      });
      expect(maxConcurrency).toBe(2);
      expect(events.indexOf("verify:A")).toBeLessThan(events.indexOf("execute:B:start"));
      expect(events.indexOf("verify:B")).toBeLessThan(events.indexOf("execute:D:start"));
      expect(events.indexOf("verify:C")).toBeLessThan(events.indexOf("execute:D:start"));
      expect(events.indexOf("verify:D")).toBeLessThan(events.indexOf("integrate"));
      expect(events.slice(-4)).toEqual(["integrate", "verify-integrated:1", "publish", "cleanup"]);
      expect(cleaned).toBe(true);

      const completed = await new MassUlwStore(stateDir).load("waves");
      expect(completed.waves.every((waveState) => waveState.status === "completed")).toBe(true);
      expect(completed.waves.map((waveState) => waveState.completedAt)).toEqual([
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      ]);
      expect(completed.integrationVerification.status).toBe("passed");
      expect((await readdir(join(stateDir, "orchestration", "mass-ulw"))).sort()).toEqual(["waves.json"]);
    } finally {
      releaseA.resolve();
      releaseParallel.resolve();
      releaseD.resolve();
      await execution.catch(() => undefined);
    }
  });

});
