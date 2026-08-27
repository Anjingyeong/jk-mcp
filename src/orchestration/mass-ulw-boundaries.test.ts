import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor } from "./mass-ulw-executor.js";
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

describe("MASS ULW trust boundaries", () => {
  it("rejects a non-canonical plan fingerprint at the persisted boundary", async () => {
    // Given
    const stateDir = await temporaryExecutorRoot("mass-ulw-fingerprint-store-");
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [lane("A"), lane("B")],
    });
    const forged = { ...plan, planFingerprint: "forged" };

    // When
    const creation = new MassUlwStore(stateDir).create("forged-store", forged);

    // Then
    await expect(creation).rejects.toThrow(/canonical plan fingerprint/iu);
  });

  it("rejects stale plan fingerprint evidence at the executor boundary", async () => {
    // Given
    const stateDir = await temporaryExecutorRoot("mass-ulw-fingerprint-executor-");
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [lane("A"), lane("B")],
    });
    const stalePlan = {
      ...plan,
      lanes: plan.lanes.map((candidate, index) => index === 0
        ? { ...candidate, task: "tampered after approval" }
        : candidate),
    };
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
      workspaceFactory: async () => fakeWorkspace(stalePlan, events, () => undefined),
    });

    // When
    const execution = executor.execute({ loopId: "stale-executor", plan: stalePlan });

    // Then
    await expect(execution).rejects.toThrow(/canonical plan fingerprint/iu);
    expect(events).not.toContain("execute:A");
  });

  it("blocks non-portable and case-fold duplicate lane IDs before approval", () => {
    // Given
    const candidates = [lane("A"), lane("a"), lane("CON")];

    // When
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates });

    // Then
    expect(plan.hardBlocks).toContain("duplicate-lane-id");
    expect(plan.hardBlocks).toContain("non-portable-lane-id:CON");
    expect(plan.recommended).toBe(false);
  });
});
