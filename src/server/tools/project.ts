// MCP tool registrations (project). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { isTaskWorkspaceId, TaskWorkspaceStore } from "../../workspace/task-workspaces.js";
import { DomainError, ErrorCode, makeResult, type LeasePreset, type ToolContext } from "../../types.js";
import { findProject } from "../../workspace/registry.js";
import { makeLease, renewLease } from "../../workspace/project-select.js";
import { auditSeoGeoUrl } from "../../audit/seo-geo-audit.js";
import { listCommands } from "../../exec/command-runner.js";
import { gitStatus } from "../../git/git.js";
import { resolveInProject } from "../../policy/paths.js";
import { redact } from "../../policy/secrets.js";
import { buildActiveRoleContext } from "../../roles/roles.js";
import { clearKill } from "../../control/queue.js";
import { dispatchExecutorJob } from "../../executors/broker.js";
import { impulseResumeLine, impulseResumeSummary } from "../../orchestration/impulse-checkpoint.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadSession, updateSessionState, WorkSessionIdSchema, MAX_WORK_SESSIONS_PER_PROJECT, getWorkContext, rankWorkSessions, chooseResumeCandidate, buildResumeSnapshot, currentRegistry, resolveExecutionProject, bindExecutionLease, requireProjectLease, leaseTtlMs, resolveOrThrow, isRemoteProject, remotePayload, READ_ONLY_ANNOTATIONS, LOCAL_STATE_ANNOTATIONS, chatGptToolMeta, withErrorMapping, readGoalLoopTelemetrySummary, guardSecretPath, pathExists } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerProjectTools(registerTool: RegisterTool, ctx: ToolContext): void {
  // -------------------------------------------------------------------
  // 8.2 Project tools
  // -------------------------------------------------------------------

  registerTool(
    "project_select",
    {
      title: "Select active project",
      description: "Select (and lease) the active project by canonical id, name, or alias for subsequent tool calls. When the user explicitly asks to work on a different project, pass confirmSwitch=true. If the same name exists on multiple machines, use the explicit project id or machine-qualified alias returned by workspace_list_projects.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Selecting active project...", "Active project selected"),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        resumeHint: z.string().max(1000).optional(),
        includeResumeContext: z.boolean().optional(),
        includeResumeSlice: z.boolean().optional(),
        maxResumeSliceLines: z.number().int().min(1).max(300).optional(),
        resumeValidationScope: z.enum(["active", "recent"]).optional(),
        reason: z.string(),
        preset: z.enum(["read-only", "tests-only", "full-write", "image-only", "control"]).optional(),
        confirmSwitch: z.boolean().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "project_select", input, async () => {
        const entries = await currentRegistry(ctx);
        const result = findProject(entries, { projectId: input.projectId, name: input.projectId });
        if (!result.ok) {
          if (result.reason === "ambiguous") {
            throw new DomainError(ErrorCode.AMBIGUOUS_PROJECT, "Multiple projects match", {
              candidates: (result.candidates ?? []).map((c) => c.projectId),
            });
          }
          throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project not found: ${input.projectId}`);
        }
        const entry = await resolveExecutionProject(ctx, { projectId: result.entry.projectId });

        const preset: LeasePreset = input.preset ?? "read-only";
        if (preset === "control" && ctx.remote) {
          // Arming a control lease (and resuming after a kill switch, which
          // only a fresh control grant can do — see
          // src/control/queue.ts setKill/clearKill) must stay local-only
          // (stdio / status bar) even when the desktop-control tools are
          // exposed to ChatGPT: a remote MCP session (src/server/http.ts's
          // /mcp endpoint, ctx.remote) can never self-grant this preset or
          // reopen a killed session. Thrown before any session mutation.
          await ctx.ledger.append({ type: "control.bridge.rejected", preset: "control", remote: true }).catch(() => undefined);
          throw new DomainError(
            ErrorCode.PERMISSION_DENIED,
            "preset=control cannot be granted from a remote MCP session; grant it locally on the Mac.",
            { preset },
          );
        }
        const updatedSession = await updateSessionState(ctx, async (session) => {
          if (
            session.activeProjectId &&
            session.activeProjectId !== entry.projectId &&
            session.lease &&
            Date.now() <= session.lease.expiresAt &&
            !input.confirmSwitch
          ) {
            throw new DomainError(
              ErrorCode.PENDING_WORK_IN_ACTIVE,
              `Active project "${session.activeProjectId}" has an unexpired lease; pass confirmSwitch=true to switch projects`,
              { activeProjectId: session.activeProjectId, required: "confirmSwitch" },
            );
          }
          const lease = preset === "control"
            ? makeLease(entry, preset, leaseTtlMs(ctx))
            : renewLease(entry, preset, session.lease ?? undefined, leaseTtlMs(ctx));
          return {
            ...session,
            activeProjectId: entry.projectId,
            mode: "read",
            lease: bindExecutionLease(lease, entry),
          };
        });
        const lease = updatedSession.lease;
        if (!lease) {
          throw new DomainError(ErrorCode.LEASE_REQUIRED, "project_select did not persist an active lease", {
            projectId: entry.projectId,
          });
        }
        const rankedCandidates = input.resumeHint
          ? rankWorkSessions(updatedSession, entry.projectId, input.resumeHint, 3)
          : [];
        const candidateDecision = input.workSessionId
          ? { selected: null, ambiguous: false, reason: "explicit-work-session-id" }
          : chooseResumeCandidate(rankedCandidates);
        const resolvedWorkSessionId =
          input.workSessionId ?? candidateDecision.selected?.workSessionId ??
          (isTaskWorkspaceId(entry.projectId) ? (await new TaskWorkspaceStore(ctx.stateDir).load(entry.projectId)).workSessionId : undefined);
        const resumableContext = getWorkContext(updatedSession, entry.projectId, resolvedWorkSessionId);
        const shouldIncludeResumeContext =
          input.includeResumeContext ?? Boolean(resolvedWorkSessionId && resumableContext);
        const resumeContext =
          shouldIncludeResumeContext && resumableContext
            ? await buildResumeSnapshot(ctx, entry, resumableContext, {
                includeActiveSlice: input.includeResumeSlice ?? true,
                maxActiveSliceLines: input.maxResumeSliceLines,
                validationScope: input.resumeValidationScope ?? "active",
              })
            : null;
        const resumeCandidates = rankedCandidates.map(({ context: _context, ...candidate }) => candidate);

        await ctx.ledger.append({
          type: "project.selected",
          projectId: entry.projectId,
          reason: input.reason,
          preset,
        });

        if (preset === "control") {
          // A fresh explicit control grant is the only way to resume after a
          // kill switch (see src/control/queue.ts setKill/clearKill).
          await clearKill(ctx.stateDir);
          await ctx.ledger.append({ type: "control.granted", projectId: entry.projectId, reason: input.reason, preset });
        }

        const rulesHint = entry.hasAgentsMd ? "AGENTS.md/CLAUDE.md present" : "no local rules file found";
        const activeRoleContext = await buildActiveRoleContext(ctx, entry.projectId, lease.preset);
        const impulse = await impulseResumeSummary(ctx.stateDir, entry.projectId);
        return makeResult(
          {
            lease: {
              projectId: lease.projectId,
              leaseId: lease.leaseId,
              preset: lease.preset,
              expiresAt: lease.expiresAt,
            },
            activeRoleContext,
            ...(impulse ? { impulse } : {}),
            hasRecentContext: resumableContext !== null,
            workSessionId: resolvedWorkSessionId ?? null,
            autoResumeApplied: Boolean(!input.workSessionId && candidateDecision.selected),
            autoResumeAmbiguous: candidateDecision.ambiguous,
            autoResumeReason: candidateDecision.reason,
            resumeCandidates,
            resumeContext,
            lastActivityAt: resumableContext?.lastActivityAt ?? null,
            instruction: `Active project is now "${entry.name}" (${rulesHint}). Scope confined to ${entry.root}.${
              resumeContext
                ? " Matching recent work context was resolved and hydrated in this response; continue from resumeContext before broad code_search."
                : candidateDecision.ambiguous
                  ? " Resume hint matched multiple close candidates; compare resumeCandidates and pass an explicit workSessionId before using task-specific context."
                  : resumableContext
                    ? " Recent work context exists; call session_resume with includeActiveSlice=true before broad code_search on follow-up work."
                    : ""
            }${impulseResumeLine(impulse)}`,
          },
          `Selected project ${entry.name} with preset ${preset}.${impulseResumeLine(impulse)}`,
        );
      });
    },
  );

  registerTool(
    "work_session_list",
    {
      title: "List project work sessions",
      description:
        "List isolated work-session handles recorded for a project and rank likely resume candidates. Pass hint from the user's follow-up when available.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Listing work sessions...", "Work sessions loaded"),
      inputSchema: {
        projectId: z.string(),
        hint: z.string().max(1000).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "work_session_list", input, async () => {
        const session = await loadSession(ctx);
        const allContexts = Object.values(session.workSessions[input.projectId] ?? {});
        const workSessions = rankWorkSessions(session, input.projectId, input.hint, input.limit ?? 10).map(
          ({ context: _context, ...candidate }) => candidate,
        );
        const suggestedWorkSessionId = workSessions[0]?.workSessionId ?? null;
        return makeResult(
          {
            projectId: input.projectId,
            hintApplied: Boolean(input.hint?.trim()),
            retentionLimit: MAX_WORK_SESSIONS_PER_PROJECT,
            totalWorkSessions: allContexts.length,
            suggestedWorkSessionId,
            workSessions,
          },
          `Found ${allContexts.length} isolated work session(s) for ${input.projectId}; suggested ${suggestedWorkSessionId ?? "none"}.`,
        );
      });
    },
  );

  registerTool(
    "session_resume",
    {
      title: "Resume recent project work",
      description:
        "Load the active project's recent work context and validate stored file hashes before reusing it. Optionally hydrate the remembered active line range from disk in the same call. Returns stale=true for files changed outside jk.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Resuming recent work...", "Recent work context loaded"),
      inputSchema: {
        projectId: z.string().optional(),
        workSessionId: WorkSessionIdSchema.optional(),
        includeActiveSlice: z.boolean().optional(),
        maxActiveSliceLines: z.number().int().min(1).max(300).optional(),
        validationScope: z.enum(["active", "recent"]).optional(),
      },
    },
    async (input) => {
      return withErrorMapping<Record<string, unknown>>(ctx, "session_resume", input, async () => {
        const session = await loadSession(ctx);
        if (!session.activeProjectId) {
          return makeResult(
            { activeProjectId: null, hasContext: false, activeArtifact: null, recentFiles: [] },
            "No active project session to resume.",
          );
        }
        if (input.projectId && input.projectId !== session.activeProjectId) {
          return makeResult(
            {
              activeProjectId: session.activeProjectId,
              requestedProjectId: input.projectId,
              hasContext: false,
              mismatch: true,
              activeArtifact: null,
              recentFiles: [],
            },
            `Active session belongs to ${session.activeProjectId}; ${input.projectId} was requested.`,
          );
        }

        const entry = await resolveOrThrow(ctx, { projectId: session.activeProjectId });
        const impulse = await impulseResumeSummary(ctx.stateDir, session.activeProjectId);
        const workContext = getWorkContext(session, session.activeProjectId, input.workSessionId);
        if (!workContext) {
          return makeResult(
            {
              activeProjectId: session.activeProjectId,
              workSessionId: input.workSessionId ?? null,
              hasContext: false,
              activeArtifact: null,
              recentFiles: [],
              ...(impulse ? { impulse } : {}),
            },
            `Project ${entry.name} is active, but no recent work context has been recorded yet.${impulseResumeLine(impulse)}`,
          );
        }

        const snapshot = await buildResumeSnapshot(ctx, entry, workContext, {
          includeActiveSlice: input.includeActiveSlice,
          maxActiveSliceLines: input.maxActiveSliceLines,
          validationScope: input.validationScope,
        });
        return makeResult(
          {
            activeProjectId: session.activeProjectId,
            workSessionId: input.workSessionId ?? workContext.workSessionId,
            hasContext: true,
            ...snapshot,
            ...(impulse ? { impulse } : {}),
          },
          (snapshot.activeArtifactStale
            ? snapshot.activeSlice
              ? `Recent work loaded for ${entry.name}; active artifact ${workContext.activeArtifact} changed since the stored snapshot, and its remembered range was freshly hydrated from disk.`
              : `Recent work loaded for ${entry.name}; active artifact ${workContext.activeArtifact} is stale and should be re-read before editing.`
            : snapshot.activeSlice
              ? `Recent work loaded for ${entry.name}; stored hashes were validated and the active range was freshly hydrated from disk.`
              : `Recent work loaded for ${entry.name}; stored hashes were validated before reuse.`) + impulseResumeLine(impulse),
        );
      });
    },
  );

  registerTool(
    "executor_restart",
    {
      title: "Restart routed executor",
      description: "Request a supervised restart of the remote executor for a project. The worker acknowledges first; its external supervisor performs the restart a few seconds later.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Scheduling executor restart...", "Executor restart scheduled"),
      inputSchema: {
        projectId: z.string(),
        reason: z.string().max(240).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "executor_restart", input, async () => {
        await requireProjectLease(ctx, input.projectId, "verify");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        if (!isRemoteProject(entry)) {
          throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "executor_restart requires a routed remote executor");
        }
        const result = await dispatchExecutorJob<{ scheduled: boolean; notBefore: number; requestFile: string }>(
          ctx.stateDir,
          entry.executorId,
          "executor_restart",
          remotePayload(entry, { reason: input.reason ?? "JK requested supervised worker restart" }),
          15_000,
        );
        return makeResult(
          { ...result, executorId: entry.executorId, projectId: input.projectId },
          `Executor ${entry.executorId} acknowledged a supervised restart request.`,
        );
      });
    },
  );

  registerTool(
    "project_status",
    {
      title: "Get project status",
      description: "Get git/rule/command status for a project.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Checking project status...", "Project status loaded"),
      inputSchema: {
        projectId: z.string(),
        continuationDetail: z.enum(["compact", "full"]).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "project_status", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        if (isRemoteProject(entry)) {
          const status = await dispatchExecutorJob<{
            branch: string;
            dirtyFiles: string[];
            staged: string[];
            packageHints: string[];
            ruleFiles: string[];
            knownCommands: string[];
            hasCodeBrain: boolean;
          }>(ctx.stateDir, entry.executorId, "project_status", remotePayload(entry, {}));
          return makeResult(
            status,
            `Project ${entry.name} on ${entry.executorId}: branch=${status.branch || "n/a"}, ${status.dirtyFiles.length} dirty file(s).`,
          );
        }
        const [status, commands, goalLoopTelemetry] = await Promise.all([
          gitStatus(entry.root),
          listCommands(entry.root),
          readGoalLoopTelemetrySummary(ctx.stateDir),
        ]);
        const ruleFiles: string[] = [];
        for (const candidate of ["AGENTS.md", "CLAUDE.md", ".codex/config.toml"]) {
          if (await pathExists(path.join(entry.root, candidate))) ruleFiles.push(candidate);
        }
        return makeResult(
          {
            branch: status.branch,
            dirtyFiles: status.dirtyFiles,
            staged: status.staged,
            packageHints: entry.packageHints ?? [],
            ruleFiles,
            knownCommands: commands.map((c) => c.commandId),
            hasCodeBrain: entry.hasCodeBrain ?? false,
            goalLoopTelemetry,
          },
          `Project ${entry.name}: branch=${status.branch || "n/a"}, ${status.dirtyFiles.length} dirty file(s).`,
        );
      });
    },
  );

  registerTool(
    "seo_geo_audit",
    {
      title: "Audit a public URL for SEO and GEO readiness",
      description:
        "Fetch a public http(s) page through JK's SSRF/DNS-rebinding guard and return an evidence-backed SEO + GEO readiness audit. Checks metadata, crawlability, sitemap/robots, JSON-LD, content structure, provenance, and citability. Scores are heuristics, not ranking or AI-citation guarantees.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Auditing SEO/GEO readiness...", "SEO/GEO audit complete"),
      inputSchema: {
        url: z.string().url(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "seo_geo_audit", input, async () => {
        const audit = await auditSeoGeoUrl(input.url);
        return makeResult(
          { ...audit },
          `SEO/GEO readiness ${audit.score.total}/100 (${audit.score.grade}); ${audit.priorities.length} prioritized improvement(s).`,
        );
      });
    },
  );

  registerTool(
    "project_rules",
    {
      title: "Read project rules",
      description:
        "Read local agent rule files for a project, optionally scoped to a path so nested AGENTS.md/CLAUDE.md files are returned root-to-leaf (secret values are never emitted).",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Reading project rules...", "Project rules loaded"),
      inputSchema: {
        projectId: z.string(),
        path: z.string().min(1).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "project_rules", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        if (isRemoteProject(entry)) {
          const remote = await dispatchExecutorJob<{
            scopePath: string;
            hierarchical: boolean;
            rules: { file: string; summary: string }[];
          }>(
            ctx.stateDir,
            entry.executorId,
            "project_rules",
            remotePayload(entry, { path: input.path }),
          );
          return makeResult(
            remote,
            `Found ${remote.rules.length} rule file(s) for ${entry.name} on ${entry.executorId}${input.path ? ` at ${remote.scopePath}` : ""}.`,
          );
        }
        const rules: { file: string; summary: string }[] = [];
        const root = path.resolve(entry.root);
        let scopeDir = root;
        let scopePath = ".";

        if (input.path) {
          const target = await resolveInProject(entry.root, input.path, { allowSymlink: true });
          const stat = await fs.stat(target).catch(() => null);
          scopeDir = stat?.isDirectory() ? target : path.dirname(target);
          scopePath = path.relative(root, target).split(path.sep).join("/") || ".";
        }

        const directories: string[] = [];
        let cursor = path.resolve(scopeDir);
        while (true) {
          directories.unshift(cursor);
          if (cursor === root) break;
          const parent = path.dirname(cursor);
          if (parent === cursor || path.relative(root, parent).startsWith("..")) break;
          cursor = parent;
        }

        for (const directory of directories) {
          const candidates = directory === root
            ? [".codex/config.toml", "AGENTS.md", "CLAUDE.md"]
            : ["AGENTS.md", "CLAUDE.md"];
          for (const candidate of candidates) {
            const abs = path.join(directory, candidate);
            if (!(await pathExists(abs))) continue;
            await guardSecretPath(ctx, abs, "project_rules");
            const raw = await fs.readFile(abs, "utf8").catch(() => "");
            const redacted = redact(raw);
            const summary = redacted.split("\n").slice(0, 20).join("\n").slice(0, 2000);
            const file = path.relative(root, abs).split(path.sep).join("/") || candidate;
            rules.push({ file, summary });
          }
        }
        return makeResult(
          { scopePath, hierarchical: Boolean(input.path), rules },
          `Found ${rules.length} rule file(s) for ${entry.name}${input.path ? ` at ${scopePath}` : ""}.`,
        );
      });
    },
  );
}
