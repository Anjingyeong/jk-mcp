import { describe, expect, it } from "vitest";
import { encodeWindowsControlPayload, windowsAppIdentityMatches } from "./windows-input.js";

describe("Windows computer control primitives", () => {
  it("matches common Windows process names to human app labels conservatively", () => {
    expect(windowsAppIdentityMatches("Google Chrome", "chrome", "JK - Google Chrome")).toBe(true);
    expect(windowsAppIdentityMatches("Roblox Studio", "RobloxStudioBeta", "My Place - Roblox Studio")).toBe(true);
    expect(windowsAppIdentityMatches("Visual Studio Code", "Code", "project - Visual Studio Code")).toBe(true);
    expect(windowsAppIdentityMatches("Roblox Studio", "chrome", "ChatGPT")).toBe(false);
  });

  it("keeps raw typed text out of the PowerShell argv payload representation", () => {
    const raw = "private typed value 123";
    const encoded = encodeWindowsControlPayload({ appName: "Notepad", kind: "type", text: raw });
    expect(encoded).not.toContain(raw);
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toMatchObject({ text: raw });
  });
});