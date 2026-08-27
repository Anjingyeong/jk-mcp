import { describe, expect, it } from "vitest";
import {
  REQUIRED_GOAL_LOOP_INPUT_FIELDS,
  getRegisteredToolSchemaHealth,
  recordRegisteredToolSchemas,
} from "./runtime-schema-health.js";

describe("runtime tool schema health", () => {
  it("marks a stale goal_loop schema incompatible and reports the missing fields", () => {
    const health = recordRegisteredToolSchemas([
      {
        name: "goal_loop",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
      },
    ]);

    expect(health.toolSchemaCompatible).toBe(false);
    expect(health.missingGoalLoopInputFields).toEqual([...REQUIRED_GOAL_LOOP_INPUT_FIELDS]);
    expect(health.toolSchemaFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts the current goal_loop contract only when all required fields are registered", () => {
    const properties = Object.fromEntries(
      REQUIRED_GOAL_LOOP_INPUT_FIELDS.map((field) => [field, { type: "object" }]),
    );
    const health = recordRegisteredToolSchemas([
      { name: "runtime_upgrade", inputSchema: { type: "object", properties: { projectId: { type: "string" } } } },
      { name: "goal_loop", inputSchema: { type: "object", properties } },
    ]);

    expect(health.toolSchemaCompatible).toBe(true);
    expect(health.missingGoalLoopInputFields).toEqual([]);
    expect(health.goalLoopInputFields).toEqual([...REQUIRED_GOAL_LOOP_INPUT_FIELDS].sort());
    expect(getRegisteredToolSchemaHealth()).toMatchObject({ toolSchemaCompatible: true });
  });
});
