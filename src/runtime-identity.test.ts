import { execFile } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer as createListener } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeOwnerToken } from "./auth/owner-token.js";
import { isControlEnabled, isControlChatGptExposed, controlAllowlist } from "./control/policy.js";
import { createServer } from "./server/mcp-server.js";
import { createHttpServer, defaultHttpServerConfig } from "./server/http.js";
import { Store } from "./state/store.js";
import { Ledger } from "./state/ledger.js";
import { scanWorkspace } from "./workspace/registry.js";
import type { ToolContext } from "./types.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "jk-runtime-identity-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root };
  for (const key of Object.keys(env)) {
    if (/^(JK_|CHATGPT2CODEX_)/.test(key)) delete env[key];
  }
  return env;
}

describe("runtime state identity", () => {
  it.each([
    { name: "fresh default", jk: false, legacy: false, overrides: "none", selected: "jk" },
    { name: "existing legacy default", jk: false, legacy: true, overrides: "none", selected: "chatgpt2codex" },
    { name: "existing canonical default", jk: true, legacy: false, overrides: "none", selected: "jk" },
    { name: "both defaults", jk: true, legacy: true, overrides: "none", selected: "jk" },
    { name: "JK-only override", jk: false, legacy: true, overrides: "jk", selected: "explicit-jk" },
    { name: "legacy-only override", jk: true, legacy: true, overrides: "legacy", selected: "explicit-legacy" },
    { name: "conflicting overrides", jk: true, legacy: true, overrides: "both", selected: "explicit-jk" },
    { name: "blank JK override", jk: true, legacy: true, overrides: "blank", selected: "explicit-legacy" },
  ])("selects $name without moving or merging state", async ({ jk, legacy, overrides, selected }) => {
    const share = path.join(root, ".local", "share");
    for (const name of [...(jk ? ["jk"] : []), ...(legacy ? ["chatgpt2codex"] : []), "explicit-jk", "explicit-legacy"]) {
      await storeOwnerToken(path.join(share, name), `synthetic-owner-token-for-${name}`);
      await fs.writeFile(path.join(share, name, "sessions.json"), JSON.stringify({ fixture: name }));
    }
    const before = await fs.readdir(share);
    const env = isolatedEnv();
    if (overrides === "jk" || overrides === "both") env.JK_STATE_DIR = ` ${path.join(share, "explicit-jk")} `;
    if (overrides === "legacy" || overrides === "both" || overrides === "blank") env.CHATGPT2CODEX_STATE_DIR = path.join(share, "explicit-legacy");
    if (overrides === "blank") env.JK_STATE_DIR = "  ";
    const result = await execFileAsync(process.execPath, ["--import", "tsx", cli, "owner-token", "--status"], {
      env, cwd: path.dirname(cli), timeout: 30_000,
    });
    expect(JSON.parse(result.stdout)).toEqual({ configured: selected !== "jk" || jk, stateDir: path.join(share, selected) });
    expect(await fs.readdir(share)).toEqual(before);
    for (const name of before) expect(await fs.readFile(path.join(share, name, "sessions.json"), "utf8")).toBe(JSON.stringify({ fixture: name }));
  }, 30_000);

  it.each([".jk", ".chatgpt2codex"])("recognizes %s without changing folder-derived project identity", async (marker) => {
    const project = path.join(root, "old-project-id");
    await fs.mkdir(path.join(project, marker), { recursive: true });
    await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ name: "jk" }));
    const entries = await scanWorkspace(root);
    expect(entries[0]).toMatchObject({ projectId: "old-project-id", root: project });
    await fs.rm(path.join(project, "package.json"));
    expect((await scanWorkspace(root)).map((entry) => entry.projectId)).toEqual(["old-project-id"]);
  });
});

describe("canonical control environment", () => {
  it("honors JK-only security flags", () => {
    expect(isControlEnabled({ JK_CONTROL: "0" })).toBe(false);
    expect(isControlChatGptExposed({ JK_CONTROL_CHATGPT: "1" })).toBe(true);
    expect(controlAllowlist({ JK_CONTROL_ALLOWLIST: "Notes, TextEdit" })).toEqual(["Notes", "TextEdit"]);
  });
  it("prefers explicit canonical values including empty allowlists", () => {
    expect(isControlEnabled({ JK_CONTROL: "0", CHATGPT2CODEX_CONTROL: "1" })).toBe(false);
    expect(isControlEnabled({ JK_CONTROL: "1", CHATGPT2CODEX_CONTROL: "0" })).toBe(true);
    expect(isControlChatGptExposed({ JK_CONTROL_CHATGPT: "0", CHATGPT2CODEX_CONTROL_CHATGPT: "1" })).toBe(false);
    expect(controlAllowlist({ JK_CONTROL_ALLOWLIST: "", CHATGPT2CODEX_CONTROL_ALLOWLIST: "Notes" })).toEqual([]);
  });
});

