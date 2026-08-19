import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueExecutorToken, revokeExecutorToken, verifyExecutorToken } from "./auth.js";

describe("executor auth", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "jk-executor-auth-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("issues a token scoped to one executor", async () => {
    const token = await issueExecutorToken(stateDir, "windows-main");
    expect(token).toMatch(/^jkexec_/);
    await expect(verifyExecutorToken(stateDir, "windows-main", token)).resolves.toBe(true);
    await expect(verifyExecutorToken(stateDir, "other-worker", token)).resolves.toBe(false);
  });

  it("rotates the credential when a new token is issued", async () => {
    const first = await issueExecutorToken(stateDir, "windows-main");
    const second = await issueExecutorToken(stateDir, "windows-main");
    expect(second).not.toBe(first);
    await expect(verifyExecutorToken(stateDir, "windows-main", first)).resolves.toBe(false);
    await expect(verifyExecutorToken(stateDir, "windows-main", second)).resolves.toBe(true);
  });

  it("revokes an executor credential", async () => {
    const token = await issueExecutorToken(stateDir, "windows-main");
    await expect(revokeExecutorToken(stateDir, "windows-main")).resolves.toBe(true);
    await expect(verifyExecutorToken(stateDir, "windows-main", token)).resolves.toBe(false);
  });
});
