// MCP tool registrations (workspace). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { isTaskWorkspaceId, TaskWorkspaceStore } from "../../workspace/task-workspaces.js";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../../types.js";
import { scanWorkspaceWithRuntimeSelf } from "../../workspace/registry.js";
import { renewLease } from "../../workspace/project-select.js";
import { redact } from "../../policy/secrets.js";
import { autoSelectRoleForTask } from "../../roles/roles.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadSession, updateSessionState, createWorkSessionId, WorkSessionIdSchema, currentRegistry, toProject, requireProjectLease, leaseTtlMs, resolveOrThrow, READ_ONLY_ANNOTATIONS, LOCAL_STATE_ANNOTATIONS, chatGptToolMeta, withErrorMapping } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerTaskWorkspaceTool(registerTool: RegisterTool, ctx: ToolContext): void {
  registerTool(
    "task_workspace",
    {
      title: "Manage persistent task workspaces",
      description: "Use for isolated ChatGPT-web coding without any model API. Create a persistent private Git checkout from a selected source project; all existing tools use the returned projectId. List/status/resume survive restarts. Verify runs a discovered verify command and issues a revision-bound proof. Publish applies reviewed, verified changes to the original checkout without commit/push; discard deletes only the managed checkout and requires its current fingerprint. Actions clients use call_tool with toolName=task_workspace and input containing action and its parameters.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        action: z.enum(["create", "list", "status", "archive", "resume", "discard", "verify", "publish"]),
        projectId: z.string().optional(),
        workSessionId: WorkSessionIdSchema.optional(),
        goal: z.string().trim().min(1).max(4000).optional(),
        commandId: z.string().optional(),
        timeoutSec: z.number().int().min(1).max(300).optional(),
        verificationId: z.string().optional(),
        reviewSummary: z.string().trim().min(1).max(4000).optional(),
        expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
        confirmDiscard: z.boolean().optional(),
      },
    },
    async (input) => withErrorMapping(ctx, "task_workspace", input, async () => {
      const workspaces = new TaskWorkspaceStore(ctx.stateDir);
      if (input.action === "list") {
        const items = await workspaces.list();
        return makeResult<Record<string, unknown>>({ workspaces: items.filter((item) => !input.projectId || item.sourceProjectId === input.projectId || item.id === input.projectId).map((item) => ({ projectId: item.id, sourceProjectId: item.sourceProjectId, workSessionId: item.workSessionId, goal: item.goal, status: item.status, updatedAt: item.updatedAt })), externalModelRequired: false }, "Persistent task workspaces; resume the matching task instead of creating another copy.");
      }
      if (!input.projectId) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "projectId is required");
      const activate = async (id: string, workSessionId: string) => {
        await currentRegistry(ctx);
        const entry = await resolveOrThrow(ctx, { projectId: id });
        await updateSessionState(ctx, (session) => ({ ...session, activeProjectId: id, lease: renewLease(entry, "full-write", session.lease ?? undefined, leaseTtlMs(ctx)), mode: "read" }));
        return { projectId: id, workSessionId, root: entry.root, nextActions: [
          `Use projectId=${id} and workSessionId=${workSessionId} for every file, command, Git, E2E, memory and goal tool.`,
          "Continue through goal_intake/goal_loop with ChatGPT web as the reasoning surface.",
          "After editing, call task_workspace action=verify with a command_list verify commandId. Review that exact diff, then publish with the returned verificationId and reviewSummary.",
        ] };
      };
      if (input.action === "create") {
        if (!input.goal) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "goal is required to create a workspace");
        const source = await resolveOrThrow(ctx, { projectId: input.projectId });
        await requireProjectLease(ctx, source.projectId, "write");
        const record = await workspaces.create(source, input.workSessionId ?? createWorkSessionId(), redact(input.goal));
        await autoSelectRoleForTask(ctx, record.id, { mode: "implement", goal: record.goal });
        const active = await activate(record.id, record.workSessionId);
        await ctx.ledger.append({ type: "task-workspace.created", projectId: record.id, sourceProjectId: source.projectId, workSessionId: record.workSessionId });
        return makeResult<Record<string, unknown>>({ ...active, workspace: await workspaces.status(record.id), externalModelRequired: false }, "Persistent workspace is active. Source checkout is unchanged; use the returned projectId.");
      }
      if (!isTaskWorkspaceId(input.projectId)) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Use the projectId returned by task_workspace create/list");
      return workspaces.locked(input.projectId, async () => {
        const id = input.projectId!;
        const record = await workspaces.load(id);
        if (input.workSessionId && input.workSessionId !== record.workSessionId) {
          throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "workSessionId does not belong to this task workspace");
        }
        if (input.action === "status") return makeResult<Record<string, unknown>>({ workspace: await workspaces.status(id) }, "Workspace status and revision-bound verification.");
        if (input.action === "resume") {
          // Resume needs a write lease for either this task or its original source.
          const session = await loadSession(ctx);
          const authorizedId = session.lease?.projectId === id ? id : record.sourceProjectId;
          await requireProjectLease(ctx, authorizedId, "write");
          await workspaces.resume(id);
          return makeResult<Record<string, unknown>>({ ...await activate(id, record.workSessionId), workspace: await workspaces.status(id) }, "Resumed the same persistent checkout.");
        }
        const session = await loadSession(ctx);
        const authorizedId = session.lease?.projectId === id ? id : record.sourceProjectId;
        await requireProjectLease(ctx, authorizedId, input.action === "verify" ? "verify" : "write");
        if (input.action === "verify") {
          if (!input.commandId) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "commandId is required");
          await workspaces.verify(id, input.commandId, input.timeoutSec);
        } else if (input.action === "publish") {
          if (!input.verificationId || !input.reviewSummary) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "verificationId and reviewSummary are required");
          await workspaces.publish(id, input.verificationId, redact(input.reviewSummary));
        } else if (input.action === "archive") {
          await workspaces.archive(id);
        } else if (input.action === "discard") {
          if (!input.confirmDiscard || !input.expectedFingerprint) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Discard requires confirmDiscard=true and the fingerprint returned by status");
          await workspaces.discard(id, input.expectedFingerprint);
        }
        if (["archive", "discard", "publish"].includes(input.action)) {
          await updateSessionState(ctx, (current) => current.activeProjectId === id ? { ...current, activeProjectId: null, lease: null } : current);
        }
        await ctx.ledger.append({ type: `task-workspace.${input.action}`, projectId: id, workSessionId: record.workSessionId });
        return makeResult<Record<string, unknown>>({ workspace: await workspaces.status(id), externalModelRequired: false }, `Workspace ${input.action} completed; inspect verificationCurrent before claiming success.`);
      });
    }),
  );
}

