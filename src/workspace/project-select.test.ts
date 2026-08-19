import { describe, expect, it } from "vitest";
import { ErrorCode, type Lease, type ProjectRegistryEntry } from "../types.js";
import { makeLease, requireLease } from "./project-select.js";

const alpha: ProjectRegistryEntry = {
  projectId: "alpha-app",
  name: "alpha-app",
  root: "/workspace/alpha-app",
  aliases: ["alpha-app"],
};

describe("makeLease", () => {
  it("issues a lease scoped to the project root with the requested preset", () => {
    const lease = makeLease(alpha, "read-only");
    expect(lease.projectId).toBe("alpha-app");
    expect(lease.projectRoot).toBe(alpha.root);
    expect(lease.preset).toBe("read-only");
    expect(lease.leaseId).toMatch(/^lease_/);
    expect(lease.expiresAt).toBeGreaterThan(lease.issuedAt);
  });

  it("generates unique lease ids across calls", () => {
    const a = makeLease(alpha, "read-only");
    const b = makeLease(alpha, "read-only");
    expect(a.leaseId).not.toBe(b.leaseId);
  });
});

describe("requireLease", () => {
  it("returns the lease when session has a valid active lease for the project", () => {
    const lease: Lease = {
      projectId: "alpha-app",
      leaseId: "lease_1",
      projectRoot: alpha.root,
      preset: "read-only",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const result = requireLease({ lease }, "alpha-app");
    expect(result).toEqual(lease);
  });

  it("accepts activeLease as an alternate session field name", () => {
    const lease: Lease = {
      projectId: "alpha-app",
      leaseId: "lease_2",
      projectRoot: alpha.root,
      preset: "read-only",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const result = requireLease({ activeLease: lease }, "alpha-app");
    expect(result).toEqual(lease);
  });

  it("throws LEASE_REQUIRED when session is undefined", () => {
    expect(() => requireLease(undefined, "alpha-app")).toThrowError(
      expect.objectContaining({ code: ErrorCode.LEASE_REQUIRED }),
    );
  });

  it("throws LEASE_REQUIRED when session has no lease", () => {
    expect(() => requireLease({}, "alpha-app")).toThrowError(
      expect.objectContaining({ code: ErrorCode.LEASE_REQUIRED }),
    );
  });

  it("throws LEASE_REQUIRED when lease is for a different project", () => {
    const lease: Lease = {
      projectId: "beta-app",
      leaseId: "lease_3",
      projectRoot: "/workspace/beta-app",
      preset: "read-only",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    expect(() => requireLease({ lease }, "alpha-app")).toThrowError(
      expect.objectContaining({ code: ErrorCode.LEASE_REQUIRED }),
    );
  });

  it("throws LEASE_REQUIRED when lease has expired", () => {
    const lease: Lease = {
      projectId: "alpha-app",
      leaseId: "lease_4",
      projectRoot: alpha.root,
      preset: "read-only",
      issuedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
    };
    expect(() => requireLease({ lease }, "alpha-app")).toThrowError(
      expect.objectContaining({ code: ErrorCode.LEASE_REQUIRED }),
    );
  });
});
