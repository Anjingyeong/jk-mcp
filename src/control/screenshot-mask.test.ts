import { describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import { assertScreenshotTargetAllowed } from "./screenshot-mask.js";

describe("control/screenshot-mask assertScreenshotTargetAllowed", () => {
  it("allows an app-targeted capture when the app is not sensitive", () => {
    expect(() => assertScreenshotTargetAllowed("TextEdit")).not.toThrow();
  });

  it("blocks an app-targeted capture when the target app is sensitive", () => {
    try {
      assertScreenshotTargetAllowed("1Password 7");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(ErrorCode.SENSITIVE_TARGET_BLOCKED);
    }
  });

  it("allows a full-screen capture (no appName) when nothing sensitive is frontmost", () => {
    expect(() => assertScreenshotTargetAllowed(undefined, "TextEdit")).not.toThrow();
    expect(() => assertScreenshotTargetAllowed(undefined, undefined)).not.toThrow();
  });

  it("blocks a full-screen capture (no appName) when a sensitive app is frontmost", () => {
    try {
      assertScreenshotTargetAllowed(undefined, "System Settings");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(ErrorCode.SENSITIVE_TARGET_BLOCKED);
    }
  });
});
