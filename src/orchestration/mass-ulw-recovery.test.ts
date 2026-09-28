import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor, encodeMassUlwAttemptFingerprint, parseMassUlwAttemptFingerprint, type LaneEngine, type LaneExecutionRequest } from "./mass-ulw-executor.js";
import { MassUlwStore } from "./mass-ulw-store.js";
import { MassUlwStageError } from "./mass-ulw-failure.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import { cleanupExecutorRoots, fakeWorkspace, lane, passVerification, temporaryExecutorRoot } from "./mass-ulw-runner-fixtures.js";
afterEach(cleanupExecutorRoots);
describe("Mass ULW recovery", () => {
  it("native-evolution R12 preparation failure in a repaired generation remains exhausted on reconnect", async () => {
    const stateDir = await temporaryExecutorRoot("native-evolution-B-repair-preparation-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B")] });
    let patch = "p0"; let preparations = 0;
    const events: string[] = [];
    const executor = new MassUlwExecutor({ stateDir, repositoryRoot: stateDir,
      laneEngine: { failurePolicy: "repair-required", approachFingerprint: () => patch,
        async restore() {}, async execute(request) { return { outputFingerprint: request.lane.id, approachFingerprint: patch }; },
      }, verificationEngine: { ...passVerification(events), async verifyLane(request) { return { passed: request.lane.id === "B", fingerprint: patch }; } },
      workspaceFactory: async () => ({ ...fakeWorkspace(plan, events, () => undefined), async prepareLane(id) {
        if (id === "A") { preparations += 1; if (patch === "p1") throw new MassUlwStageError({ laneId: id, stage: "checkout", retryable: false, message: "changed strategy checkout conflict" }); }
      } }),
    });
    await executor.execute({ loopId: "repair-prepare", plan });
    patch = "p1";
    const input = { loopId: "repair-prepare", plan, repairStrategies: { A: { generation: 1, approach: "new patch", evidence: "first failure" } } };
    expect((await executor.execute(input)).status).toBe("blocked");
    expect((await executor.execute(input)).status).toBe("blocked");
    expect(preparations).toBe(2);
  });
  it("native-evolution R12 generations retain failed histories and never refill an unchanged native approach", async () => {
    const stateDir = await temporaryExecutorRoot("native-evolution-B-generations-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B")] });
    let patch = "p0";
    const events: string[] = [];
    const store = new MassUlwStore(stateDir);
    const executor = new MassUlwExecutor({ stateDir, repositoryRoot: stateDir, store,
      laneEngine: { failurePolicy: "repair-required", approachFingerprint: (id) => id === "A" ? patch : "peer",
        async restore(request) { events.push(`restore:${request.lane.id}`); },
        async execute(request) { events.push(`execute:${request.lane.id}`); return { outputFingerprint: patch, approachFingerprint: request.lane.id === "A" ? patch : "peer" }; },
      }, verificationEngine: { ...passVerification(events), async verifyLane(request) { return { passed: request.lane.id === "B" || patch === "p2", fingerprint: patch }; } },
      workspaceFactory: async () => fakeWorkspace(plan, events, () => undefined),
    });
    expect((await executor.execute({ loopId: "generations", plan })).status).toBe("blocked");
    patch = "p1";
    const input = { loopId: "generations", plan, repairStrategies: { A: { generation: 1, approach: "second approach", evidence: "first verifier failure" } } };
    expect((await executor.execute(input)).status).toBe("blocked");
    expect((await executor.execute(input)).status).toBe("blocked");
    expect(events.filter((event) => event === "execute:A")).toHaveLength(2);
    await expect(executor.execute({ ...input, repairStrategies: { A: { generation: 2, approach: "third approach", evidence: "second verifier failure" } } })).rejects.toThrow();
    patch = "p2";
    const repaired = await executor.execute({ ...input, repairStrategies: { A: { generation: 2, approach: "third approach", evidence: "second verifier failure" } } });
    expect(repaired.status).toBe("completed");
    const after = await store.load("generations");
    expect(after.attempts.filter((attempt) => attempt.laneId === "A").map((attempt) => ({
      status: attempt.status, generation: parseMassUlwAttemptFingerprint(attempt.fingerprint)?.strategyGeneration,
    }))).toEqual([{ status: "failed", generation: 0 }, { status: "failed", generation: 1 }, { status: "completed", generation: 2 }]);
    expect(events.filter((event) => event === "execute:B")).toHaveLength(1);
    expect(after.lanes.A?.attempts).toBe(3);
  });
  it("resumes durable waves and changes approach after repeated failure", async () => {
    const stateDir = await temporaryExecutorRoot("mass-ulw-recovery-state-");
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [
        lane("C", { dependsOn: ["B"], writeScopes: ["src/c"] }),
        lane("B", { dependsOn: ["A"], writeScopes: ["src/b"] }),
        lane("A", { writeScopes: ["src/a"] }),
      ],
    });
    const store = new MassUlwStore(stateDir, { now: () => 500 });
    await store.create("recovery", plan);
    await store.update("recovery", (document) => {
      document.lanes.A!.status = "completed";
      document.lanes.A!.attempts = 1;
      document.lanes.A!.completedAt = 200;
      document.lanes.B!.status = "failed";
      document.lanes.B!.attempts = 2;
      document.waves[0]!.status = "completed";
      document.waves[0]!.completedAt = 200;
      document.waves[1]!.status = "failed";
      document.currentWave = 1;
      document.fingerprints.lanes.A = "output-A";
      document.attempts.push(
        {
          id: "lane-A-1",
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
            outputFingerprint: "output-A",
          }),
        },
        {
          id: "lane-B-1",
          kind: "lane",
          laneId: "B",
          status: "failed",
          startedAt: 210,
          completedAt: 220,
          fingerprint: encodeMassUlwAttemptFingerprint({
            version: 1,
            approach: "initial",
            approachFingerprint: "approach-B-initial",
            previousFailureFingerprint: null,
            previousApproachFingerprint: null,
            failureFingerprint: "repeatable-B-failure",
          }),
        },
        {
          id: "lane-B-2",
          kind: "lane",
          laneId: "B",
          status: "failed",
          startedAt: 230,
          completedAt: 240,
          fingerprint: encodeMassUlwAttemptFingerprint({
            version: 1,
            approach: "inspect-assumption",
            approachFingerprint: "approach-B-inspected",
            previousFailureFingerprint: "repeatable-B-failure",
            previousApproachFingerprint: "approach-B-initial",
            failureFingerprint: "repeatable-B-failure",
          }),
        },
      );
    });

    const events: string[] = [];
    const requests: LaneExecutionRequest[] = [];
    let cleanupCount = 0;
    const laneEngine: LaneEngine = {
      async restore(request) {
        events.push(`restore:${request.lane.id}:${request.outputFingerprint}`);
      },
      async execute(request) {
        requests.push(request);
        events.push(`execute:${request.lane.id}:${request.approach}`);
        return {
          outputFingerprint: `output-${request.lane.id}`,
          approachFingerprint: request.lane.id === "B" ? "approach-B-materially-different" : `approach-${request.lane.id}`,
        };
      },
    };
    const executor = new MassUlwExecutor({
      stateDir,
      repositoryRoot: stateDir,
      laneEngine,
      verificationEngine: passVerification(events),
      now: () => 600,
      workspaceFactory: async () => fakeWorkspace(plan, events, () => { cleanupCount += 1; }),
    });

    const result = await executor.execute({ loopId: "recovery", plan });
    expect(result.status).toBe("completed");
    expect(events).toContain("restore:A:output-A");
    expect(requests.map((request) => request.lane.id)).toEqual(["B", "C"]);
    expect(requests[0]).toMatchObject({
      lane: { id: "B" },
      attemptNumber: 3,
      approach: "materially-different-approach",
      previousFailureFingerprint: "repeatable-B-failure",
      previousApproachFingerprint: "approach-B-inspected",
    });
    const recovered = await store.load("recovery");
    expect(recovered.lanes.A?.attempts).toBe(1);
    expect(recovered.lanes.B).toMatchObject({ status: "completed", attempts: 3 });
    expect(parseMassUlwAttemptFingerprint(recovered.attempts.filter((attempt) => attempt.laneId === "B").at(-1)?.fingerprint))
      .toMatchObject({
        approach: "materially-different-approach",
        approachFingerprint: "approach-B-materially-different",
        previousFailureFingerprint: "repeatable-B-failure",
        previousApproachFingerprint: "approach-B-inspected",
        outputFingerprint: "output-B",
      });

    const blockedPlan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [lane("X", { writeScopes: ["src/x"] }), lane("Y", { dependsOn: ["X"], writeScopes: ["src/y"] })],
    });
    await store.create("blocked-descendant", blockedPlan);
    await store.update("blocked-descendant", (document) => {
      document.lanes.X!.status = "failed";
      document.lanes.X!.attempts = 3;
      document.waves[0]!.status = "failed";
      for (const [index, approach] of (["initial", "inspect-assumption", "materially-different-approach"] as const).entries()) {
        document.attempts.push({
          id: `lane-X-${index + 1}`,
          kind: "lane",
          laneId: "X",
          status: "failed",
          startedAt: 300 + index * 10,
          completedAt: 305 + index * 10,
          fingerprint: encodeMassUlwAttemptFingerprint({
            version: 1,
            approach,
            approachFingerprint: `approach-X-${index + 1}`,
            previousFailureFingerprint: index === 0 ? null : "repeatable-X-failure",
            previousApproachFingerprint: index === 0 ? null : `approach-X-${index}`,
            failureFingerprint: "repeatable-X-failure",
          }),
        });
      }
    });
    const callsBeforeBlock = requests.length;
    const blocked = await new MassUlwExecutor({
      stateDir,
      repositoryRoot: stateDir,
      laneEngine,
      verificationEngine: passVerification(events),
      workspaceFactory: async () => fakeWorkspace(blockedPlan, events, () => { cleanupCount += 1; }),
    }).execute({ loopId: "blocked-descendant", plan: blockedPlan });
    expect(blocked).toMatchObject({ status: "blocked", failedLaneIds: ["X"], blockedLaneIds: ["Y"] });
    expect(requests).toHaveLength(callsBeforeBlock);
    expect((await store.load("blocked-descendant")).lanes.Y?.status).toBe("blocked");
    expect(cleanupCount).toBe(2);
    expect((await readdir(join(stateDir, "orchestration", "mass-ulw"))).every((name) => !name.endsWith(".lock"))).toBe(true);
  });

});
