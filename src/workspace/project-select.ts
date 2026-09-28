import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCode,
  type Lease,
  type LeasePreset,
  type ProjectRegistryEntry,
} from "../types.js";

/** Default lease TTL when no config is threaded in (PRD §7 Project Lease). */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Issue a new active project Lease (PRD §7 Project Lease / §8.2
 * project_select) for the given registry entry and preset.
 */
export function makeLease(entry: ProjectRegistryEntry, preset: LeasePreset, ttlMs = DEFAULT_LEASE_TTL_MS): Lease {
  const issuedAt = Date.now();
  return {
    projectId: entry.projectId,
    leaseId: `lease_${randomUUID()}`,
    projectRoot: entry.root,
    preset,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
}

/**
 * Renew an already-authorized lease without changing its identity when the
 * owner selects the same project/root/preset again. Keeping the lease id
 * stable prevents task/approval identities from changing during a long goal,
 * while still extending the normal short-lived TTL. A changed project root,
 * preset, or expired lease gets a fresh identity.
 */
export function renewLease(
  entry: ProjectRegistryEntry,
  preset: LeasePreset,
  current?: Lease,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): Lease {
  const issuedAt = Date.now();
  if (
    current &&
    current.projectId === entry.projectId &&
    current.projectRoot === entry.root &&
    current.preset === preset &&
    issuedAt <= current.expiresAt
  ) {
    return {
      ...current,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    };
  }
  return makeLease(entry, preset, ttlMs);
}

/**
 * Sliding renewal for a lease that is being used: once less than half of the
 * TTL remains, extend it by a full TTL while keeping its identity, so approval
 * grants keyed by the lease survive long work. Returns null when no extension
 * is due. Expired leases are never revived here, and control leases (desktop
 * input) never slide.
 */
export function slideLease(lease: Lease, ttlMs = DEFAULT_LEASE_TTL_MS, now = Date.now()): Lease | null {
  if (lease.preset === "control" || now > lease.expiresAt) return null;
  if (lease.expiresAt - now >= ttlMs / 2) return null;
  return { ...lease, expiresAt: now + ttlMs };
}

/** Shape session state is expected to carry the active lease under (PRD §10 sessions.json). */
interface SessionWithLease {
  lease?: Lease;
  activeLease?: Lease;
}

function isSessionWithLease(session: unknown): session is SessionWithLease {
  return typeof session === "object" && session !== null;
}

/**
 * Look up and validate the active lease for `projectId` from session state.
 *
 * @throws {DomainError} LEASE_REQUIRED if no valid lease exists for the project.
 */
export function requireLease(session: unknown, projectId: string): Lease {
  if (!isSessionWithLease(session)) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active session/lease", { projectId });
  }

  const lease = session.lease ?? session.activeLease;
  if (!lease) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active lease for project", { projectId });
  }

  if (lease.projectId !== projectId) {
    throw new DomainError(
      ErrorCode.LEASE_REQUIRED,
      "Active lease is for a different project",
      { projectId, leaseProjectId: lease.projectId },
    );
  }

  if (Date.now() > lease.expiresAt) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "Lease expired", {
      projectId,
      expiresAt: lease.expiresAt,
    });
  }

  return lease;
}
