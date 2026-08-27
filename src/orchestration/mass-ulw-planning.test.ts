import { describe, expect, it } from "vitest";
import { buildMassUlwPlan, parseMassUlwCandidates, type MassUlwCandidate } from "./mass-ulw.js";
const lane = (id: string, extra: Partial<MassUlwCandidate> = {}): MassUlwCandidate => ({ id, task: `Implement ${id}`, estimatedWeight: 3, writeScopes: [`src/${id}`], ...extra });
describe("Mass ULW planning", () => {
  it("rejects invalid graphs and conflicting write scopes while preserving Fast", () => {
    expect(parseMassUlwCandidates([{ id: " A ", task: "work", estimatedWeight: 2 }])).toEqual([
      { id: "A", task: "work", estimatedWeight: 2 },
    ]);
    expect(() => parseMassUlwCandidates([{ id: "A", task: "work", estimatedWeight: "2" }])).toThrow();

    const diamond = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [
        lane("A", { estimatedWeight: 2, writeScopes: ["./SRC/shared/"] }),
        lane("B", { estimatedWeight: 3, readScopes: ["src/shared/file.ts"], writeScopes: ["src/b"], dependsOn: ["A"] }),
        lane("C", { estimatedWeight: 4, dependsOn: ["A"] }),
        lane("D", { estimatedWeight: 5, dependsOn: ["B", "C"] }),
      ],
    });
    expect(diamond.hardBlocks).toEqual([]);
    expect(diamond.waves).toEqual([["A"], ["B", "C"], ["D"]]);
    expect(diamond).toMatchObject({ serialWork: 14, criticalPathWork: 11 });

    const reordered = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [
        lane("D", { estimatedWeight: 5, dependsOn: ["C", "B"] }),
        lane("C", { estimatedWeight: 4, dependsOn: ["A"] }),
        lane("B", { estimatedWeight: 3, readScopes: ["SRC\\shared\\file.ts"], writeScopes: ["src/b"], dependsOn: ["A"] }),
        lane("A", { estimatedWeight: 2, writeScopes: ["src/shared"] }),
      ],
    });
    expect(reordered.planFingerprint).toBe(diamond.planFingerprint);
    expect(reordered.waves).toEqual(diamond.waves);

    const blockedBy = (candidates: MassUlwCandidate[]) =>
      buildMassUlwPlan({ executionProfile: "max", candidates }).hardBlocks;
    expect(blockedBy([lane("A"), lane("A")])).toContain("duplicate-lane-id");
    expect(blockedBy([lane("A", { dependsOn: ["missing"] }), lane("B")])).toContain("unknown-dependency:A->missing");
    expect(blockedBy([lane("A", { dependsOn: ["A"] }), lane("B")])).toContain("self-dependency:A");
    expect(blockedBy([lane("A", { dependsOn: ["B"] }), lane("B", { dependsOn: ["A"] })])).toContain("dependency-cycle");

    const writeWrite = blockedBy([lane("A", { writeScopes: ["src/shared"] }), lane("B", { writeScopes: ["src/shared/a.ts"] })]);
    expect(writeWrite.join(" ")).toContain("scope-collision:A<->B");
    const dependentWriteWrite = blockedBy([
      lane("A", { writeScopes: ["src/shared"] }),
      lane("B", { writeScopes: ["src/shared/a.ts"], dependsOn: ["A"] }),
    ]);
    expect(dependentWriteWrite.join(" ")).toContain("scope-collision:A<->B");
    const writeRead = blockedBy([
      lane("A", { writeScopes: ["src/shared"] }),
      lane("B", { writeScopes: [], readScopes: ["src/shared/a.ts"] }),
    ]);
    expect(writeRead.join(" ")).toContain("scope-collision:A<->B");
    expect(blockedBy([
      lane("A", { writeScopes: [], readScopes: ["src/shared"] }),
      lane("B", { writeScopes: [], readScopes: ["src/shared/a.ts"] }),
    ]).join(" ")).not.toContain("scope-collision");
    expect(blockedBy([
      lane("A", { writeScopes: ["src/shared"] }),
      lane("B", { readScopes: ["src/shared/a.ts"], dependsOn: ["A"] }),
    ]).join(" ")).not.toContain("scope-collision");
    expect(blockedBy([lane("A", { writeScopes: ["../outside"] }), lane("B")]).join(" ")).toContain("unsafe-scope:A:write");

    const independent = [
      lane("A", { estimatedWeight: 5, writeScopes: ["src/a"] }),
      lane("B", { estimatedWeight: 5, writeScopes: ["src/b"] }),
    ];
    expect(buildMassUlwPlan({ executionProfile: "fast", candidates: independent })).toMatchObject({
      state: "sequential",
      recommended: false,
      hardBlocks: [],
    });
    const smallReads = [
      lane("A", { estimatedWeight: 1, writeScopes: [], readScopes: ["src/a"], task: "Inspect A" }),
      lane("B", { estimatedWeight: 1, writeScopes: [], readScopes: ["src/b"], task: "Inspect B" }),
    ];
    expect(buildMassUlwPlan({ executionProfile: "auto", candidates: smallReads })).toMatchObject({
      state: "sequential",
      recommended: false,
      threshold: 0.75,
      netGain: 0.45,
    });
    expect(buildMassUlwPlan({ executionProfile: "max", candidates: smallReads })).toMatchObject({
      state: "fanout",
      recommended: true,
      threshold: 0.25,
      netGain: 1.2,
    });
  });
});
