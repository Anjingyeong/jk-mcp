import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import { makeLease } from "../workspace/project-select.js";
import { createServer } from "../server/mcp-server.js";
import { Store } from "../state/store.js";

const execFileAsync = promisify(execFile);
export const IMPULSE_PROJECT_ID = "impulse-project";

interface HarnessDirs {
  root: string;
  stateDir: string;
}

async function createDirs(): Promise<HarnessDirs> {
  const root = await mkdtemp(path.join(tmpdir(), "jk-impulse-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "jk-impulse-state-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"\"" } }), "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Impulse Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "impulse@example.invalid"], { cwd: root });
  await execFileAsync("git", ["add", "package.json"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });
  const entry: ProjectRegistryEntry = { projectId: IMPULSE_PROJECT_ID, name: IMPULSE_PROJECT_ID, root, aliases: [] };
  const store = new Store(stateDir);
  await store.saveProjects([entry]);
  await store.setSession({ activeProjectId: entry.projectId, mode: "edit", lease: makeLease(entry, "full-write") });
  return { root, stateDir };
}

/**
 * In-memory MCP harness over a throwaway git repo + stateDir, persisted through
 * the real Store (projects.json / sessions.json), so `restart()` models a JK
 * process restart: a fresh server and Store over the same on-disk state.
 */
export async function createImpulseHarness(options: { remote?: boolean; dirs?: HarnessDirs } = {}) {
  const dirs = options.dirs ?? await createDirs();
  const { root, stateDir } = dirs;
  const store = new Store(stateDir);
  const ledger: Array<{ type: string; [k: string]: unknown }> = [];
  const ctx: ToolContext = {
    workspaceRoot: root,
    stateDir,
    registry: [],
    ledger: { append: async (event) => { ledger.push(event); } },
    store,
    config: { workspaceRoot: root, stateDir, maxReadBytes: 1024, maxPatchBytes: 1024, defaultCommandTimeoutSec: 30, defaultLeaseTtlMs: 30 * 60 * 1000 },
    ...(options.remote ? { remote: true } : {}),
  };
  const server = await createServer(ctx);
  const client = new Client({ name: "impulse-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const disconnect = async () => {
    await client.close();
    await server.close();
  };
  const harness = {
    root,
    stateDir,
    client,
    ledger,
    gitStatus: async () => (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout,
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
      return result.structuredContent as Record<string, unknown>;
    },
    callRaw: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }),
    /** Simulate a JK restart: drop this server and start a new one over the same state. */
    restart: async (restartOptions: { remote?: boolean } = {}) => {
      await disconnect();
      return createImpulseHarness({ ...options, ...restartOptions, dirs });
    },
    close: async () => {
      await disconnect().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
  return harness;
}
