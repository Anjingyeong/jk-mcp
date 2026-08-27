import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { deferred, eventOrFinished } from "../orchestration/mass-ulw-runner-fixtures.js";
import { LOOP_ID, MassUlwToolHarness, WORK_SESSION_ID } from "./mass-ulw-tool-fixture.js";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  listCommands: vi.fn(),
}));

vi.mock("../exec/command-runner.js", () => ({
  buildSafeChildEnv: () => process.env,
  listCommands: mocks.listCommands,
  runCommand: mocks.runCommand,
}));

describe("mass_ulw_execute MCP boundary", () => {
  let harness: MassUlwToolHarness;

  beforeEach(async () => {
    harness = await MassUlwToolHarness.create(mocks);
  });

  afterEach(async () => {
    await harness?.cleanup();
    vi.clearAllMocks();
  });

  async function approvedInput(): Promise<Record<string, unknown>> {
    return harness.approvedInput();
  }

  it("rejects malformed, stale, and unsafe verifier calls before native lane execution", async () => {
    const malformed = await harness.client.callTool({
      name: "mass_ulw_execute",
      arguments: { projectId: "mass-tool-project", loopId: LOOP_ID },
    });
    expect(malformed.isError).toBe(true);

    const stale = await harness.client.callTool({
      name: "mass_ulw_execute",
      arguments: { ...(await approvedInput()), planFingerprint: "0".repeat(64) },
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ code: "COMMAND_NOT_ALLOWED" });

    const unsafe = await harness.client.callTool({
      name: "mass_ulw_execute",
      arguments: { ...(await approvedInput()), finalVerificationCommandId: "npm:deploy" },
    });
    expect(unsafe.isError).toBe(true);
    expect(unsafe.structuredContent).toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it("executes JK-native dependency waves without OMO and is idempotent for the same fingerprint", async () => {
    const input = await approvedInput();
    const first = await harness.client.callTool({ name: "mass_ulw_execute", arguments: input });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      status: "completed",
      planFingerprint: input.planFingerprint,
      waves: [["A", "B"], ["C"]],
      completedLaneIds: ["A", "B", "C"],
      finalVerificationInvocationCount: 1,
    });

    const verifierCalls = mocks.runCommand.mock.calls.map(([, commandId]) => String(commandId));
    expect(verifierCalls.slice(0, 2).sort()).toEqual(["npm:verify:a", "npm:verify:b"]);
    expect(verifierCalls.slice(2)).toEqual(["npm:verify:c", "npm:final"]);

    const persisted = await new MassUlwStore(harness.stateDir).load(await harness.executionId());
    expect(persisted.plan.waves).toEqual([["A", "B"], ["C"]]);
    expect(persisted.fingerprints.plan).toBe(input.planFingerprint);
    expect(persisted.integrationVerification.status).toBe("passed");

    const second = await harness.client.callTool({ name: "mass_ulw_execute", arguments: input });
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toMatchObject({ status: "completed", planFingerprint: input.planFingerprint });
    expect(mocks.runCommand).toHaveBeenCalledTimes(4);
  }, 120_000);

  it("revokes a stale fanout approval when Fast becomes sequential", async () => {
    const staleInput = await approvedInput();
    const fast = await harness.client.callTool({
      name: "goal_loop",
      arguments: {
        goal: "Keep this work sequential",
        loopId: LOOP_ID,
        projectId: "mass-tool-project",
        workSessionId: WORK_SESSION_ID,
        executionProfile: "fast",
        pending: ["A", "B"],
        fanoutCandidates: [
          { id: "A", task: "Implement A", estimatedWeight: 1, writeScopes: ["src/a"] },
          { id: "B", task: "Implement B", estimatedWeight: 1, writeScopes: ["src/b"] },
        ],
      },
    });
    expect(fast.structuredContent).toMatchObject({
      orchestration: { massUlw: { state: "sequential", recommended: false } },
    });

    const staleExecution = await harness.client.callTool({
      name: "mass_ulw_execute",
      arguments: staleInput,
    });

    expect(staleExecution.isError).toBe(true);
    expect(mocks.runCommand).not.toHaveBeenCalled();
  }, 120_000);

  it("preserves an approved plan across an ordinary goal_loop continuation", async () => {
    const input = await approvedInput();
    const continued = await harness.client.callTool({ name: "goal_loop", arguments: { loopId: LOOP_ID, projectId: "mass-tool-project", workSessionId: WORK_SESSION_ID, lastResult: "Inspected the first implementation slice" } });
    const resumed = await harness.client.callTool({ name: "mass_ulw_execute", arguments: input });
    expect(continued.isError).not.toBe(true);
    expect(continued.structuredContent).toMatchObject({ massUlwLifecycle: { state: "preserved", executable: true } });
    expect(resumed.isError).not.toBe(true);
  }, 120_000);

  it("does not persist a write-backed MASS plan for a read-only goal mode", async () => {
    const result = await harness.client.callTool({ name: "goal_loop", arguments: {
      goal: "Research independent implementation options", loopId: "loop-read-only-mass", projectId: "mass-tool-project", workSessionId: "ws_read_only_mass", mode: "research", executionProfile: "max", pending: ["A", "B"],
      fanoutCandidates: [{ id: "A", task: "Research A", estimatedWeight: 5, writeScopes: ["src/a"] }, { id: "B", task: "Research B", estimatedWeight: 5, writeScopes: ["src/b"] }],
    } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ massUlwLifecycle: { state: "read-only", executable: false, reasonCode: "READ_ONLY_GOAL_MODE" } });
    await expect(new MassUlwStore(harness.stateDir).load(await harness.executionId("loop-read-only-mass"))).rejects.toThrow(/does not exist/u);
  });

  it("blocks the next dependency wave when the lease is revoked at verifier completion", async () => {
    const verifierCompleted = deferred();
    const releaseVerifier = deferred();
    mocks.runCommand.mockImplementationOnce(async () => {
      verifierCompleted.resolve();
      await releaseVerifier.promise;
      return { exitCode: 0, stdoutSummary: "verified", stderrSummary: "", durationMs: 1, outputTruncated: false };
    });

    const execution = harness.client.callTool({ name: "mass_ulw_execute", arguments: await approvedInput() });
    expect(await eventOrFinished(verifierCompleted.promise, execution)).toBe(true);
    harness.revokeLease();
    releaseVerifier.resolve();
    const result = await execution;

    expect(result.isError).toBe(true);
    expect(mocks.runCommand).toHaveBeenCalled();
    const verifierCalls = mocks.runCommand.mock.calls.map(([, commandId]) => String(commandId));
    expect(verifierCalls).not.toContain("npm:verify:c");
    expect(verifierCalls).not.toContain("npm:final");
  }, 120_000);

});
