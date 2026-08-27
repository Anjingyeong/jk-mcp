import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import { makeLease } from "../workspace/project-select.js";
import { createServer } from "./mcp-server.js";

describe("omo_run MCP boundary", () => {
  let root: string;
  let stateDir: string;
  let codexHome: string;
  let previousNodeCli: string | undefined;
  let previousCodexHome: string | undefined;
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chatgpt2codex-omo-tool-root-"));
    stateDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-omo-tool-state-"));
    codexHome = await mkdtemp(join(tmpdir(), "chatgpt2codex-omo-tool-home-"));
    previousNodeCli = process.env.CHATGPT2CODEX_OMO_NODE_CLI;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    process.env.CHATGPT2CODEX_OMO_NODE_CLI = await installFakeNativeCli(codexHome);

    const entry: ProjectRegistryEntry = {
      projectId: "omo-tool-project",
      name: "omo-tool-project",
      root,
      aliases: ["omo-tool-project"],
    };
    const lease = makeLease(entry, "full-write");
    const ctx: ToolContext = {
      workspaceRoot: root,
      stateDir,
      registry: [entry],
      ledger: { append: async () => undefined },
      store: {
        loadProjects: async () => [entry],
        saveProjects: async () => undefined,
        getSession: async () => ({ lease }),
        setSession: async () => undefined,
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

    server = await createServer(ctx);
    client = new Client({ name: "omo-ulw-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    if (previousNodeCli === undefined) delete process.env.CHATGPT2CODEX_OMO_NODE_CLI;
    else process.env.CHATGPT2CODEX_OMO_NODE_CLI = previousNodeCli;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  });

  it("publishes an optional boolean ultrawork input", async () => {
    const tools = await client?.listTools();
    const omoRun = tools?.tools.find((tool) => tool.name === "omo_run");
    const properties = omoRun?.inputSchema.properties as Record<string, unknown> | undefined;

    expect(properties?.ultrawork).toMatchObject({ type: "boolean" });
    expect(omoRun?.inputSchema.required).toEqual(["projectId", "message"]);
  });

  it.each(["", "yes", 1, null])("rejects malformed ultrawork input %j at the MCP boundary", async (ultrawork) => {
    const result = await client?.callTool({
      name: "omo_run",
      arguments: {
        projectId: "omo-tool-project",
        message: "must not spawn",
        ultrawork,
      },
    });

    expect(result?.isError).toBe(true);
  });

  it("propagates ultrawork with session options and preserves normal messages", async () => {
    const ulw = await client?.callTool({
      name: "omo_run",
      arguments: {
        projectId: "omo-tool-project",
        message: "ship through MCP",
        model: "openai/gpt-test",
        sessionId: "ses_old",
        timeoutSec: 10,
        verbose: true,
        ultrawork: true,
      },
    });
    const normalMessage = "mass-ulw remains data";
    const normal = await client?.callTool({
      name: "omo_run",
      arguments: {
        projectId: "omo-tool-project",
        message: normalMessage,
        timeoutSec: 10,
        ultrawork: false,
      },
    });

    expect(ulw?.isError).not.toBe(true);
    expect(normal?.isError).not.toBe(true);
    const ulwStructured = ulw?.structuredContent as
      | {
          cliContract?: string;
          sessionId?: string;
          stdoutSummary?: string;
          ultraworkRequested?: boolean;
          ultraworkTransport?: string;
        }
      | undefined;
    const normalStructured = normal?.structuredContent as
      | {
          stdoutSummary?: string;
          ultraworkRequested?: boolean;
          ultraworkTransport?: string;
        }
      | undefined;
    const ulwArgv = parseLastArgv(ulwStructured?.stdoutSummary);
    const normalArgv = parseLastArgv(normalStructured?.stdoutSummary);

    expect(ulwStructured).toMatchObject({
      cliContract: "native-print",
      sessionId: "ses_native",
      ultraworkRequested: true,
      ultraworkTransport: "native-hook-trigger",
    });
    expect(ulwArgv).toEqual([
      "--mode",
      "json",
      "--print",
      "--model",
      "openai/gpt-test",
      "--session-id",
      "ses_old",
      "--verbose",
      "ship through MCP\n\nulw",
    ]);
    expect(normalStructured).toMatchObject({
      ultraworkRequested: false,
      ultraworkTransport: "native-hook-disabled",
    });
    expect(normalArgv).toContain("--omo-senpi-ultrawork-disabled");
    expect(normalArgv.at(-1)).toBe(normalMessage);
  });
});

async function installFakeNativeCli(codexHome: string): Promise<string> {
  const cli = join(codexHome, "native", "omo.js");
  await mkdir(join(cli, ".."), { recursive: true });
  await writeFile(
    cli,
    [
      "const argv = process.argv.slice(2);",
      "if (argv.includes('--help')) {",
      "  console.log('Usage: omo [options] [message] --mode --print --model --session-id --verbose --omo-senpi-ultrawork-disabled');",
      "  process.exit(0);",
      "}",
      "console.log(JSON.stringify({ type: 'session', id: 'ses_native' }));",
      "console.log(JSON.stringify({ argv }));",
    ].join("\n"),
    "utf8",
  );
  return cli;
}

function parseLastArgv(stdout: string | undefined): string[] {
  const lastLine = stdout?.trim().split(/\r?\n/u).at(-1) ?? "{}";
  const parsed = JSON.parse(lastLine) as { argv?: unknown };
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((value) => typeof value === "string")) {
    throw new Error("fake OMO output did not contain a string argv array");
  }
  return parsed.argv;
}
