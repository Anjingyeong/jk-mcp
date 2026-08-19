import { DomainError, ErrorCode } from "../types.js";
import { isSensitiveApp } from "./policy.js";

/**
 * Screenshot masking hook for Option B desktop control.
 *
 * Capture of a sensitive app's window is refused outright by the caller
 * (see assertScreenshotTargetAllowed). For everything else this is
 * currently a no-op pass-through; it is the designated extension point for
 * future per-region masking (e.g. blacking out an accessibility-reported
 * password-field frame) so screenshot delivery always goes through one
 * chokepoint even before that masking logic exists.
 */
export interface MaskInput {
  pngPath: string;
  appName?: string;
}

export interface MaskResult {
  pngPath: string;
  masked: boolean;
}

export async function maskSensitiveRegions(input: MaskInput): Promise<MaskResult> {
  return { pngPath: input.pngPath, masked: false };
}

/** Throws SENSITIVE_TARGET_BLOCKED when the capture target app is on the
 * sensitive denylist; screenshots of such apps are refused, not masked.
 *
 * A full-screen capture (appName omitted) has no per-app target to check, so
 * the caller must also pass the *live* frontmost app name: a full-screen
 * capture shows whatever is frontmost, so it is refused exactly like a
 * targeted capture would be when that app is sensitive. */
export function assertScreenshotTargetAllowed(appName: string | undefined, frontmostAppName?: string): void {
  if (isSensitiveApp(appName)) {
    throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `Refusing to capture a sensitive app window: ${appName}`, {
      appName,
    });
  }
  if (appName === undefined && isSensitiveApp(frontmostAppName)) {
    throw new DomainError(
      ErrorCode.SENSITIVE_TARGET_BLOCKED,
      `Refusing full-screen capture while a sensitive app is frontmost: ${frontmostAppName}`,
      { appName: frontmostAppName },
    );
  }
}
