import { json } from "express";
import type { Express, Response } from "express";
import { z } from "zod";
import { requireControlApiAccess } from "../control-center/auth.js";
import { getExecutorProjectRegistry } from "../executors/broker.js";
import { DomainError, ErrorCode, type ProjectRegistryEntry, type ToolContext } from "../types.js";
import {
  ROLE_TOOL_VALUES,
  WORKFLOW_PRESETS,
  buildActiveRoleContext,
  deleteCustomRole,
  exportRoleBundle,
  importRoleBundle,
  listRoles,
  resolveCanonicalRoleProjectId,
  saveCustomRole,
  selectRoleForProject,
  setDefaultRoleForProject,
} from "./roles.js";

const SaveRoleBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  instructions: z.string().max(12_000).optional(),
  permissionPreset: z.enum(["inherit", "read-only", "tests-only", "full-write", "image-only"]),
  tools: z.array(z.enum(ROLE_TOOL_VALUES)).max(ROLE_TOOL_VALUES.length).optional(),
  skills: z.array(z.string().min(1).max(80)).max(30).optional(),
  workflowPreference: z.string().max(1000).optional(),
});

const SelectRoleBodySchema = z.object({ roleId: z.string().min(1).max(100) });

function projectIdentityTokens(project: ProjectRegistryEntry): Set<string> {
  return new Set([project.projectId, project.name, ...project.aliases].map((value) => value.toLowerCase()));
}

function collapseLogicalProjectMirrors(
  localProjects: ProjectRegistryEntry[],
  remoteProjects: ProjectRegistryEntry[],
): ProjectRegistryEntry[] {
  const localTokens = localProjects.map(projectIdentityTokens);
  const visibleRemote = remoteProjects.filter((remote) => {
    const remoteTokens = projectIdentityTokens(remote);
    return !localTokens.some((tokens) => [...remoteTokens].some((token) => tokens.has(token)));
  });
  return [...localProjects, ...visibleRemote];
}

function sendApiError(res: Response, err: unknown): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: "Invalid role input", details: err.flatten() });
    return;
  }
  if (err instanceof DomainError) {
    const status = err.code === ErrorCode.PROJECT_NOT_FOUND ? 404 : err.code === ErrorCode.PERMISSION_DENIED ? 403 : 400;
    res.status(status).json({ ok: false, code: err.code, error: err.message, details: err.details });
    return;
  }
  res.status(500).json({ ok: false, error: (err as Error).message || "Role management failed" });
}

/**
 * Owner-only management surface for the JK app and authenticated remote
 * Control Center.
 * These routes are deliberately NOT MCP tools: v1 roles are selected by the
 * human owner, so a remote ChatGPT session cannot switch itself
 * from Reviewer/QA into Builder and increase its effective permission.
 */
export function registerRoleManagementRoutes(app: Express, ctx: ToolContext): void {
  app.use("/api/jk", requireControlApiAccess(ctx), json({ limit: "64kb" }));

  app.get("/api/jk/projects", async (_req, res) => {
    try {
      const session = await ctx.store.getSession();
      const activeProjectId =
        session && typeof session === "object" && typeof (session as { activeProjectId?: unknown }).activeProjectId === "string"
          ? ((session as { activeProjectId: string }).activeProjectId ?? null)
          : null;
      const remoteProjects = await getExecutorProjectRegistry(ctx.stateDir, ctx.registry);
      const projects = collapseLogicalProjectMirrors(ctx.registry, remoteProjects);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        activeProjectId,
        projects: projects.map((project) => ({
          projectId: project.projectId,
          name: project.name,
          root: project.root,
          branch: project.branch ?? null,
          dirty: project.dirty ?? false,
          executorId: project.executorId ?? null,
          executorKind: project.executorKind ?? "local",
          executorOnline: project.executorOnline ?? true,
          sourceProjectId: project.sourceProjectId ?? project.projectId,
        })),
      });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/roles", async (req, res) => {
    try {
      const roles = await listRoles(ctx.stateDir);
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
      const activeRoleContext = projectId ? await buildActiveRoleContext(ctx, projectId) : null;
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, roles, activeRoleContext, workflowPresets: WORKFLOW_PRESETS });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/roles", async (req, res) => {
    try {
      const body = SaveRoleBodySchema.parse(req.body);
      const role = await saveCustomRole(ctx.stateDir, body);
      await ctx.ledger.append({ type: "role.created", roleId: role.id, roleName: role.name });
      res.status(201).json({ ok: true, role });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.put("/api/jk/roles/:roleId", async (req, res) => {
    try {
      const body = SaveRoleBodySchema.parse(req.body);
      const role = await saveCustomRole(ctx.stateDir, { ...body, id: req.params.roleId });
      await ctx.ledger.append({ type: "role.updated", roleId: role.id, roleName: role.name });
      res.json({ ok: true, role });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.delete("/api/jk/roles/:roleId", async (req, res) => {
    try {
      const deleted = await deleteCustomRole(ctx.stateDir, req.params.roleId);
      if (!deleted) {
        res.status(404).json({ ok: false, error: `Role not found: ${req.params.roleId}` });
        return;
      }
      await ctx.ledger.append({ type: "role.deleted", roleId: req.params.roleId });
      res.json({ ok: true, roleId: req.params.roleId });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/roles/export", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, bundle: await exportRoleBundle(ctx.stateDir) });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/roles/import", async (req, res) => {
    try {
      const result = await importRoleBundle(ctx.stateDir, req.body);
      await ctx.ledger.append({ type: "role.imported", count: result.imported });
      res.json({ ok: true, ...result });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/projects/:projectId/role", async (req, res) => {
    try {
      const context = await buildActiveRoleContext(ctx, req.params.projectId);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, context });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/projects/:projectId/role", async (req, res) => {
    try {
      const body = SelectRoleBodySchema.parse(req.body);
      const projectId = await resolveCanonicalRoleProjectId(ctx, req.params.projectId);
      const role = await selectRoleForProject(ctx.stateDir, projectId, body.roleId);
      const context = await buildActiveRoleContext(ctx, projectId);
      await ctx.ledger.append({
        type: "role.selected",
        projectId,
        roleId: role.id,
        roleName: role.name,
        effectivePermission: context.effectivePermission,
      });
      res.json({ ok: true, role, context });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/projects/:projectId/default-role", async (req, res) => {
    try {
      const body = SelectRoleBodySchema.parse(req.body);
      const projectId = await resolveCanonicalRoleProjectId(ctx, req.params.projectId);
      const role = await setDefaultRoleForProject(ctx.stateDir, projectId, body.roleId);
      const context = await buildActiveRoleContext(ctx, projectId);
      await ctx.ledger.append({ type: "role.defaulted", projectId, roleId: role.id, roleName: role.name });
      res.json({ ok: true, role, context });
    } catch (err) {
      sendApiError(res, err);
    }
  });
}
