import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCommands } from "../exec/command-runner.js";
import { createMassUlwExecutionIdentity } from "../server/mass-ulw-identity.js";
import { createMassUlwProcesses, type MassUlwExecuteInput } from "../server/mass-ulw-processes.js";
import { MassUlwExecutor, parseMassUlwAttemptFingerprint } from "./mass-ulw-executor.js";
import { MassUlwStore, type MassUlwDocument } from "./mass-ulw-store.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import { cleanupExecutorRoots, git, lane, makeExecutorRepository, temporaryExecutorRoot } from "./mass-ulw-runner-fixtures.js";

// Real Git/Node verifier cycles can exceed the global Windows timeout while the
// full suite is launching other child processes in parallel.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

afterEach(cleanupExecutorRoots);

const patch = (id: string, value: string) => `*** Begin Patch\n*** Add File: src/${id.toLowerCase()}/result.txt\n+${value}\n*** End Patch`;
const attemptsFor = (document: MassUlwDocument, id: string) => document.attempts.filter((attempt) => attempt.laneId === id);

// No command/result mocks: counters are written by the actual discovered verifier
// processes outside the checkout, so restored artifacts cannot reset the evidence.
async function nativeFixture() {
  const root = await makeExecutorRepository();
  const stateDir = await temporaryExecutorRoot("B-generation-evidence-state-");
  const counts = { A: join(stateDir, "A.calls"), B: join(stateDir, "B.calls") };
  await Promise.all(Object.values(counts).map((path) => writeFile(path, "")));
  await writeFile(join(root, "verify.cjs"), [
    "const fs = require('node:fs');",
    "const assert = require('node:assert/strict');",
    `const counts = ${JSON.stringify(counts)};`,
    "const id = process.argv[2];",
    "if (id !== 'all') fs.appendFileSync(counts[id], 'call\\n');",
    "for (const lane of id === 'all' ? ['A', 'B'] : [id]) {",
    "  assert.equal(fs.readFileSync('src/' + lane.toLowerCase() + '/result.txt', 'utf8').trim(), 'accepted');",
    "}",
  ].join("\n"));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
    test: "node verify.cjs A", lint: "node verify.cjs B", verify: "node verify.cjs all",
  } }));
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "verifier fixture"]);
  const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [
    lane("A", { writeScopes: ["src/a"] }), lane("B", { writeScopes: ["src/b"] }),
  ] });
  const identity = await createMassUlwExecutionIdentity({ projectId: "B-evidence", repositoryRoot: root, externalLoopId: "generations" });
  const verifierFingerprints = new Map((await listCommands(root)).map((command) => [command.commandId, command.manifestFingerprint]));
  const initial: MassUlwExecuteInput = {
    projectId: identity.projectId, loopId: identity.externalLoopId, workSessionId: "B-evidence",
    planFingerprint: plan.planFingerprint, lanePatches: { A: patch("A", "wrong-zero"), B: patch("B", "accepted") },
    laneVerificationCommandIds: { A: "npm:test", B: "npm:lint" }, finalVerificationCommandId: "npm:verify",
  };
  // Every invocation reconnects through new native adapters, executor and Store.
  const execute = (input: MassUlwExecuteInput, beforeWorkspace?: () => never) => {
    const processes = createMassUlwProcesses({ ctx: { stateDir }, input, identity, verifierFingerprints });
    return new MassUlwExecutor({ stateDir, repositoryRoot: root, tempRoot: stateDir,
      laneEngine: processes.laneEngine, verificationEngine: processes.verificationEngine,
      ...(beforeWorkspace ? { workspaceFactory: async () => beforeWorkspace() } : {}),
    }).execute({ loopId: identity.executionId, plan, repairStrategies: input.repairStrategies });
  };
  const load = () => new MassUlwStore(stateDir).load(identity.executionId);
  const calls = async (id: "A" | "B") => (await readFile(counts[id], "utf8")).split("\n").filter(Boolean).length;
  const repair = (generation: number, value: string, approach = `approach-${generation}`): MassUlwExecuteInput => ({
    ...initial, lanePatches: { ...initial.lanePatches, A: patch("A", value) },
    repairStrategies: { A: { generation, approach, evidence: "Native Node verifier rejected the recorded prior output" } },
  });
  expect(await execute(initial)).toMatchObject({ status: "blocked", completedLaneIds: ["B"], failedLaneIds: ["A"] });
  const initialState = await load();
  expect(attemptsFor(initialState, "A")).toMatchObject([{ status: "failed", failure: { stage: "verification", exitCode: 1 } }]);
  expect(await calls("A")).toBe(1);
  return { root, execute, load, calls, repair };
}

