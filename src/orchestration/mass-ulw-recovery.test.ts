import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor, encodeMassUlwAttemptFingerprint, parseMassUlwAttemptFingerprint, type LaneEngine, type LaneExecutionRequest } from "./mass-ulw-executor.js";
import { MassUlwStore } from "./mass-ulw-store.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import { cleanupExecutorRoots, fakeWorkspace, lane, passVerification, temporaryExecutorRoot } from "./mass-ulw-runner-fixtures.js";
afterEach(cleanupExecutorRoots);
describe("Mass ULW recovery", () => {
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
