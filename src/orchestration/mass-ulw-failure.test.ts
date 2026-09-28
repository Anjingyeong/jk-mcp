import { describe, expect, it } from "vitest";
import { MassUlwFailureDiagnosticSchema, massUlwFailureFromError } from "./mass-ulw-failure.js";

describe("MASS ULW failure diagnostics", () => {
  it("bounds persisted verifier output while preserving truncation evidence", () => {
    const diagnostic = MassUlwFailureDiagnosticSchema.parse({
      laneId: "lane-a",
      stage: "verification",
      retryable: true,
      message: "verifier failed",
      stdoutSummary: "x".repeat(50_000),
      stderrSummary: "y".repeat(50_000),
    });

    expect(diagnostic.stdoutSummary?.length).toBeLessThanOrEqual(16_384);
    expect(diagnostic.stderrSummary?.length).toBeLessThanOrEqual(16_384);
    expect(diagnostic.stdoutSummary).toContain("...[truncated");
    expect(diagnostic.stderrSummary).toContain("...[truncated");
    expect(diagnostic.stdoutSummary).toContain("[truncated 33643 chars]");
    expect(diagnostic.stderrSummary).toContain("[truncated 33643 chars]");
  });

  it("bounds oversized error messages before they enter durable state", () => {
    const diagnostic = massUlwFailureFromError(new Error("m".repeat(20_000)), {
      laneId: null,
      stage: "final_verification",
      retryable: false,
    });

    expect(diagnostic.message.length).toBeLessThanOrEqual(4_096);
    expect(diagnostic.message).toContain("...[truncated");
  });

  it("bounds auxiliary diagnostic strings before they enter durable state", () => {
    const diagnostic = MassUlwFailureDiagnosticSchema.parse({
      laneId: "lane".repeat(200),
      stage: "execution",
      retryable: false,
      message: "execution failed",
      file: "/tmp/" + "nested/".repeat(1_000),
      command: "node script.js " + "--verbose ".repeat(1_000),
      baseCommit: "b".repeat(1_000),
      checkoutCommit: "c".repeat(1_000),
    });

    expect(diagnostic.laneId?.length).toBeLessThanOrEqual(256);
    expect(diagnostic.file?.length).toBeLessThanOrEqual(2_048);
    expect(diagnostic.command?.length).toBeLessThanOrEqual(4_096);
    expect(diagnostic.baseCommit?.length).toBeLessThanOrEqual(256);
    expect(diagnostic.checkoutCommit?.length).toBeLessThanOrEqual(256);
    expect(diagnostic.laneId).toContain("...[truncated");
    expect(diagnostic.file).toContain("...[truncated");
    expect(diagnostic.command).toContain("...[truncated");
  });

  it("keeps empty Error messages from masking the original failure", () => {
    const diagnostic = massUlwFailureFromError(new Error(""), {
      laneId: null,
      stage: "execution",
      retryable: false,
    });

    expect(diagnostic.message).toBe("Unknown MASS ULW failure");
  });
});