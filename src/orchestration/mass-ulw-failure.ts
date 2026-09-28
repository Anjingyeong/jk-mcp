import { z } from "zod";

const MAX_FAILURE_MESSAGE_CHARS = 4_096;
const MAX_FAILURE_OUTPUT_CHARS = 16_384;
const MAX_FAILURE_IDENTIFIER_CHARS = 256;
const MAX_FAILURE_PATH_CHARS = 2_048;
const MAX_FAILURE_COMMAND_CHARS = 4_096;

function boundedDiagnosticString(maxChars: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string" || value.length <= maxChars) return value;
    let omittedChars = value.length - maxChars;
    let suffix = `\n...[truncated ${omittedChars} chars]`;
    for (;;) {
      const retainedChars = Math.max(0, maxChars - suffix.length);
      const exactOmittedChars = value.length - retainedChars;
      if (exactOmittedChars === omittedChars) {
        return `${value.slice(0, retainedChars)}${suffix}`;
      }
      omittedChars = exactOmittedChars;
      suffix = `\n...[truncated ${omittedChars} chars]`;
    }
  }, z.string());
}

export const MassUlwFailureStageSchema = z.enum([
  "preflight",
  "checkout",
  "patch_apply",
  "execution",
  "verification",
  "commit",
  "merge",
  "final_verification",
  "publish",
]);

export const MassUlwFailureDiagnosticSchema = z.object({
  laneId: boundedDiagnosticString(MAX_FAILURE_IDENTIFIER_CHARS).pipe(z.string().min(1)).nullable(),
  stage: MassUlwFailureStageSchema,
  file: boundedDiagnosticString(MAX_FAILURE_PATH_CHARS).pipe(z.string().min(1)).optional(),
  command: boundedDiagnosticString(MAX_FAILURE_COMMAND_CHARS).pipe(z.string().min(1)).optional(),
  exitCode: z.number().int().nullable().optional(),
  stdoutSummary: boundedDiagnosticString(MAX_FAILURE_OUTPUT_CHARS).optional(),
  stderrSummary: boundedDiagnosticString(MAX_FAILURE_OUTPUT_CHARS).optional(),
  baseCommit: boundedDiagnosticString(MAX_FAILURE_IDENTIFIER_CHARS).pipe(z.string().min(1)).optional(),
  checkoutCommit: boundedDiagnosticString(MAX_FAILURE_IDENTIFIER_CHARS).pipe(z.string().min(1)).optional(),
  retryable: z.boolean(),
  message: boundedDiagnosticString(MAX_FAILURE_MESSAGE_CHARS).pipe(z.string().min(1)),
}).strict();

export type MassUlwFailureStage = z.infer<typeof MassUlwFailureStageSchema>;
export type MassUlwFailureDiagnostic = z.infer<typeof MassUlwFailureDiagnosticSchema>;

export class MassUlwStageError extends Error {
  constructor(readonly diagnostic: MassUlwFailureDiagnostic, options?: ErrorOptions) {
    super(diagnostic.message, options);
    this.name = "MassUlwStageError";
  }
}

export function massUlwFailureFromError(
  error: unknown,
  input: Omit<MassUlwFailureDiagnostic, "message"> & { message?: string },
): MassUlwFailureDiagnostic {
  const inferredMessage = error instanceof Error ? error.message : String(error);
  const message = (input.message ?? inferredMessage) || "Unknown MASS ULW failure";
  return MassUlwFailureDiagnosticSchema.parse({
    ...input,
    message,
  });
}
