import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeMassUlwIdentityIndex } from "../orchestration/mass-ulw-identity-index.js";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { buildMassUlwPlan } from "../orchestration/mass-ulw.js";
import { readTaskExecutionView, type TaskExecutionSnapshot } from "./execution.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function snapshot(projectId: string): TaskExecutionSnapshot {
  return {
    projectId,
    projectName: projectId,
    goalId: null,
    loopId: "shared-loop",
    currentGoal: "Run scoped MASS ULW",
    currentTask: "Verify project isolation",
    lastProgressSummary: null,
    completed: [],
    pending: [],
    updatedAt: 100,
    lastMutation: null,
    lastVerification: null,
  };
}

describe("Control Center scoped MASS ULW identity", () => {
  it("resolves the same external loop independently for each project", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "jk-mass-ulw-view-"));
    tempDirs.push(stateDir);
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [
        { id: "A", task: "Run A", estimatedWeight: 2, writeScopes: ["src/a"] },
        { id: "B", task: "Run B", estimatedWeight: 2, writeScopes: ["src/b"] },
      ],
    });
    const store = new MassUlwStore(stateDir);
    const executionA = `mass-${"a".repeat(64)}`;
    const executionB = `mass-${"b".repeat(64)}`;
    await store.create(executionA, plan);
    await store.create(executionB, plan);
    await store.update(executionA, (document) => {
      document.lanes.A!.status = "in-flight";
    });
    await store.update(executionB, (document) => {
      document.lanes.B!.status = "failed";
    });
    await writeMassUlwIdentityIndex(stateDir, {
      version: 1,
      projectId: "project-a",
      externalLoopId: "shared-loop",
      executionId: executionA,
    });
    await writeMassUlwIdentityIndex(stateDir, {
      version: 1,
      projectId: "project-b",
      externalLoopId: "shared-loop",
      executionId: executionB,
    });

    const [viewA, viewB] = await Promise.all([
      readTaskExecutionView(stateDir, snapshot("project-a")),
      readTaskExecutionView(stateDir, snapshot("project-b")),
    ]);

    expect(viewA.massUlw?.runningLanes).toStrictEqual(["A"]);
    expect(viewA.massUlw?.failedLanes).toStrictEqual([]);
    expect(viewB.massUlw?.runningLanes).toStrictEqual([]);
    expect(viewB.massUlw?.failedLanes).toStrictEqual(["B"]);
  });
});
