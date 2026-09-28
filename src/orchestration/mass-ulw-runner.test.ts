import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor, type LaneEngine } from "./mass-ulw-executor.js";
import { MassUlwStore, type MassUlwDocument } from "./mass-ulw-store.js";
import { MassUlwStageError } from "./mass-ulw-failure.js";
import { PlanSchema } from "./mass-ulw-store-schema.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import { cleanupExecutorRoots, deferred, eventOrFinished, fakeWorkspace, lane, passVerification, temporaryExecutorRoot } from "./mass-ulw-runner-fixtures.js";
afterEach(cleanupExecutorRoots);
describe("Mass ULW execution", () => {
  it("native-evolution R11 admits all four independent approved lanes concurrently", async () => {
    const stateDir = await temporaryExecutorRoot("native-evolution-B-cap-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B"), lane("C"), lane("D")] });
    const started = deferred(); const release = deferred(); const events: string[] = []; let active = 0;
    const executor = new MassUlwExecutor({ stateDir, repositoryRoot: stateDir,
      laneEngine: { async execute(request) { active += 1; if (active === 4) started.resolve(); await release.promise; active -= 1; return { outputFingerprint: request.lane.id, approachFingerprint: request.lane.id }; } },
      verificationEngine: passVerification(events), workspaceFactory: async () => { events.push("workspace"); return fakeWorkspace(plan, events, () => undefined); },
    });
    const execution = executor.execute({ loopId: "cap", plan });
    try { expect(await eventOrFinished(started.promise, execution)).toBe(true); expect(active).toBe(4); }
    finally { release.resolve(); expect((await execution).status).toBe("completed"); }
    expect(events.filter((event) => event === "workspace")).toHaveLength(1);
  });
  it("native-evolution R11 rejects a schema-valid fifth total lane before state or workspace admission", async () => {
    const stateDir = await temporaryExecutorRoot("B-total-admission-evidence-");
    const oversized = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B"), lane("C"), lane("D"), lane("E")] });
    // Remove planner policy flags, but retain canonical identity and topological
    // waves: rejection must come from execution's total-lane admission guard.
    const plan = PlanSchema.parse({ ...oversized, hardBlocks: [], maxLanes: 5, recommended: true, state: "fanout" });
    const events: string[] = [];
    const executor = new MassUlwExecutor({ stateDir, repositoryRoot: stateDir,
      laneEngine: { async execute(request) { events.push(`execute:${request.lane.id}`); return { outputFingerprint: request.lane.id, approachFingerprint: request.lane.id }; } },
      verificationEngine: passVerification(events),
      workspaceFactory: async () => { events.push("workspace"); return fakeWorkspace(plan, events, () => undefined); },
    });
    await expect(executor.execute({ loopId: "forged-cap", plan })).rejects.toBeInstanceOf(Error);
    expect(events).toEqual([]);
    expect(await readdir(join(stateDir, "orchestration", "mass-ulw"))).not.toContain("forged-cap.json");
  });
  it("native-evolution R11 admits a verified fast parent's child while unrelated slow B is held", async () => {
    const stateDir = await temporaryExecutorRoot("native-evolution-B-ready-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B"), lane("C", { dependsOn: ["A"] }), lane("D", { dependsOn: ["B"] })] });
    const events: string[] = [];
    const bStarted = deferred(); const cStarted = deferred(); const releaseB = deferred(); const releaseC = deferred();
    let active = 0; let maximum = 0;
    const execution = new MassUlwExecutor({ stateDir, repositoryRoot: stateDir,
      laneEngine: { async execute(request) {
        active += 1; maximum = Math.max(maximum, active);
        events.push(`start:${request.lane.id}`);
        if (request.lane.id === "A") await bStarted.promise;
        if (request.lane.id === "B") { bStarted.resolve(); await releaseB.promise; }
        if (request.lane.id === "C") { cStarted.resolve(); await releaseC.promise; }
        active -= 1;
        return { outputFingerprint: request.lane.id, approachFingerprint: request.lane.id };
      } }, verificationEngine: passVerification(events), workspaceFactory: async () => fakeWorkspace(plan, events, () => undefined),
    }).execute({ loopId: "ready", plan });
    try {
      expect(await eventOrFinished(cStarted.promise, execution)).toBe(true);
      const during = await new MassUlwStore(stateDir).load("ready");
      expect(during).toMatchObject({ scheduler: "dependency-ready" });
      expect(during.lanes.B?.status).toBe("in-flight");
      expect(during.waves[0]?.status).toBe("in-flight");
      expect(events.indexOf("verify:A")).toBeLessThan(events.indexOf("start:C"));
      expect(events).not.toContain("start:D");
    } finally {
      releaseB.resolve(); releaseC.resolve();
      expect((await execution).status).toBe("completed");
    }
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it("native-evolution R11 typed lane preparation failure isolates only descendant closure", async () => {
    const stateDir = await temporaryExecutorRoot("native-evolution-B-prepare-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B"), lane("C", { dependsOn: ["A"] }), lane("D", { dependsOn: ["B"] })] });
    const events: string[] = [];
    const result = await new MassUlwExecutor({ stateDir, repositoryRoot: stateDir,
      laneEngine: { async execute(request) { events.push(request.lane.id); return { outputFingerprint: request.lane.id, approachFingerprint: request.lane.id }; } },
      verificationEngine: passVerification(events), workspaceFactory: async () => ({ ...fakeWorkspace(plan, events, () => undefined),
        async prepareLane(id) { if (id === "A") throw new MassUlwStageError({ laneId: id, stage: "checkout", retryable: false, message: "fixture lane-local checkout conflict" }); },
      }),
    }).execute({ loopId: "prepare", plan });
    expect(result).toMatchObject({ status: "blocked", completedLaneIds: ["B", "D"], failedLaneIds: ["A"], blockedLaneIds: ["C"],
      failureDiagnostics: [expect.objectContaining({ laneId: "A", stage: "checkout", retryable: false })] });
    expect(events).not.toContain("A"); expect(events).not.toContain("C");
    expect((await new MassUlwStore(stateDir).load("prepare")).waves.map((wave) => wave.status)).toEqual(["failed", "failed"]);
  });

  it.each(["preparation", "store", "authorization"] as const)("native-evolution R11 global %s failure stops admission and drains started work before cleanup", async (boundary) => {
    const stateDir = await temporaryExecutorRoot("native-evolution-B-global-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B"), lane("C", { dependsOn: ["A"] }), lane("D", { dependsOn: ["B"] })] });
    const events: string[] = []; const bStarted = deferred(); const failed = deferred(); const releaseB = deferred();
    const fault = new Error(`global-${boundary}`); let bSettled = false; let injected = false;
    class FaultStore extends MassUlwStore {
      protected override async persist(document: MassUlwDocument) {
        if (boundary === "store" && !injected && document.lanes.A?.status === "completed") {
          injected = true; failed.resolve(); throw fault;
        }
        await super.persist(document);
      }
    }
    const store = new FaultStore(stateDir);
    const execution = new MassUlwExecutor({ stateDir, repositoryRoot: stateDir, store,
      laneEngine: { async execute(request) {
        events.push(request.lane.id);
        if (request.lane.id === "A") await bStarted.promise;
        if (request.lane.id === "B") { bStarted.resolve(); await releaseB.promise; bSettled = true; }
        return { outputFingerprint: request.lane.id, approachFingerprint: request.lane.id };
      } }, verificationEngine: passVerification(events),
      authorizeLaneExecutionStart: async (request) => {
        if (boundary === "authorization" && request.lane.id === "A") { await bStarted.promise; failed.resolve(); throw fault; }
      },
      workspaceFactory: async () => ({ ...fakeWorkspace(plan, events, () => { expect(bSettled).toBe(true); }),
        async prepareLane(id) {
          if (boundary !== "preparation") return;
          if (id === "A") { await bStarted.promise; failed.resolve(); throw fault; }
          if (id === "B") { bStarted.resolve(); await releaseB.promise; bSettled = true; }
        },
      }),
    }).execute({ loopId: "global", plan });
    const outcome = execution.then((result) => ({ result }), (error: unknown) => ({ error }));
    try {
      expect(await eventOrFinished(failed.promise, outcome)).toBe(true);
      await store.load("global");
      expect(events).not.toContain("cleanup");
    } finally {
      releaseB.resolve();
      expect(await outcome).toEqual({ error: fault });
    }
    expect(events).not.toContain("C"); expect(events).not.toContain("D");
    expect(events.at(-1)).toBe("cleanup");
  });
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
      await execution;
    }
  });

});
