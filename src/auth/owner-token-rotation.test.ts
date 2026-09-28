import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonOAuthStore, hashToken } from "./oauth-store.js";
import { generateOwnerToken, storeOwnerToken, verifyOwnerToken } from "./owner-token.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const OLD_ACCESS = "old-access-token-value";
const OLD_REFRESH = "old-refresh-token-value";

async function seedGrant(stateDir: string): Promise<string> {
  const store = new JsonOAuthStore(stateDir);
  const client = await store.registerClient(
    { redirect_uris: ["https://chatgpt.com/connector/oauth/callback"], client_name: "ChatGPT" } as never,
    ["chatgpt.com"],
  );
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const saved = await store.saveTokenPair({
    accessTokenHash: hashToken(OLD_ACCESS),
    accessToken: { clientId: client.client_id, scopes: ["mcp"], expiresAt },
    refreshTokenHash: hashToken(OLD_REFRESH),
    refreshToken: { clientId: client.client_id, scopes: ["mcp"], expiresAt },
  });
  expect(saved).toBe(true);
  return client.client_id;
}

async function expectRevokedButRegistered(stateDir: string, clientId: string): Promise<void> {
  // Fresh store instance: mirrors a running server re-reading oauth.json.
  const store = new JsonOAuthStore(stateDir);
  expect(await store.getClient(clientId)).toBeDefined();
  expect(await store.getAccessToken(hashToken(OLD_ACCESS))).toBeUndefined();
  expect(await store.getRefreshToken(hashToken(OLD_REFRESH))).toBeUndefined();
}

function runCli(stateDir: string, args: string[]) {
  return execFileAsync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, JK_STATE_DIR: stateDir },
    timeout: 60_000,
  });
}

describe("Owner Token rotation", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "jk-rotation-"));
    await storeOwnerToken(stateDir, generateOwnerToken());
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("clearTokens revokes access/refresh tokens but keeps registered clients", async () => {
    const clientId = await seedGrant(stateDir);
    const store = new JsonOAuthStore(stateDir);
    expect(await store.getAccessToken(hashToken(OLD_ACCESS))).toBeDefined();

    await store.clearTokens();

    await expectRevokedButRegistered(stateDir, clientId);
  });

  it("`owner-token --generate` invalidates existing sessions and keeps the connector", async () => {
    const clientId = await seedGrant(stateDir);

    const { stdout } = await runCli(stateDir, ["owner-token", "--generate"]);
    const result = JSON.parse(stdout) as { rotated: boolean; ownerToken: string };

    expect(result.rotated).toBe(true);
    expect(await verifyOwnerToken(stateDir, result.ownerToken)).toBe(true);
    await expectRevokedButRegistered(stateDir, clientId);
  }, 60_000);

  it("`owner-token --set-stdin` invalidates existing sessions and keeps the connector", async () => {
    const clientId = await seedGrant(stateDir);
    const replacement = generateOwnerToken();

    const child = execFile(process.execPath, ["--import", "tsx", cli, "owner-token", "--set-stdin"], {
      cwd: repoRoot,
      env: { ...process.env, JK_STATE_DIR: stateDir },
      timeout: 60_000,
    });
    child.stdin?.end(replacement);
    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    expect(exitCode).toBe(0);
    expect(await verifyOwnerToken(stateDir, replacement)).toBe(true);
    await expectRevokedButRegistered(stateDir, clientId);
  }, 60_000);

  it("`init --rotate-owner-token` invalidates existing sessions and keeps the connector", async () => {
    const clientId = await seedGrant(stateDir);
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jk-rotation-ws-"));
    try {
      await runCli(stateDir, ["init", "--workspace", workspace, "--rotate-owner-token"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    await expectRevokedButRegistered(stateDir, clientId);
  }, 60_000);
});
