import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const launcher = join(process.cwd(), "start-jk.ps1");

describe("launcher startup environment", () => {
  it("validates executor workspaces in the production startup prefix", () => {
    if (process.platform !== "win32") return;
    const fixture = mkdtempSync(join(tmpdir(), "jk-startup-"));
    const scriptPath = join(fixture, "startup-prefix.ps1");
    const source = readFileSync(launcher, "utf8");
    const boundary = source.indexOf("$Node = Resolve-Tool");
    expect(boundary).toBeGreaterThan(0);
    const prefix = source.slice(0, boundary);
    writeFileSync(scriptPath, `${prefix}\n[ordered]@{workspace=$Workspace;executorWorkspace=(Resolve-ExecutorWorkspace $ExecutorWorkspace $Workspace)} | ConvertTo-Json -Compress\nexit 0\n`);
    const run = (workspace: string, executorWorkspace?: string) => spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", scriptPath],
      { env: { ...process.env, WORKSPACE: workspace, JK_EXECUTOR_WORKSPACE: executorWorkspace ?? "" }, encoding: "utf8" },
    );
    try {
      const missingDefault = join(fixture, "missing-default");
      const missingExecutor = join(fixture, "missing-executor");
      const red = run(missingDefault, missingExecutor);
      expect(red.status).not.toBe(0);
      expect(existsSync(missingDefault)).toBe(false);
      expect(existsSync(missingExecutor)).toBe(false);

      const valid = join(fixture, "valid-executor");
      const validDefault = join(fixture, "valid-default");
      mkdirSync(valid, { recursive: true });
      const green = run(validDefault, valid);
      expect(green.status).toBe(0);
      const explicitResult = green.stdout.trim().split(/\r?\n/u).at(-1);
      expect(explicitResult).toBeDefined();
      expect(JSON.parse(explicitResult ?? "")).toEqual({ workspace: validDefault, executorWorkspace: valid });

      const omitted = join(fixture, "omitted-default");
      const omittedResult = run(omitted);
      expect(omittedResult.status).toBe(0);
      expect(existsSync(omitted)).toBe(true);
      const defaultResult = omittedResult.stdout.trim().split(/\r?\n/u).at(-1);
      expect(defaultResult).toBeDefined();
      expect(JSON.parse(defaultResult ?? "")).toEqual({ workspace: omitted, executorWorkspace: omitted });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

