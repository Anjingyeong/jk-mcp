import { describe, expect, it } from "vitest";
import { rmResilient } from "./mass-ulw-runner-fixtures.js";

describe("MASS ULW cleanup", () => {
  it("throws after every allowed removal attempt fails", async () => {
    let attempts = 0;
    const remove = async (): Promise<void> => {
      attempts += 1;
      throw Object.assign(new Error("profile is locked"), { code: "EBUSY" as const });
    };

    await expect(rmResilient("C:\\locked-mass-ulw-root", 3, remove)).rejects.toThrow(/cleanup exhausted/i);
    expect(attempts).toBe(3);
  });
});