function context(): ToolContext {
  const stateDir = path.join(root, "state");
  return { workspaceRoot: root, stateDir, registry: [], store: new Store(stateDir), ledger: new Ledger(stateDir),
    config: { workspaceRoot: root, stateDir, maxReadBytes: 1024, maxPatchBytes: 1024, defaultCommandTimeoutSec: 10, defaultLeaseTtlMs: 60_000 } };
}

describe("runtime protocol identity", () => {
  it("resumes the same legacy session through the canonical stdio CLI without relocating it", async () => {
    const project = path.join(root, "legacy-project");
    await fs.mkdir(path.join(project, ".chatgpt2codex"), { recursive: true });
    const state = path.join(root, ".local", "share", "chatgpt2codex");
    await storeOwnerToken(state, "synthetic-owner-token-for-stdio");
    const bytes = JSON.stringify({ version: 1, updatedAt: 1, activeProjectId: "legacy-project", mode: "read", lease: null });
    const sessionFile = path.join(state, "sessions.json");
    await fs.writeFile(sessionFile, bytes);
    const env = Object.fromEntries(Object.entries(isolatedEnv()).filter((entry): entry is [string, string] => entry[1] !== undefined));
    env.JK_CONTROL = "0";
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", cli, "serve", "--stdio", "--workspace", root], cwd: path.dirname(cli), env, stderr: "pipe" });
    const client = new Client({ name: "identity-stdio-test", version: "1" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("jk");
      expect(await fs.readFile(sessionFile, "utf8")).toBe(bytes);
      const result = await client.callTool({ name: "session_resume", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ activeProjectId: "legacy-project", hasContext: false,
        chatgpt2codexToolCall: { app: "jk", namespace: "ChatGPT_To_Codex", ok: true } });
      // Tool completion already normalizes session versions/timestamps; identity
      // selection must preserve the data, not prevent that existing lifecycle.
      expect(await new Store(state).getSession()).toMatchObject({ activeProjectId: "legacy-project", mode: "read", lease: null });
      await expect(fs.access(path.join(root, ".local", "share", "jk"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await client.close(); await transport.close(); }
  }, 30_000);

  it("advertises canonical MCP name and the installed package version", async () => {
    const server = await createServer(context());
    const client = new Client({ name: "identity-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
      expect(client.getServerVersion()).toEqual({ name: "jk", version: pkg.version });
    } finally { await client.close(); await server.close(); }
  });

  it("serves canonical HTTP and Actions health with compatible OAuth scope and proof keys", async () => {
    const listener = createListener();
    const ready = once(listener, "listening", { signal: AbortSignal.timeout(10_000) });
    listener.listen(0, "127.0.0.1");
    await ready;
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    const publicUrl = `http://127.0.0.1:${address.port}`;
    const runtime = createHttpServer(context(), defaultHttpServerConfig({ port: address.port, host: "127.0.0.1", publicUrl }));
    listener.on("request", runtime.app);
    try {
      const get = (route: string) => fetch(publicUrl + route, { signal: AbortSignal.timeout(10_000) });
      const health = await (await get("/healthz")).json();
      const actions = await (await get("/actions/health")).json();
      expect.soft(health).toEqual({ ok: true, name: "jk" });
      expect.soft(actions).toMatchObject({ name: "jk-actions", toolAvailabilityGate: { app: "jk", namespace: "ChatGPT_To_Codex" } });
      expect(await (await get("/.well-known/openid-configuration")).json()).toMatchObject({
        scopes_supported: expect.arrayContaining(["chatgpt2codex"]),
      });
      expect((await get("/mcp")).status).toBe(401);
    } finally {
      runtime.close();
      listener.closeAllConnections();
      const closed = once(listener, "close", { signal: AbortSignal.timeout(10_000) });
      listener.close();
      await closed;
    }
  });
});
