import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { computeEffectivePermission, getActiveRoleForProjectContext, roleAllowsCapability } from "../roles/roles.js";
import { requireLease } from "./project-select.js";

/**
 * Capability ceiling checked against the active project lease's preset.
 * Shared by src/server/tools.ts (file/command/git tools) and
 * src/control/tools.ts (desktop-control tools) so both enforce the same
 * preset -> capability table from a single source of truth.
 */
export type LeaseCapability = "read" | "verify" | "write" | "image" | "remote" | "control";

const ALLOWED_CAPABILITIES: Record<LeasePreset, ReadonlySet<LeaseCapability>> = {
  "read-only": new Set(["read"]),
  "tests-only": new Set(["read", "verify"]),
  "full-write": new Set(["read", "verify", "write", "image", "remote"]),
  "image-only": new Set(["read", "image"]),
  control: new Set(["read", "control"]),
};

/**
 * Require an unexpired lease for `projectId` that permits `capability`.
 * Throws LEASE_REQUIRED (no/expired/mismatched lease) or PERMISSION_DENIED
 * (lease exists but its preset does not grant the requested capability).
 */
export async function requireProjectLease(
  ctx: ToolContext,
  projectId: string,
  capability: LeaseCapability = "read",
): Promise<Lease> {
  const session = await ctx.store.getSession();
  const lease = requireLease(session, projectId);
  const activeRole = await getActiveRoleForProjectContext(ctx, projectId);
  const role = activeRole.role;
  const projectAllows = ALLOWED_CAPABILITIES[lease.preset].has(capability);
  const roleAllows = roleAllowsCapability(role.permissionPreset, capability);
  if (!projectAllows || !roleAllows) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Effective permission does not allow ${capability}`, {
      projectId,
      projectPreset: lease.preset,
      roleId: role.id,
      role: role.name,
      rolePreset: role.permissionPreset,
      effectivePreset: computeEffectivePermission(lease.preset, role.permissionPreset),
      capability,
    });
  }
  return lease;
}
