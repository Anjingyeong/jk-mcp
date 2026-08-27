import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MassUlwArtifactStore } from "../orchestration/mass-ulw-artifacts.js";
import { encodeMassUlwAttemptFingerprint, parseMassUlwAttemptFingerprint } from "../orchestration/mass-ulw-executor.js";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { createMassUlwWorkspace } from "../orchestration/mass-ulw-workspace.js";
import { LOOP_ID, MassUlwToolHarness } from "./mass-ulw-tool-fixture.js";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  listCommands: vi.fn(),
}));

vi.mock("../exec/command-runner.js", () => ({
  buildSafeChildEnv: () => process.env,
  listCommands: mocks.listCommands,
  runCommand: mocks.runCommand,
}));

const execFileAsync = promisify(execFile);

describe("mass_ulw_execute recovery boundary", () => {
  let harness: MassUlwToolHarness;

  beforeEach(async () => {
    harness = await MassUlwToolHarness.create(mocks);
  });

  afterEach(async () => {
    await harness?.cleanup();
    vi.clearAllMocks();
  });

  it("restores completed lane outputs across a new MCP execution", async () => {
    const input = await harness.approvedInput();
    const executionId = await harness.executionId();
    const persisted = await new MassUlwStore(harness.stateDir).load(executionId);
    const artifacts = new MassUlwArtifactStore(harness.stateDir, executionId);
    const seedWorkspace = await createMassUlwWorkspace({
      repositoryRoot: harness.root,
      tempRoot: harness.stateDir,
      lanes: persisted.plan.lanes.map((candidate) => ({
        id: candidate.id,
        writeScopes: candidate.writeScopes,
      })),
    });
    try {
      const laneA = seedWorkspace.lanes.find((candidate) => candidate.id === "A")!;
      await mkdir(join(laneA.root, "src", "a"), { recursive: true });
      await writeFile(join(laneA.root, "src", "a", "result.txt"), "restored A\n", "utf8");
      await execFileAsync("git", ["add", "--", "src/a"], { cwd: laneA.root });
      await execFileAsync("git", ["commit", "-qm", "complete A"], { cwd: laneA.root });
      await artifacts.save({
        laneId: "A",
        checkoutRoot: laneA.root,
        baselineCommit: laneA.executionBaselineCommit,
      });
    } finally {
      await seedWorkspace.cleanup();
    }
    await new MassUlwStore(harness.stateDir).update(executionId, (document) => {
      document.lanes.A!.status = "completed";
      document.lanes.A!.attempts = 1;
      document.lanes.A!.completedAt = 2;
      document.fingerprints.lanes.A = "output-A";
      document.attempts.push({
        id: `${executionId}:lane:A:1`,
        kind: "lane",
        laneId: "A",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        fingerprint: encodeMassUlwAttemptFingerprint({
          version: 1,
          approach: "initial",
          approachFingerprint: "approach-A",
          previousFailureFingerprint: null,
          previousApproachFingerprint: null,
          outputFingerprint: "output-A",
          verificationFingerprint: "verification-A",
        }),
      });
    });

    const resumed = await harness.client.callTool({ name: "mass_ulw_execute", arguments: input });

    expect(resumed.isError).not.toBe(true);
    expect(resumed.structuredContent).toMatchObject({
      status: "completed",
      completedLaneIds: ["A", "B", "C"],
      changedPaths: ["src/a/result.txt", "src/b/result.txt", "src/c/result.txt"],
    });
    expect(mocks.runCommand.mock.calls.some(([, commandId]) => commandId === "npm:verify:a")).toBe(false);
    expect(await readFile(join(harness.root, "src", "a", "result.txt"), "utf8")).toBe("restored A\n");
    await expect(stat(artifacts.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rejects an unchanged JK-native lane patch when recovery requires a materially different approach", async () => {
    let laneAVerifications = 0;
    mocks.runCommand.mockImplementation(async (_cwd: string, commandId: string) => {
      const failed = commandId === "npm:verify:a" && laneAVerifications++ < 2;
      return {
        exitCode: failed ? 1 : 0,
        stdoutSummary: failed ? "same verifier failure" : "verified",
        stderrSummary: "",
        durationMs: 1,
        outputTruncated: false,
      };
    });

    const result = await harness.client.callTool({
      name: "mass_ulw_execute",
      arguments: await harness.approvedInput(),
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "blocked",
      completedLaneIds: ["B"],
      failedLaneIds: ["A"],
      blockedLaneIds: ["C"],
    });
    expect(laneAVerifications).toBe(2);
    const persisted = await new MassUlwStore(harness.stateDir).load(await harness.executionId());
    const approaches = persisted.attempts
      .filter((attempt) => attempt.laneId === "A")
      .map((attempt) => parseMassUlwAttemptFingerprint(attempt.fingerprint)?.approachFingerprint);
    expect(new Set(approaches).size).toBe(1);
  }, 60_000);
});
