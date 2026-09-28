import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp-server.js";
import { Store } from "../state/store.js";
import { selectRoleForProject } from "../roles/roles.js";
import { makeLease } from "../workspace/project-select.js";
import type { LeasePreset, ToolContext } from "../types.js";

const projectId = "shell-auth";
const command = "echo shell-auth-ok>shell-marker.txt";

describe("local shell capability authorization through MCP", () => {
  let temp: string;
  let root: string;
  let ctx: ToolContext;
  let client: Client;
  let server: Awaited<ReturnType<typeof createServer>>;

  async function authorize(preset: LeasePreset, roleId = "default") {
    const entry = { projectId, root, name: projectId, aliases: [] };
    await ctx.store.setSession({
      activeProjectId: projectId,
      mode: "read",
      lease: { ...makeLease(entry, preset), expiresAt: Number.MAX_SAFE_INTEGER },
    });
    await selectRoleForProject(ctx.stateDir, projectId, roleId);
  }

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "jk-shell-auth-"));
    root = path.join(temp, "project");
    await fs.mkdir(root);
    const stateDir = path.join(temp, "state");
    const store = new Store(stateDir);
    const entry = { projectId, root, name: projectId, aliases: [] };
    await store.saveProjects([entry]);
    ctx = {
      workspaceRoot: root,
      stateDir,
      registry: [entry],
      ledger: { append: async () => undefined },
      store,
      config: {
        workspaceRoot: root,
        stateDir,
        maxReadBytes: 10000,
        maxPatchBytes: 10000,
        defaultCommandTimeoutSec: 30,
        defaultLeaseTtlMs: 30 * 60 * 1000,
      },
    };
    server = await createServer(ctx);
    client = new Client({ name: "shell-auth-tests", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    await fs.rm(temp, { recursive: true, force: true });
  });

  it("denies a writing shell under tests-only when intent is omitted", async () => {
    await authorize("tests-only");

    const result = await client.callTool({
      name: "local_shell_run",
      arguments: { projectId, command },
    });

    expect.soft(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "PERMISSION_DENIED",
        details: { projectPreset: "tests-only", capability: "write" },
      },
    });
    await expect(fs.stat(path.join(root, "shell-marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { preset: "tests-only", roleId: "default", intent: { writesWorkspace: false } },
    { preset: "tests-only", roleId: "default", intent: { writesWorkspace: true } },
    { preset: "full-write", roleId: "qa-engineer", intent: undefined },
    { preset: "full-write", roleId: "qa-engineer", intent: { writesWorkspace: false } },
    { preset: "full-write", roleId: "qa-engineer", intent: { writesWorkspace: true } },
  ] as const)("denies a writing shell with $preset / $roleId / $intent", async ({ preset, roleId, intent }) => {
    await authorize(preset, roleId);

    const result = await client.callTool({
      name: "local_shell_run",
      arguments: { projectId, command, ...(intent === undefined ? {} : { intent }) },
    });

    expect.soft(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "PERMISSION_DENIED",
        details: { projectPreset: preset, roleId, effectivePreset: "tests-only", capability: "write" },
      },
    });
    await expect(fs.stat(path.join(root, "shell-marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "omitted", intent: undefined },
    { label: "writesWorkspace=false", intent: { writesWorkspace: false } },
    { label: "writesWorkspace=true", intent: { writesWorkspace: true } },
  ])("allows benign shell execution under full-write when intent is $label", async ({ intent }) => {
    await authorize("full-write");

    const result = await client.callTool({
      name: "local_shell_run",
      arguments: { projectId, command, ...(intent === undefined ? {} : { intent }) },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ exitCode: 0, stderrSummary: "" });
    expect((await fs.readFile(path.join(root, "shell-marker.txt"), "utf8")).trim()).toBe("shell-auth-ok");
  });

  it.each([
    { preset: "tests-only", roleId: "default" },
    { preset: "full-write", roleId: "qa-engineer" },
  ] as const)("allows discovered verification via command_run with $preset / $roleId", async ({ preset, roleId }) => {
    await authorize(preset, roleId);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "echo shell-auth-verify-ok" },
    }));

    const result = await client.callTool({
      name: "command_run",
      arguments: { projectId, commandId: "npm:test" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      exitCode: 0,
      stdoutSummary: expect.stringContaining("shell-auth-verify-ok"),
      activeRoleContext: { effectivePermission: "tests-only" },
    });
    await expect(fs.stat(path.join(root, "shell-marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
