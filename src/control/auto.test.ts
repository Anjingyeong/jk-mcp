import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoDecision, clampMinutes, clearAuto, readAuto, recordAutoUse, setAuto } from "./auto.js";

describe("control/auto", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-auto-"));
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit, Notes";
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("clampMinutes defaults to 10 and clamps to the 1..60 range", () => {
    expect(clampMinutes(undefined)).toBe(10);
    expect(clampMinutes(0)).toBe(1);
    expect(clampMinutes(-5)).toBe(1);
    expect(clampMinutes(5)).toBe(5);
    expect(clampMinutes(500)).toBe(60);
    expect(clampMinutes(Number.NaN)).toBe(10);
  });

  it("no scope file: autoDecision is false and nothing is written", async () => {
    const decision = await autoDecision(stateDir, { appName: "TextEdit", kind: "click" });
    expect(decision.allowed).toBe(false);
    expect(await readAuto(stateDir)).toBeNull();
  });

  it("setAuto filters apps down to the sensitive-app-free control-allowlist intersection", async () => {
    const scope = await setAuto(stateDir, { apps: ["TextEdit", "1Password 7", "Slack"], minutes: 10 });
    // TextEdit is allowlisted; 1Password is sensitive; Slack isn't allowlisted at all.
    expect(scope.apps).toEqual(["textedit"]);
  });

  it("autoDecision is true for an in-scope, allowlisted, non-sensitive app within TTL", async () => {
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
    const decision = await autoDecision(stateDir, { appName: "TextEdit", kind: "click" });
    expect(decision.allowed).toBe(true);
    expect(decision.scope?.apps).toEqual(["textedit"]);
  });

  it("autoDecision is false for a sensitive app even if somehow present in scope.apps", async () => {
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
    // Simulate a scope file that (e.g. via manual edit or an allowlist
    // change after the fact) still lists a now-sensitive app.
    const scope = await readAuto(stateDir);
    await fs.writeFile(
      path.join(stateDir, "control", "AUTO"),
      JSON.stringify({ ...scope, apps: ["1password 7"] }),
    );
    const decision = await autoDecision(stateDir, { appName: "1Password 7", kind: "click" });
    expect(decision.allowed).toBe(false);
  });

  it("autoDecision is false for an app outside the configured scope (allowlisted elsewhere but not in apps)", async () => {
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
    const decision = await autoDecision(stateDir, { appName: "Notes", kind: "click" });
    expect(decision.allowed).toBe(false);
  });

  it("autoDecision is false once now passes expiresAt, and lazily clears the scope file", async () => {
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
    const future = Date.now() + 11 * 60 * 1000;
    const decision = await autoDecision(stateDir, { appName: "TextEdit", kind: "click" }, future);
    expect(decision.allowed).toBe(false);
    expect(await readAuto(stateDir)).toBeNull();
  });

  it("autoDecision respects an explicit kinds filter", async () => {
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10, kinds: ["click"] });
    expect((await autoDecision(stateDir, { appName: "TextEdit", kind: "click" })).allowed).toBe(true);
    expect((await autoDecision(stateDir, { appName: "TextEdit", kind: "type" })).allowed).toBe(false);
  });

  it("autoDecision respects maxCount and recordAutoUse increments the counter", async () => {
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10, maxCount: 1 });
    const first = await autoDecision(stateDir, { appName: "TextEdit", kind: "click" });
    expect(first.allowed).toBe(true);
    await recordAutoUse(stateDir);

    const second = await autoDecision(stateDir, { appName: "TextEdit", kind: "click" });
    expect(second.allowed).toBe(false);
    const scope = await readAuto(stateDir);
    expect(scope?.count).toBe(1);
  });

  it("clearAuto removes the scope file and autoDecision returns false afterward", async () => {
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
    await clearAuto(stateDir);
    expect(await readAuto(stateDir)).toBeNull();
    expect((await autoDecision(stateDir, { appName: "TextEdit", kind: "click" })).allowed).toBe(false);
  });

  it("stores the AUTO flag file under stateDir/control with 0600 permissions", async () => {
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
    const file = path.join(stateDir, "control", "AUTO");
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
