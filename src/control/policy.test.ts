import { describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import { assertAllowedTarget, controlAllowlist, isControlChatGptExposed, isControlEnabled, isSensitiveApp } from "./policy.js";

describe("control/policy", () => {
  it("isControlEnabled defaults to true (no env var set) and requires an explicit opt-out value to disable", () => {
    expect(isControlEnabled({})).toBe(true);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "1" })).toBe(true);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "true" })).toBe(true);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "yes" })).toBe(true);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "anything-else" })).toBe(true);
  });

  it("isControlEnabled treats 0/false/off (case-insensitive) as an explicit opt-out", () => {
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "0" })).toBe(false);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "false" })).toBe(false);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "off" })).toBe(false);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "FALSE" })).toBe(false);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: "Off" })).toBe(false);
    expect(isControlEnabled({ CHATGPT2CODEX_CONTROL: " 0 " })).toBe(false);
  });

  it("flags sensitive apps case-insensitively", () => {
    expect(isSensitiveApp("1Password 7")).toBe(true);
    expect(isSensitiveApp("System Settings")).toBe(true);
    expect(isSensitiveApp("Keychain Access")).toBe(true);
    expect(isSensitiveApp("TextEdit")).toBe(false);
    expect(isSensitiveApp(undefined)).toBe(false);
  });

  it("controlAllowlist is empty by default and parses comma-separated env values", () => {
    expect(controlAllowlist({})).toEqual([]);
    expect(controlAllowlist({ CHATGPT2CODEX_CONTROL_ALLOWLIST: "TextEdit, Notes ,Safari" })).toEqual(["TextEdit", "Notes", "Safari"]);
  });

  it("assertAllowedTarget blocks a sensitive target app even if allowlisted", () => {
    expect(() =>
      assertAllowedTarget({ appName: "1Password 7", allowlist: ["1Password 7"] }),
    ).toThrowError(DomainError);
    try {
      assertAllowedTarget({ appName: "1Password 7", allowlist: ["1Password 7"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(ErrorCode.SENSITIVE_TARGET_BLOCKED);
    }
  });

  it("assertAllowedTarget blocks a sensitive frontmost app even if the target itself is fine", () => {
    expect(() =>
      assertAllowedTarget({ appName: "TextEdit", frontmostAppName: "System Settings", allowlist: ["TextEdit"] }),
    ).toThrowError(DomainError);
  });

  it("assertAllowedTarget blocks any app not on the explicit allowlist", () => {
    expect(() => assertAllowedTarget({ appName: "TextEdit", allowlist: [] })).toThrowError(DomainError);
    expect(() => assertAllowedTarget({ appName: "TextEdit", allowlist: ["Notes"] })).toThrowError(DomainError);
  });

  it("assertAllowedTarget passes for a non-sensitive, allowlisted target with a non-sensitive frontmost app", () => {
    expect(() =>
      assertAllowedTarget({ appName: "TextEdit", frontmostAppName: "TextEdit", allowlist: ["TextEdit"] }),
    ).not.toThrow();
  });

  it("isControlChatGptExposed defaults to false (opt-in, public-product-safe)", () => {
    expect(isControlChatGptExposed({})).toBe(false);
    expect(isControlChatGptExposed({ CHATGPT2CODEX_CONTROL_CHATGPT: undefined })).toBe(false);
  });

  it.each(["1", "true", "on", "TRUE", "ON", "True"])(
    "isControlChatGptExposed is true for CHATGPT2CODEX_CONTROL_CHATGPT=%s",
    (value) => {
      expect(isControlChatGptExposed({ CHATGPT2CODEX_CONTROL_CHATGPT: value })).toBe(true);
    },
  );

  it.each(["0", "false", "off", "", "yes", "anything-else"])(
    "isControlChatGptExposed stays false for CHATGPT2CODEX_CONTROL_CHATGPT=%s (opt-in requires an explicit true-ish value)",
    (value) => {
      expect(isControlChatGptExposed({ CHATGPT2CODEX_CONTROL_CHATGPT: value })).toBe(false);
    },
  );
});
