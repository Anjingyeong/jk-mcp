import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor, type LaneEngine, type VerificationEngine } from "./mass-ulw-executor.js";
import { MassUlwStore } from "./mass-ulw-store.js";
import { createMassUlwWorkspace } from "./mass-ulw-workspace.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import { cleanupExecutorRoots, git, lane, makeExecutorRepository, rmResilient, temporaryExecutorRoot } from "./mass-ulw-runner-fixtures.js";
afterEach(cleanupExecutorRoots);
describe("Mass ULW integration", () => {
  it("merges disjoint lane outputs then verifies integrated state once", async () => {
    const repositoryRoot = await makeExecutorRepository();
    const stateDir = await temporaryExecutorRoot("mass-ulw-integration-state-");
    const tempRoot = await temporaryExecutorRoot("mass-ulw-integration-clones-");
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [
        lane("B", { estimatedWeight: 5, writeScopes: ["src/b"] }),
        lane("A", { estimatedWeight: 5, writeScopes: ["src/a"] }),
      ],
    });
    expect(plan).toMatchObject({ state: "fanout", recommended: true, waves: [["A", "B"]] });

    const events: string[] = [];
    const privateRoots: string[] = [];
    const laneEngine: LaneEngine = {
      async execute(request) {
        const relative = `src/${request.lane.id.toLowerCase()}/from-${request.lane.id.toLowerCase()}.txt`;
        const absolute = join(request.checkout.root, ...relative.split("/"));
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, `${request.lane.id}\n`);
        await git(request.checkout.root, ["add", "-A"]);
        await git(request.checkout.root, ["commit", "-q", "-m", `lane ${request.lane.id}`]);
        events.push(`execute:${request.lane.id}`);
        return { outputFingerprint: `commit-${request.lane.id}`, approachFingerprint: `approach-${request.lane.id}` };
      },
    };
    let integratedInvocationCount = 0;
    const verificationEngine: VerificationEngine = {
      async verifyLane(request) {
        const relative = `src/${request.lane.id.toLowerCase()}/from-${request.lane.id.toLowerCase()}.txt`;
        expect(await readFile(join(request.checkout.root, ...relative.split("/")), "utf8")).toBe(`${request.lane.id}\n`);
        events.push(`verify:${request.lane.id}`);
        return { passed: true, fingerprint: `lane-verified-${request.lane.id}` };
      },
      async verifyIntegrated(request) {
        integratedInvocationCount += 1;
        expect(request.invocationCount).toBe(1);
        expect(await readFile(join(request.root, "src", "a", "from-a.txt"), "utf8")).toBe("A\n");
        expect(await readFile(join(request.root, "src", "b", "from-b.txt"), "utf8")).toBe("B\n");
        events.push("verify-integrated");
        return { passed: true, fingerprint: request.fingerprint };
      },
    };
    const executor = new MassUlwExecutor({
      stateDir,
      repositoryRoot,
      tempRoot,
      laneEngine,
      verificationEngine,
      authorizeIntegratedVerification: async () => {
        events.push("authorize-verify");
      },
      authorizePublish: async () => {
        events.push("authorize-publish");
      },
      workspaceFactory: async (options) => {
        const workspace = await createMassUlwWorkspace(options);
        privateRoots.push(workspace.privateRoot);
        return {
          privateRoot: workspace.privateRoot,
          lanes: workspace.lanes,
          async integrate() {
            events.push("integrate");
            return workspace.integrate();
          },
          async publish() {
            events.push("publish");
            return workspace.publish();
          },
          async cleanup() {
            events.push("cleanup");
            await workspace.cleanup();
          },
        };
      },
    });
    const result = await executor.execute({ loopId: "integration", plan });

    expect(result).toMatchObject({
      status: "completed",
      changedPaths: ["src/a/from-a.txt", "src/b/from-b.txt"],
      finalVerificationInvocationCount: 1,
    });
    expect(result.laneCommits.map((commit) => commit.id)).toEqual(["A", "B"]);
    expect(await readFile(join(repositoryRoot, "src", "a", "from-a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(join(repositoryRoot, "src", "b", "from-b.txt"), "utf8")).toBe("B\n");
    expect(events.filter((event) => event.startsWith("verify:")).sort()).toEqual(["verify:A", "verify:B"]);
    expect(events.indexOf("verify:A")).toBeLessThan(events.indexOf("integrate"));
    expect(events.indexOf("verify:B")).toBeLessThan(events.indexOf("integrate"));
    expect(events.indexOf("integrate")).toBeLessThan(events.indexOf("verify-integrated"));
    expect(events).toContain("authorize-verify");
    expect(events).toContain("authorize-publish");
    expect(events.indexOf("authorize-verify")).toBeLessThan(events.indexOf("verify-integrated"));
    expect(events.indexOf("verify-integrated")).toBeLessThan(events.indexOf("publish"));
    expect(events.indexOf("authorize-publish")).toBeLessThan(events.indexOf("publish"));
    expect(integratedInvocationCount).toBe(1);

    const resumed = await executor.execute({ loopId: "integration", plan });
    expect(resumed).toMatchObject({ status: "completed", finalVerificationInvocationCount: 1 });
    expect(events.filter((event) => event.startsWith("execute:")).sort()).toEqual(["execute:A", "execute:B"]);
    expect(integratedInvocationCount).toBe(1);
    expect(privateRoots).toHaveLength(1);
    await expect(stat(privateRoots[0]!)).rejects.toThrow();
    expect(await readdir(tempRoot)).toEqual([]);
    expect((await readdir(join(stateDir, "orchestration", "mass-ulw"))).sort()).toEqual(["integration.json"]);
    const persisted = await new MassUlwStore(stateDir).load("integration");
    expect(persisted.integrationVerification.status).toBe("passed");
    expect(persisted.attempts.filter((attempt) => attempt.kind === "integration-verification")).toHaveLength(1);
    expect(persisted.publishJournal).toHaveLength(1);
    expect(persisted.publishJournal[0]?.status).toBe("published");
    expect(basename(privateRoots[0]!)).toMatch(/^mass-ulw-/u);
  });

  it("makes prerequisite outputs visible to dependent lanes", async () => {
    const repositoryRoot = await makeExecutorRepository();
    const stateDir = await temporaryExecutorRoot("mass-ulw-dependent-state-");
    const tempRoot = await temporaryExecutorRoot("mass-ulw-dependent-work-");
    const plan = buildMassUlwPlan({
      executionProfile: "max",
      candidates: [
        lane("A", { writeScopes: ["src/a"] }),
        lane("B", { readScopes: ["src/a"], writeScopes: ["src/b"], dependsOn: ["A"] }),
      ],
    });
    const laneEngine: LaneEngine = {
      async execute(request) {
        if (request.lane.id === "B") {
          expect(await readFile(join(request.checkout.root, "src", "a", "result.txt"), "utf8")).toBe("from A\n");
        }
        const output = join(request.checkout.root, "src", request.lane.id.toLowerCase(), "result.txt");
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, request.lane.id === "A" ? "from A\n" : "from B\n");
        await git(request.checkout.root, ["add", "-A"]);
        await git(request.checkout.root, ["commit", "-q", "-m", `lane ${request.lane.id}`]);
        return {
          outputFingerprint: `output-${request.lane.id}`,
          approachFingerprint: `approach-${request.lane.id}`,
        };
      },
    };
    const verificationEngine: VerificationEngine = {
      async verifyLane(request) {
        return { passed: true, fingerprint: `verified-${request.lane.id}` };
      },
      async verifyIntegrated(request) {
        return { passed: true, fingerprint: request.fingerprint };
      },
    };

    const result = await new MassUlwExecutor({
      stateDir,
      repositoryRoot,
      tempRoot,
      laneEngine,
      verificationEngine,
    }).execute({ loopId: "dependent-visibility", plan });

    expect(result.status).toBe("completed");
    expect(await readFile(join(repositoryRoot, "src", "a", "result.txt"), "utf8")).toBe("from A\n");
    expect(await readFile(join(repositoryRoot, "src", "b", "result.txt"), "utf8")).toBe("from B\n");
  // Real git clone/integrate cycles; 15s+ per lane under load.
  }, 120_000);
});
