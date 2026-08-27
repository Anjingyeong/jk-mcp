import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

export type MassUlwExecutionIdentity = {
  readonly projectId: string;
  readonly canonicalRepositoryRoot: string;
  readonly externalLoopId: string;
  readonly executionId: string;
};

export async function createMassUlwExecutionIdentity(input: {
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly externalLoopId: string;
}): Promise<MassUlwExecutionIdentity> {
  const canonicalRepositoryRoot = path.normalize(await realpath(input.repositoryRoot));
  const digest = createHash("sha256")
    .update("mass-ulw-execution-v1\0")
    .update(input.projectId)
    .update("\0")
    .update(canonicalRepositoryRoot.toLowerCase())
    .update("\0")
    .update(input.externalLoopId)
    .digest("hex");
  return {
    projectId: input.projectId,
    canonicalRepositoryRoot,
    externalLoopId: input.externalLoopId,
    executionId: `mass-${digest}`,
  };
}
