import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MassUlwArtifactStore } from "../orchestration/mass-ulw-artifacts.js";
import { MassUlwExecutor, encodeMassUlwAttemptFingerprint, parseMassUlwAttemptFingerprint } from "../orchestration/mass-ulw-executor.js";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { createMassUlwWorkspace } from "../orchestration/mass-ulw-workspace.js";
import { deferred, eventOrFinished } from "../orchestration/mass-ulw-runner-fixtures.js";
import { LOOP_ID, MassUlwToolHarness } from "./mass-ulw-tool-fixture.js";
import { createMassUlwExecutionIdentity } from "./mass-ulw-identity.js";
import { createMassUlwProcesses, type MassUlwExecuteInput } from "./mass-ulw-processes.js";

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
    if (harness) {
      await expect(stat(harness.root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(harness.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      console.log("B_MCP_CLEANUP", JSON.stringify({ complete: true, paths: [harness.root, harness.stateDir] }));
    }
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

  it("native-evolution R12 stops deterministic native failure after one attempt and does not refill on reconnect", async () => {
    let laneAVerifications = 0;
    mocks.runCommand.mockImplementation(async (_cwd: string, commandId: string) => {
      const failed = commandId === "npm:verify:a" && laneAVerifications++ < 2;
      return {
        exitCode: failed ? 1 : 0,
        stdoutSummary: failed ? "same verifier failure" : "verified",
        stderrSummary: failed ? "verification stderr" : "",
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
      failureDiagnostics: expect.arrayContaining([
        expect.objectContaining({
          laneId: "A",
          stage: "verification",
          command: "npm:verify:a",
          exitCode: 1,
          stdoutSummary: "same verifier failure",
          stderrSummary: "verification stderr",
        }),
      ]),
    });
    expect(laneAVerifications).toBe(1);
    expect(result.structuredContent).toMatchObject({ recovery: { reason: "repair-required", laneIds: ["A"], automaticReplay: false } });
    const repeated = await harness.client.callTool({ name: "mass_ulw_execute", arguments: await harness.approvedInput() });
    expect(repeated.isError).not.toBe(true);
    expect(laneAVerifications).toBe(1);
    const persisted = await new MassUlwStore(harness.stateDir).load(await harness.executionId());
    const approaches = persisted.attempts
      .filter((attempt) => attempt.laneId === "A")
      .map((attempt) => parseMassUlwAttemptFingerprint(attempt.fingerprint)?.approachFingerprint);
    expect(new Set(approaches).size).toBe(1);
    expect(approaches).toHaveLength(1);
    expect(persisted.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        laneId: "A",
        status: "failed",
        failure: expect.objectContaining({
          stage: "verification",
          command: "npm:verify:a",
          exitCode: 1,
          stdoutSummary: "same verifier failure",
          stderrSummary: "verification stderr",
        }),
      }),
    ]));
  }, 60_000);

  it("native-evolution R12 explicitly changed native strategy repairs only failed closure with real verifier processes", async () => {
    const realCommands = await vi.importActual<typeof import("../exec/command-runner.js")>("../exec/command-runner.js");
    mocks.listCommands.mockImplementation(realCommands.listCommands);
    mocks.runCommand.mockImplementation(realCommands.runCommand);
    await writeFile(join(harness.root, "package.json"), JSON.stringify({ scripts: {
      test: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/a/result.txt','utf8').trim(),'corrected A')\"",
      lint: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/b/result.txt','utf8').trim(),'B')\"",
      check: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/c/result.txt','utf8').trim(),'C')\"",
      verify: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/a/result.txt','utf8').trim(),'corrected A')\"",
    } }));
    const input = { ...await harness.approvedInput(), laneVerificationCommandIds: { A: "npm:test", B: "npm:lint", C: "npm:check" }, finalVerificationCommandId: "npm:verify" };
    const first = await harness.client.callTool({ name: "mass_ulw_execute", arguments: input });
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ status: "blocked", completedLaneIds: ["B"], failedLaneIds: ["A"] });
    const store = new MassUlwStore(harness.stateDir);
    const before = await store.load(await harness.executionId());
    const peer = before.fingerprints.lanes.B;
    const attempts = before.attempts.filter((attempt) => attempt.laneId === "A");
    expect(attempts).toHaveLength(1);
    const repairStrategies = { A: { generation: 1, approach: "replace output with corrected A", evidence: "Node assertion rejected A instead of corrected A" } };
    const unchanged = await harness.client.callTool({ name: "mass_ulw_execute", arguments: { ...input, repairStrategies } });
    expect(unchanged.isError).toBe(true);
    const corrected = { ...input, lanePatches: {
      A: "*** Begin Patch\n*** Add File: src/a/result.txt\n+corrected A\n*** End Patch",
      B: "*** Begin Patch\n*** Add File: src/b/result.txt\n+B\n*** End Patch",
      C: "*** Begin Patch\n*** Add File: src/c/result.txt\n+C\n*** End Patch",
    }, repairStrategies };
    const result = await harness.client.callTool({ name: "mass_ulw_execute", arguments: corrected });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "completed", completedLaneIds: ["A", "B", "C"] });
    const after = await store.load(await harness.executionId());
    expect(after.fingerprints.lanes.B).toBe(peer);
    expect(after.attempts.filter((attempt) => attempt.laneId === "A")).toHaveLength(2);
    expect(after.attempts.filter((attempt) => attempt.laneId === "B")).toHaveLength(1);
    expect(after.lanes.A).toMatchObject({ strategyGenerations: [
      { generation: 0 }, { generation: 1, approach: repairStrategies.A.approach, evidence: repairStrategies.A.evidence },
    ] });
    expect(mocks.runCommand.mock.calls.filter(([, commandId]) => commandId === "npm:test")).toHaveLength(2);
    expect(mocks.runCommand.mock.calls.filter(([, commandId]) => commandId === "npm:lint")).toHaveLength(1);
    expect(await readFile(join(harness.root, "src/a/result.txt"), "utf8")).toBe("corrected A");
  }, 120_000);

  it("native-evolution R11 real MCP native verifier sockets admit C before held B completes", async () => {
    const commands = await vi.importActual<typeof import("../exec/command-runner.js")>("../exec/command-runner.js");
    mocks.listCommands.mockImplementation(commands.listCommands);
    mocks.runCommand.mockImplementation(commands.runCommand);
    const sockets = new Set<Socket>(); const childStarted = deferred();
    let a: Socket | undefined; let b: Socket | undefined; let c: Socket | undefined; let released = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", (data) => {
        if (released) { socket.end(); return; }
        const id = data.toString();
        if (id === "A") { a = socket; if (b) a.end(); }
        else if (id === "B") { b = socket; a?.end(); }
        else if (id === "C") { c = socket; childStarted.resolve(); }
        else socket.destroy(new Error(`Unexpected lane socket: ${id}`));
      });
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    let outcome: Promise<Awaited<ReturnType<typeof harness.client.callTool>>> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture TCP address");
      const script = (id: string) => `node -e "const s=require('node:net').connect(${address.port},'127.0.0.1',()=>s.write('${id}'));s.on('end',()=>s.end())"`;
      await writeFile(join(harness.root, "package.json"), JSON.stringify({ scripts: { test: script("A"), lint: script("B"), check: script("C"), verify: "node -e \"\"" } }));
      const loopId = `${LOOP_ID}-ready`;
      const planned = await harness.client.callTool({ name: "goal_loop", arguments: {
        goal: "Execute unequal native branches", loopId, projectId: "mass-tool-project", workSessionId: "ws_mass_tool", executionProfile: "max",
        pending: ["A", "B", "C"], fanoutCandidates: [
          { id: "A", task: "Implement A", estimatedWeight: 5, writeScopes: ["src/a"] },
          { id: "B", task: "Implement B", estimatedWeight: 5, writeScopes: ["src/b"] },
          { id: "C", task: "Implement C", estimatedWeight: 5, writeScopes: ["src/c"], dependsOn: ["A"] },
        ],
      } });
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      const executionId = await harness.executionId(loopId);
      const store = new MassUlwStore(harness.stateDir);
      const plan = (await store.load(executionId)).plan;
      outcome = harness.client.callTool({ name: "mass_ulw_execute", arguments: { ...await harness.approvedInput(), loopId,
        planFingerprint: plan.planFingerprint, laneVerificationCommandIds: { A: "npm:test", B: "npm:lint", C: "npm:check" }, finalVerificationCommandId: "npm:verify",
      } });
      expect(await eventOrFinished(childStarted.promise, outcome)).toBe(true);
      expect((await store.load(executionId)).lanes.B?.status).toBe("in-flight");
      expect(b?.destroyed).toBe(false);
    } finally {
      released = true; b?.end(); a?.end(); c?.end();
      try {
        if (outcome) {
          const result = await outcome;
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect(result.structuredContent).toMatchObject({ status: "completed" });
        }
      } finally {
        const socketClosures = [...sockets].map((socket) => once(socket, "close"));
        for (const socket of sockets) socket.destroy();
        const closed = once(server, "close"); server.close(); await closed;
        await Promise.all(socketClosures);
        console.log("B_SOCKET_CLEANUP", JSON.stringify({ listening: server.listening, activeSockets: sockets.size }));
        expect(server.listening).toBe(false);
        expect(sockets.size).toBe(0);
      }
    }
  }, 120_000);

  it("native-evolution R11 native artifact persistence errors are global, not repair hypotheses", async () => {
    const executionId = await harness.executionId();
    const artifacts = new MassUlwArtifactStore(harness.stateDir, executionId);
    await mkdir(dirname(artifacts.root), { recursive: true });
    await writeFile(artifacts.root, "owned artifact-store obstruction");
    const result = await harness.client.callTool({ name: "mass_ulw_execute", arguments: await harness.approvedInput() });
    expect(result.isError).toBe(true);
    expect(mocks.runCommand).not.toHaveBeenCalled();
    const state = await new MassUlwStore(harness.stateDir).load(executionId);
    expect(state.attempts.some((attempt) => attempt.status === "failed")).toBe(false);
    expect(state.lanes.C?.attempts).toBe(0);
  }, 60_000);

  it("native-evolution R12 native adapter executes corrected generation against retained real peer artifacts", async () => {
    const commands = await vi.importActual<typeof import("../exec/command-runner.js")>("../exec/command-runner.js");
    mocks.runCommand.mockImplementation(commands.runCommand);
    await writeFile(join(harness.root, "package.json"), JSON.stringify({ scripts: {
      test: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/a/result.txt','utf8').trim(),'corrected A')\"",
      lint: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/b/result.txt','utf8').trim(),'B')\"",
      check: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/c/result.txt','utf8').trim(),'C')\"",
      verify: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/a/result.txt','utf8').trim(),'corrected A')\"",
    } }));
    const identity = await createMassUlwExecutionIdentity({ projectId: "mass-tool-project", repositoryRoot: harness.root, externalLoopId: LOOP_ID });
    const store = new MassUlwStore(harness.stateDir);
    const plan = (await store.load(identity.executionId)).plan;
    const verifierFingerprints = new Map((await commands.listCommands(harness.root)).map((command) => [command.commandId, command.manifestFingerprint]));
    const input: MassUlwExecuteInput = { projectId: identity.projectId, loopId: LOOP_ID, planFingerprint: plan.planFingerprint, workSessionId: "ws_mass_tool",
      lanePatches: { A: "*** Begin Patch\n*** Add File: src/a/result.txt\n+A\n*** End Patch", B: "*** Begin Patch\n*** Add File: src/b/result.txt\n+B\n*** End Patch", C: "*** Begin Patch\n*** Add File: src/c/result.txt\n+C\n*** End Patch" },
      laneVerificationCommandIds: { A: "npm:test", B: "npm:lint", C: "npm:check" }, finalVerificationCommandId: "npm:verify",
    };
    const execute = (value: MassUlwExecuteInput) => {
      const processes = createMassUlwProcesses({ ctx: { stateDir: harness.stateDir }, input: value, identity, verifierFingerprints });
      return new MassUlwExecutor({ stateDir: harness.stateDir, repositoryRoot: harness.root, tempRoot: harness.stateDir,
        laneEngine: processes.laneEngine, verificationEngine: processes.verificationEngine,
      }).execute({ loopId: identity.executionId, plan, repairStrategies: value.repairStrategies });
    };
    expect(await execute(input)).toMatchObject({ status: "blocked", completedLaneIds: ["B"], failedLaneIds: ["A"] });
    const before = await store.load(identity.executionId);
    const repaired = await execute({ ...input, lanePatches: { ...input.lanePatches, A: "*** Begin Patch\n*** Add File: src/a/result.txt\n+corrected A\n*** End Patch" },
      repairStrategies: { A: { generation: 1, approach: "corrected output", evidence: "Node assertion rejected original output" } },
    });
    expect(repaired.status).toBe("completed");
    const after = await store.load(identity.executionId);
    expect(after.fingerprints.lanes.B).toBe(before.fingerprints.lanes.B);
    expect(after.attempts.filter((attempt) => attempt.laneId === "A").map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
    expect(mocks.runCommand.mock.calls.filter(([, id]) => id === "npm:test")).toHaveLength(2);
    expect(mocks.runCommand.mock.calls.filter(([, id]) => id === "npm:lint")).toHaveLength(1);
    expect(await readFile(join(harness.root, "src/a/result.txt"), "utf8")).toBe("corrected A");
  }, 120_000);
});
