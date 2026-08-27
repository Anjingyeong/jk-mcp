import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Mock } from "vitest";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { makeLease } from "../workspace/project-select.js";
import { createServer } from "./mcp-server.js";
import { createMassUlwExecutionIdentity } from "./mass-ulw-identity.js";

const execFileAsync = promisify(execFile);
export const LOOP_ID = "loop-mass-tool";
export const WORK_SESSION_ID = "ws_mass_tool";

export type MassUlwToolMocks = {
  runCommand: Mock;
  listCommands: Mock;
};

export class MassUlwToolHarness {
  private constructor(
    readonly root: string,
    readonly stateDir: string,
    readonly client: Client,
    private readonly server: Awaited<ReturnType<typeof createServer>>,
    private readonly revokeActiveLease: () => void,
  ) {}

  static async create(mocks: MassUlwToolMocks): Promise<MassUlwToolHarness> {
    const root = await mkdtemp(join(tmpdir(), "chatgpt2codex-mass-tool-root-"));
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-mass-tool-state-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            "verify:a": "node -e \"\"",
            "verify:b": "node -e \"\"",
            "verify:c": "node -e \"\"",
            final: "node -e \"\"",
            deploy: "npm publish",
          },
        }),
        "utf8",
      );
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "Mass Tool Test"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "mass-tool@example.invalid"], { cwd: root });
      await execFileAsync("git", ["add", "package.json"], { cwd: root });
      await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });

      mocks.listCommands.mockResolvedValue([
        { commandId: "npm:verify:a", display: "npm run verify:a", source: "package.json", riskTier: "verify", manifestFingerprint: "fixture-manifest" },
        { commandId: "npm:verify:b", display: "npm run verify:b", source: "package.json", riskTier: "verify", manifestFingerprint: "fixture-manifest" },
        { commandId: "npm:verify:c", display: "npm run verify:c", source: "package.json", riskTier: "verify", manifestFingerprint: "fixture-manifest" },
        { commandId: "npm:final", display: "npm run final", source: "package.json", riskTier: "verify", manifestFingerprint: "fixture-manifest" },
        { commandId: "npm:deploy", display: "npm run deploy", source: "package.json", riskTier: "network", manifestFingerprint: "fixture-manifest" },
      ]);
      mocks.runCommand.mockResolvedValue({
        exitCode: 0,
        stdoutSummary: "verified",
        stderrSummary: "",
        durationMs: 1,
        outputTruncated: false,
      });

      const entry: ProjectRegistryEntry = {
        projectId: "mass-tool-project",
        name: "mass-tool-project",
        root,
        aliases: [],
      };
      const lease = makeLease(entry, "full-write");
      let session: unknown = {
        activeProjectId: entry.projectId,
        mode: "edit",
        lease,
        workContexts: {},
        workSessions: {},
      };
      const ctx: ToolContext = {
        workspaceRoot: root,
        stateDir,
        registry: [entry],
        ledger: { append: async () => undefined },
        store: {
          loadProjects: async () => [entry],
          saveProjects: async () => undefined,
          getSession: async () => session,
          setSession: async (next) => { session = next; },
          updateSession: async (mutator) => {
            session = await mutator(session);
            return session;
          },
        },
        config: {
          workspaceRoot: root,
          stateDir,
          maxReadBytes: 1024,
          maxPatchBytes: 1024,
          defaultCommandTimeoutSec: 30,
          defaultLeaseTtlMs: 30 * 60 * 1000,
        },
      };
      const server = await createServer(ctx);
      const client = new Client({ name: "mass-ulw-tool-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const planned = await client.callTool({
        name: "goal_loop",
        arguments: {
          goal: "Implement three dependency-aware MASS ULW lanes",
          loopId: LOOP_ID,
          projectId: entry.projectId,
          workSessionId: WORK_SESSION_ID,
          executionProfile: "max",
          pending: ["A", "B", "C"],
          fanoutCandidates: [
            { id: "A", task: "Implement A", estimatedWeight: 5, writeScopes: ["src/a"] },
            { id: "B", task: "Implement B", estimatedWeight: 5, writeScopes: ["src/b"] },
            { id: "C", task: "Integrate C", estimatedWeight: 5, writeScopes: ["src/c"], dependsOn: ["A", "B"] },
          ],
        },
      });
      if (planned.isError === true) throw new Error("Failed to prepare approved MASS ULW fixture");
      return new MassUlwToolHarness(root, stateDir, client, server, () => {
        session = { ...(session as Record<string, unknown>), lease: null };
      });
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
      throw error;
    }
  }

  async approvedInput(): Promise<Record<string, unknown>> {
    const persisted = await new MassUlwStore(this.stateDir).load(await this.executionId());
    return {
      projectId: "mass-tool-project",
      loopId: LOOP_ID,
      planFingerprint: persisted.plan.planFingerprint,
      workSessionId: WORK_SESSION_ID,
      lanePatches: {
        A: "*** Begin Patch\n*** Add File: src/a/result.txt\n+A\n*** End Patch",
        B: "*** Begin Patch\n*** Add File: src/b/result.txt\n+B\n*** End Patch",
        C: "*** Begin Patch\n*** Add File: src/c/result.txt\n+C\n*** End Patch",
      },
      laneVerificationCommandIds: {
        A: "npm:verify:a",
        B: "npm:verify:b",
        C: "npm:verify:c",
      },
      finalVerificationCommandId: "npm:final",
      timeoutSec: 123,
    };
  }

  revokeLease(): void {
    this.revokeActiveLease();
  }

  async executionId(loopId = LOOP_ID): Promise<string> {
    return (await createMassUlwExecutionIdentity({
      projectId: "mass-tool-project",
      repositoryRoot: this.root,
      externalLoopId: loopId,
    })).executionId;
  }

  async cleanup(): Promise<void> {
    await this.client.close();
    await this.server.close();
    await rm(this.root, { recursive: true, force: true });
    await rm(this.stateDir, { recursive: true, force: true });
  }
}