export function registerWorkspaceTools(registerTool: RegisterTool, ctx: ToolContext): void {

  registerTool(
    "workspace_list_projects",
    {
      title: "List workspace projects",
      description: "List projects registered in the workspace, optionally filtered by name query.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Listing workspace projects...", "Workspace projects listed"),
      inputSchema: {
        query: z.string().optional(),
        includeDirty: z.boolean().optional(),
        includeRecent: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "workspace_list_projects", input, async () => {
        let entries = await currentRegistry(ctx);
        if (input.query && input.query.trim().length > 0) {
          const norm = input.query.trim().toLowerCase();
          entries = entries.filter(
            (e) =>
              e.name.toLowerCase().includes(norm) ||
              e.projectId.toLowerCase().includes(norm) ||
              e.aliases.some((a) => a.toLowerCase().includes(norm)),
          );
        }
        const limit = input.limit ?? 100;
        const projects = entries.slice(0, limit).map(toProject);
        return makeResult(
          { projects },
          `Found ${projects.length} project(s).`,
        );
      });
    },
  );

  registerTool(
    "workspace_get_project",
    {
      title: "Get project metadata",
      description: "Get canonical metadata for a single project by id or filesystem path.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Loading project metadata...", "Project metadata loaded"),
      inputSchema: {
        projectId: z.string().optional(),
        path: z.string().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "workspace_get_project", input, async () => {
        const entries = await currentRegistry(ctx);

        if (input.path) {
          let realPath: string;
          try {
            realPath = await fs.realpath(input.path);
          } catch {
            throw new DomainError(ErrorCode.PATH_OUTSIDE_WORKSPACE, "path does not exist", {
              path: input.path,
            });
          }
          const realWorkspace = await fs.realpath(ctx.workspaceRoot).catch(() => ctx.workspaceRoot);
          const rel = path.relative(realWorkspace, realPath);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new DomainError(ErrorCode.PATH_OUTSIDE_WORKSPACE, "path is outside workspace root", {
              path: input.path,
            });
          }
          const found = entries.find((e) => path.resolve(e.root) === path.resolve(realPath));
          if (!found) {
            throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "No project registered at path", {
              path: input.path,
            });
          }
          return makeResult({ project: toProject(found) }, `Project: ${found.name}`);
        }

        if (input.projectId) {
          const found = entries.find((e) => e.projectId === input.projectId);
          if (!found) {
            throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project not found: ${input.projectId}`);
          }
          return makeResult({ project: toProject(found) }, `Project: ${found.name}`);
        }

        throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "Must provide projectId or path");
      });
    },
  );

  registerTool(
    "workspace_refresh_index",
    {
      title: "Refresh workspace index",
      description: "Rescan the workspace root to refresh the project registry.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Refreshing workspace index...", "Workspace index refreshed"),
      inputSchema: {
        depth: z.number().int().optional(),
        includeHidden: z.boolean().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "workspace_refresh_index", input, async () => {
        const scanned = await scanWorkspaceWithRuntimeSelf(ctx.workspaceRoot);
        ctx.registry.splice(0, ctx.registry.length, ...scanned);
        await ctx.store.saveProjects(scanned);
        const updatedAt = Date.now();
        return makeResult(
          { count: scanned.length, updatedAt },
          `Refreshed workspace index: ${scanned.length} project(s).`,
        );
      });
    },
  );
}
