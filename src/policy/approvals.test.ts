import { describe, expect, it } from "vitest";
import { needsApproval } from "./approvals.js";

describe("needsApproval", () => {
  it("does not require approval for observe/read/verify/write tiers", () => {
    expect(needsApproval("observe")).toBe(false);
    expect(needsApproval("read")).toBe(false);
    expect(needsApproval("verify")).toBe(false);
    expect(needsApproval("write")).toBe(false);
  });

  it("requires approval for destructive and network tiers", () => {
    expect(needsApproval("destructive")).toBe(true);
    expect(needsApproval("network")).toBe(true);
  });

  it("requires approval for the danger tier", () => {
    expect(needsApproval("danger")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(needsApproval("DESTRUCTIVE")).toBe(true);
    expect(needsApproval("Read")).toBe(false);
  });

  it("fails closed for unrecognized tiers", () => {
    expect(needsApproval("something-unknown")).toBe(true);
  });
});