describe("B independent native generation evidence", () => {
  it("exhausts a newly opened generation after exactly one executed failure", async () => {
    const fixture = await nativeFixture();
    const before = await fixture.load();
    await fixture.execute(fixture.repair(1, "wrong-one"));
    const after = await fixture.load();
    expect(await fixture.calls("A")).toBe(2);
    expect(attemptsFor(after, "A").map((attempt) => ({
      generation: parseMassUlwAttemptFingerprint(attempt.fingerprint)?.strategyGeneration, status: attempt.status,
    }))).toEqual([{ generation: 0, status: "failed" }, { generation: 1, status: "failed" }]);
    expect(attemptsFor(after, "A").slice(0, 1)).toEqual(attemptsFor(before, "A"));
    expect(after.lanes.A?.attempts).toBe(2);
  });

  it("does not refill an exhausted generation on explicit replay or omitted-strategy reconnect", async () => {
    const fixture = await nativeFixture();
    const input = fixture.repair(1, "wrong-one");
    await fixture.execute(input);
    const before = await fixture.load();
    const calls = await fixture.calls("A");
    await fixture.execute(input);
    await fixture.execute({ ...input, repairStrategies: undefined });
    expect(await fixture.calls("A")).toBe(calls);
    const after = await fixture.load();
    expect(attemptsFor(after, "A")).toEqual(attemptsFor(before, "A"));
    expect(after.lanes.A).toEqual(before.lanes.A);
  });

  it.each(["patch", "approach"] as const)("rejects a new generation with an unchanged %s independently", async (unchanged) => {
    const fixture = await nativeFixture();
    await fixture.execute(fixture.repair(1, "wrong-one"));
    const before = await fixture.load();
    const calls = await fixture.calls("A");
    const invalid = unchanged === "patch"
      ? fixture.repair(2, "wrong-one")
      : fixture.repair(2, "accepted", "approach-1");
    await expect(fixture.execute(invalid)).rejects.toBeInstanceOf(Error);
    expect(await fixture.calls("A")).toBe(calls);
    const after = await fixture.load();
    expect(attemptsFor(after, "A")).toEqual(attemptsFor(before, "A"));
    expect(after.lanes.A?.strategyGenerations).toEqual(before.lanes.A?.strategyGenerations);
  });

  it("binds a recorded but unexecuted generation to its original patch across reconnect", async () => {
    const fixture = await nativeFixture();
    const original = fixture.repair(1, "accepted");
    const interruption = new Error("owned interruption before workspace creation");
    await expect(fixture.execute(original, () => { throw interruption; })).rejects.toBe(interruption);
    const before = await fixture.load();
    expect(before.lanes.A?.strategyGenerations?.map((generation) => generation.generation)).toEqual([0, 1]);
    expect(attemptsFor(before, "A").map((attempt) => parseMassUlwAttemptFingerprint(attempt.fingerprint)?.strategyGeneration)).toEqual([0]);
    const calls = await fixture.calls("A");
    const substituted = { ...fixture.repair(1, "substituted"), repairStrategies: undefined };
    await expect(fixture.execute(substituted)).rejects.toBeInstanceOf(Error);
    expect(await fixture.calls("A")).toBe(calls);
    expect(attemptsFor(await fixture.load(), "A")).toEqual(attemptsFor(before, "A"));
    expect((await fixture.load()).lanes.A?.strategyGenerations).toEqual(before.lanes.A?.strategyGenerations);
    // Rejection must not poison the correctly bound, still-unexecuted strategy.
    expect(await fixture.execute({ ...original, repairStrategies: undefined })).toMatchObject({ status: "completed" });
    expect(await fixture.calls("A")).toBe(calls + 1);
  });

  it("retains the successful peer's exact proof and restores its real artifact without reexecution", async () => {
    const fixture = await nativeFixture();
    const before = await fixture.load();
    const peerCalls = await fixture.calls("B");
    const repaired = await fixture.execute(fixture.repair(1, "accepted"));
    expect(repaired.status).toBe("completed");
    expect(await fixture.calls("B")).toBe(peerCalls);
    const after = await fixture.load();
    expect(after.lanes.B).toEqual(before.lanes.B);
    expect(attemptsFor(after, "B")).toEqual(attemptsFor(before, "B"));
    expect(after.fingerprints.lanes.B).toBe(before.fingerprints.lanes.B);
    expect(await readFile(join(fixture.root, "src/b/result.txt"), "utf8")).toBe("accepted");
    expect(await readFile(join(fixture.root, "src/a/result.txt"), "utf8")).toBe("accepted");
  });
});
