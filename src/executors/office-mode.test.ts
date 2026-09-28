import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const executorEnvNames = [
  "JK_HUB_URL",
  "JK_EXECUTOR_ID",
  "JK_EXECUTOR_WORKSPACE",
  "JK_EXECUTOR_TOKEN_FILE",
];

describe("Standalone / Office mode source contract", () => {
  it("defaults Windows to Office mode and isolates stale remote-executor environment", () => {
    const source = read("windows/JKTray.ps1");
    expect(source).toContain('RuntimeProfile = "office"');
    expect(source).toContain("Standalone / Office");
    expect(source).toContain('$psi.EnvironmentVariables["JK_EXECUTOR_ONLY"] = "0"');
    expect(source).toContain('$psi.EnvironmentVariables.Remove($name)');
    for (const name of executorEnvNames) expect(source).toContain(name);
  });

  it("defaults macOS to Office mode and isolates stale remote-executor environment", () => {
    const source = read("macos/JKStatusBar/main.swift");
    expect(source).toContain('private let runtimeProfileKey = "runtimeProfile"');
    expect(source).toContain('return saved == "advanced" ? "advanced" : "office"');
    expect(source).toContain("Standalone / Office");
    expect(source).toContain("export JK_EXECUTOR_ONLY=0");
    expect(source).toContain("unset JK_HUB_URL JK_EXECUTOR_ID JK_EXECUTOR_WORKSPACE JK_EXECUTOR_TOKEN_FILE");
  });

  it("documents a direct always-on PC topology without requiring OCI", () => {
    const docs = read("docs/INSTALL.md");
    expect(docs).toContain("Standalone / Office");
    expect(docs).toContain("mcp.company.example");
    expect(docs).toContain("127.0.0.1:7979");
    expect(docs).toContain("OCI가 필요하지 않습니다");
  });
});
