import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSetupReady, normalizeSetupPublicUrl } from "./cli-setup.js";
import { JsonOAuthStore, hashToken } from "./auth/oauth-store.js";
import { verifyOwnerToken } from "./auth/owner-token.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function commandAvailable(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
// `jk setup` refuses to continue without git and ripgrep.
const setupDepsAvailable = commandAvailable("git") && commandAvailable("rg");

describe("normalizeSetupPublicUrl", () => {
  it.each([
    ["mcp.example.com", "https://mcp.example.com"],
    ["https://mcp.example.com", "https://mcp.example.com"],
    ["https://mcp.example.com/", "https://mcp.example.com"],
    ["https://mcp.example.com/mcp", "https://mcp.example.com"],
    ["  'https://mcp.example.com/mcp/'  ", "https://mcp.example.com"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeSetupPublicUrl(input)).toBe(expected);
  });

  it.each([
    "http://mcp.example.com",
    "https://user:pw@mcp.example.com",
    "https://mcp.example.com/other",
    "https://mcp.example.com/?x=1",
    "https://",
  ])("rejects %j", (input) => {
    expect(() => normalizeSetupPublicUrl(input)).toThrow();
  });
});

describe("formatSetupReady", () => {
  const base = {
    connectorUrl: "https://abc.trycloudflare.com/mcp",
    localBaseUrl: "http://127.0.0.1:7979",
    workspaceRoot: "C:\\work",
  };

  it("warns that a Quick Tunnel address changes and lists local links on their own lines", () => {
    const text = formatSetupReady({ ...base, quickTunnel: true }, undefined).join("\n");
    expect(text).toContain("   https://abc.trycloudflare.com/mcp");
    expect(text).toContain("CHANGES every time JK restarts");
    expect(text).toContain("http://127.0.0.1:7979/healthz");
    expect(text).toMatch(/Control Center: +http:\/\/127\.0\.0\.1:7979\//);
  });

  it("omits the Quick Tunnel warning for a fixed domain", () => {
    const text = formatSetupReady({ ...base, connectorUrl: "https://mcp.example.com/mcp", quickTunnel: false }, undefined).join("\n");
    expect(text).not.toContain("CHANGES");
  });

  it("shows the connection code only when one was just generated", () => {
    const withCode = formatSetupReady({ ...base, quickTunnel: true }, "secret-code-value").join("\n");
    const withoutCode = formatSetupReady({ ...base, quickTunnel: true }, undefined).join("\n");
    expect(withCode).toContain("secret-code-value");
    expect(withCode).toContain("shown ONCE");
    expect(withoutCode).not.toContain("secret-code-value");
    expect(withoutCode).toContain("--reset-code");
  });
});

describe("jk setup / jk start (non-interactive)", () => {
  let stateDir: string;
  let workspace: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "jk-setup-state-"));
    workspace = await mkdtemp(path.join(os.tmpdir(), "jk-setup-ws-"));
    await writeFile(path.join(workspace, "package.json"), '{"name":"demo"}');
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  function run(args: string[]) {
    return execFileAsync(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, JK_STATE_DIR: stateDir },
      timeout: 60_000,
    });
  }

  it.skipIf(!setupDepsAvailable)(
    "first run saves setup and shows a code once; re-run keeps it; --reset-code rotates and revokes sessions",
    async () => {
      const first = await run(["setup", "--no-start", "--workspace", workspace, "--public-url", "mcp.example.com"]);
      const firstCode = first.stderr.trim().split(/\r?\n/).at(-1) ?? "";
      expect(first.stderr).toContain("Connection code (shown once):");
      expect(await verifyOwnerToken(stateDir, firstCode)).toBe(true);
      const saved = JSON.parse(await readFile(path.join(stateDir, "setup.json"), "utf8"));
      expect(saved).toEqual({ workspaceRoot: path.resolve(workspace), publicUrl: "https://mcp.example.com" });
      expect(JSON.stringify(saved)).not.toContain(firstCode);

      // Second run: reuses saved folder + domain, never re-displays the code.
      const second = await run(["setup", "--no-start"]);
      expect(second.stderr).toContain(`Using saved allowed folder: ${path.resolve(workspace)}`);
      expect(second.stderr).toContain("Existing connection code kept.");
      expect(second.stderr).not.toContain(firstCode);

      // Seed a live session, then rotate.
      const store = new JsonOAuthStore(stateDir);
      const client = await store.registerClient(
        { redirect_uris: ["https://chatgpt.com/cb"], client_name: "ChatGPT" } as never,
        ["chatgpt.com"],
      );
      const exp = Math.floor(Date.now() / 1000) + 3600;
      await store.saveTokenPair({
        accessTokenHash: hashToken("live-access"),
        accessToken: { clientId: client.client_id, scopes: ["mcp"], expiresAt: exp },
        refreshTokenHash: hashToken("live-refresh"),
        refreshToken: { clientId: client.client_id, scopes: ["mcp"], expiresAt: exp },
      });

      const third = await run(["setup", "--no-start", "--reset-code"]);
      const newCode = third.stderr.trim().split(/\r?\n/).at(-1) ?? "";
      expect(newCode).not.toBe(firstCode);
      expect(await verifyOwnerToken(stateDir, newCode)).toBe(true);
      expect(await verifyOwnerToken(stateDir, firstCode)).toBe(false);
      const after = new JsonOAuthStore(stateDir);
      expect(await after.getAccessToken(hashToken("live-access"))).toBeUndefined();
      expect(await after.getClient(client.client_id)).toBeDefined();
    },
    120_000,
  );

  it("rejects a non-HTTPS fixed address", async () => {
    await expect(run(["setup", "--no-start", "--workspace", workspace, "--public-url", "http://mcp.example.com"]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("must use HTTPS") });
  }, 60_000);

  it("`jk start` without a connection code points the user at setup", async () => {
    await expect(run(["start", "--workspace", workspace, "--public-url", "https://mcp.example.com"]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("jk setup") });
  }, 60_000);
});
