import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCode,
  type Lease,
  type LeasePreset,
  type ProjectRegistryEntry,
} from "../types.js";

/** Default lease TTL when no config is threaded in (PRD §7 Project Lease). */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Issue a new active project Lease (PRD §7 Project Lease / §8.2
 * project_select) for the given registry entry and preset.
 */
export function makeLease(entry: ProjectRegistryEntry, preset: LeasePreset): Lease {
  const issuedAt = Date.now();
  return {
    projectId: entry.projectId,
    leaseId: `lease_${randomUUID()}`,
    projectRoot: entry.root,
    preset,
    issuedAt,
    expiresAt: issuedAt + DEFAULT_LEASE_TTL_MS,
  };
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
