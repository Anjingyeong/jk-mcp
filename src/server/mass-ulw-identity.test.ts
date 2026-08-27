import { describe, expect, it } from "vitest";
import { createMassUlwExecutionIdentity } from "./mass-ulw-identity.js";

describe("MASS ULW project-scoped execution identity", () => {
  it("separates the same external loop across two projects and canonicalizes repository aliases", async () => {
    // Given
    const first = await createMassUlwExecutionIdentity({ projectId: "project-a", repositoryRoot: process.cwd(), externalLoopId: "shared-loop" });
    const alias = await createMassUlwExecutionIdentity({ projectId: "project-a", repositoryRoot: `${process.cwd()}/.`, externalLoopId: "shared-loop" });

    // When
    const second = await createMassUlwExecutionIdentity({ projectId: "project-b", repositoryRoot: process.cwd(), externalLoopId: "shared-loop" });

    // Then
    expect(alias.executionId).toBe(first.executionId);
    expect(second.executionId).not.toBe(first.executionId);
    expect(first).toMatchObject({ projectId: "project-a", externalLoopId: "shared-loop" });
    expect(first.executionId).toMatch(/^mass-[a-f0-9]{64}$/u);
  });
});
