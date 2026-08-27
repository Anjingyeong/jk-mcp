import { createHash } from "node:crypto";
import type { MassUlwAttempt, MassUlwDocument } from "./mass-ulw-store.js";
import type { MassUlwAttemptFingerprint, MassUlwRecoveryApproach } from "./mass-ulw-executor-types.js";
const ATTEMPT_FINGERPRINT_PREFIX = "mass-ulw-attempt-v1:";
type LaneRecoveryEntry = {
  failureFingerprint: string;
  approachFingerprint: string;
};

type FingerprintedError = Error & {
  failureFingerprint?: string;
  approachFingerprint?: string;
};

function isRecoveryApproach(value: unknown): value is MassUlwRecoveryApproach {
  return value === "initial" || value === "inspect-assumption" || value === "materially-different-approach";
}

function optionalFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableFingerprint(value: unknown): string | null | undefined {
  return value === null ? null : optionalFingerprint(value);
}

export function encodeMassUlwAttemptFingerprint(value: MassUlwAttemptFingerprint): string {
  return `${ATTEMPT_FINGERPRINT_PREFIX}${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

export function parseMassUlwAttemptFingerprint(value: string | undefined): MassUlwAttemptFingerprint | null {
  if (!value?.startsWith(ATTEMPT_FINGERPRINT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(ATTEMPT_FINGERPRINT_PREFIX.length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const approachFingerprint = optionalFingerprint(parsed.approachFingerprint);
    const previousFailureFingerprint = nullableFingerprint(parsed.previousFailureFingerprint);
    const previousApproachFingerprint = nullableFingerprint(parsed.previousApproachFingerprint);
    if (
      parsed.version !== 1 ||
      !isRecoveryApproach(parsed.approach) ||
      !approachFingerprint ||
      previousFailureFingerprint === undefined ||
      previousApproachFingerprint === undefined
    ) {
      return null;
    }
    const result: MassUlwAttemptFingerprint = {
      version: 1,
      approach: parsed.approach,
      approachFingerprint,
      previousFailureFingerprint,
      previousApproachFingerprint,
    };
    const failureFingerprint = optionalFingerprint(parsed.failureFingerprint);
    const outputFingerprint = optionalFingerprint(parsed.outputFingerprint);
    const verificationFingerprint = optionalFingerprint(parsed.verificationFingerprint);
    if (failureFingerprint) result.failureFingerprint = failureFingerprint;
    if (outputFingerprint) result.outputFingerprint = outputFingerprint;
    if (verificationFingerprint) result.verificationFingerprint = verificationFingerprint;
    return result;
  } catch {
    return null;
  }
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function laneAttempts(document: MassUlwDocument, laneId: string): MassUlwAttempt[] {
  return document.attempts.filter((attempt) => attempt.kind === "lane" && attempt.laneId === laneId);
}

export function recoveryHistory(document: MassUlwDocument, laneId: string): LaneRecoveryEntry[] {
  return laneAttempts(document, laneId)
    .filter((attempt) => attempt.status === "failed" || attempt.status === "interrupted")
    .map((attempt, index) => {
      const parsed = parseMassUlwAttemptFingerprint(attempt.fingerprint);
      return {
        failureFingerprint: parsed?.failureFingerprint ?? fingerprint({ laneId, attemptId: attempt.id, status: attempt.status }),
        approachFingerprint: parsed?.approachFingerprint ?? attempt.fingerprint ?? fingerprint({ laneId, index }),
      };
    });
}

export function errorFailureFingerprint(error: unknown, phase: "execution" | "lane-verification"): string {
  const provided = optionalFingerprint((error as FingerprintedError | null)?.failureFingerprint);
  if (provided) return provided;
  const candidate = error as NodeJS.ErrnoException | null;
  return fingerprint({
    phase,
    name: candidate?.name ?? "Error",
    code: candidate?.code ?? null,
    message: candidate?.message ?? String(error),
  });
}

export function errorApproachFingerprint(error: unknown, fallback: string): string {
  return optionalFingerprint((error as FingerprintedError | null)?.approachFingerprint) ?? fallback;
}
