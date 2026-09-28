// MCP tool registrations (goal). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { Store, TaskStateSchema } from "../../state/store.js";
import { isTaskWorkspaceId, TaskWorkspaceStore } from "../../workspace/task-workspaces.js";
import { makeResult, type ToolContext } from "../../types.js";
import { type MassUlwPlan } from "../../orchestration/mass-ulw.js";
import { createMassUlwExecutionIdentity } from "../mass-ulw-identity.js";
import { cleanupReconciledMassUlwTerminal, updateMassUlwLifecycle } from "../mass-ulw-lifecycle.js";
import { redact } from "../../policy/secrets.js";
import { sendJkPushOnce } from "../../notifications/ntfy.js";
import { autoSelectRoleForTask, buildActiveRoleContext, type RoleTaskMode } from "../../roles/roles.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTaskSafetyGate, inferTaskExecutionKind, mergeTaskSafety } from "../task-safety.js";
import { goalLoopCheckpointEvents, impulseScoutEnabled, recordImpulseCheckpoint } from "../../orchestration/impulse-checkpoint.js";
import { directorNextActions, directorTaskIdFromLabel, readDirectorLoopView, syncDirectorTasks, undecidedP0Notice, type DirectorLoopView } from "../../orchestration/impulse-director.js";
import { prepareLoopImpulseDelta } from "../../orchestration/impulse-delivery.js";
import { planSemanticReview, semanticReviewNextAction } from "../../orchestration/impulse-semantic.js";
import type { ImpulseEvent } from "../../state/agent-bridge-store.js";
import { type TaskState, loadSession, createWorkSessionId, WorkSessionIdSchema, getWorkContext, findLoopContinuation, findLoopContextById, buildAhaMoments, cleanTaskText, recordTaskProgress, reconcileLoopProjection, resolveOrThrow, isRemoteProject, LOCAL_STATE_ANNOTATIONS, chatGptToolMeta, takeTaskContinuationNotice, withErrorMapping, goalIdFor, loopIdFor, type NativeExecutionProfile, type NativeCoordinationMode, readGoalLoopTelemetrySummary, recordGoalLoopTelemetry, inferCoordinationMode, recommendedLeasePreset, buildNativeOrchestration, writeGoalIntake, GoalLoopResumeError, writeGoalLoop } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerGoalTools(registerTool: RegisterTool, ctx: ToolContext): void {

  registerTool(
    "goal_intake",
    {
      title: "Start a broad coding goal",
      description:
        "Call this immediately when the user gives a /goal, deep research, vague large task, or says to proceed quickly. It records the goal and returns the next concrete tool calls within seconds, avoiding ChatGPT's ~30s silent action timeout.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Starting local goal...", "Local goal started"),
      inputSchema: {
        goal: z.string().min(1),
        projectId: z.string().optional(),
        workSessionId: WorkSessionIdSchema.optional(),
        mode: z.enum(["implement", "research", "debug", "review", "plan"]).optional(),
        urgency: z.enum(["normal", "fast"]).optional(),
        coordinationMode: z.enum(["standard", "dispatcher"]).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "goal_intake", { ...input, goal: "[goal redacted]" }, async () => {
        const goal = input.goal.trim();
        const effectiveMode: RoleTaskMode = input.mode ?? "implement";
        const workspaceSessionId = input.projectId && isTaskWorkspaceId(input.projectId)
          ? (await new TaskWorkspaceStore(ctx.stateDir).load(input.projectId)).workSessionId : undefined;
        const workSessionId = input.projectId ? (input.workSessionId ?? workspaceSessionId ?? createWorkSessionId()) : undefined;
        const goalId = await writeGoalIntake(ctx, {
          goalId: goalIdFor(goal),
          goalPreview: redact(goal).slice(0, 1000),
          projectId: input.projectId,
          workSessionId,
          mode: effectiveMode,
          urgency: input.urgency ?? "normal",
          createdAt: new Date().toISOString(),
        });
        const loopId = loopIdFor(`${goalId}:${workSessionId ?? "unscoped"}`);
        const taskState = input.projectId
          ? await recordTaskProgress(ctx, input.projectId, workSessionId, {
              goalId,
              loopId,
              currentGoal: goal,
            }, false)
          : undefined;
        if (taskState) { taskState.loopRevision = 1; taskState.lifecycle = "active"; }
        const coordinationTelemetry = input.coordinationMode ? undefined : await readGoalLoopTelemetrySummary(ctx.stateDir);
        const orchestration = buildNativeOrchestration({
          goal,
          mode: effectiveMode,
          turn: 1,
          coordinationMode: input.coordinationMode,
          coordinationTelemetry,
        });
        const effectiveCoordinationMode = orchestration.coordination.mode;
        await new Store(ctx.stateDir).lockedGoalLoop(loopId, async () => {
          await writeGoalLoop(ctx, loopId, { schemaVersion: 1, revision: 1, lifecycle: "active", taskState,
            owner: { projectId: input.projectId ?? null, workSessionId: workSessionId ?? null, goalId, loopId },
            loopId, goal: cleanTaskText(goal, 12000), goalPreview: redact(goal).slice(0, 1000),
            projectId: input.projectId, workSessionId, mode: effectiveMode, coordinationMode: effectiveCoordinationMode, maxTurns: 12, turns: [] });
          if (taskState && input.projectId) await reconcileLoopProjection(ctx, input.projectId, workSessionId, taskState);
        });
        if (input.projectId) {
          await recordImpulseCheckpoint({ stateDir: ctx.stateDir, projectId: input.projectId, events: [{
            type: "goal_started", source: "goal_intake", goalId, loopId, workSessionId: workSessionId ?? null,
            summary: `Goal started (${effectiveMode}): ${redact(goal).slice(0, 300)}`, dedupeKey: `goal_intake:${loopId}`,
          }] });
        }
        const currentSession = await loadSession(ctx);
        const roleProjectId = input.projectId ?? currentSession.activeProjectId;
        if (roleProjectId) await autoSelectRoleForTask(ctx, roleProjectId, { mode: effectiveMode, goal });
        const activeRoleContext = roleProjectId ? await buildActiveRoleContext(ctx, roleProjectId) : null;
        const leasePreset = recommendedLeasePreset(effectiveMode, activeRoleContext?.rolePermission);
        const ahaMoments = input.projectId
          ? await buildAhaMoments(ctx, input.projectId, goal, workSessionId)
          : [];
        const nextActions = input.projectId
          ? [
              `Call project_select with projectId=${input.projectId}, workSessionId=${workSessionId}, preset=${leasePreset}, reason=goal ${goalId}.`,
              "Call project_rules and project_status.",
              ...(effectiveCoordinationMode === "dispatcher"
                ? ["Dispatcher mode: keep the main reasoning surface thin. Use narrow context, avoid raw logs, and summarize each inspect/edit/verify batch using orchestration.coordination.workerResultContract."]
                : []),
              `Use the ${orchestration.primaryStage} workflow stage first. Call code_search for the first implementation slice, then file_read_slice with workSessionId=${workSessionId} on the matching files.`,
              "Apply small patches and verify each slice; keep every tool call under roughly 20 seconds.",
              `Continue this exact task with goal_loop loopId=${loopId}, projectId=${input.projectId}, workSessionId=${workSessionId}; do not create a replacement loop.`,
            ]
          : [
              "Call workspace_list_projects or workspace_refresh_index now.",
              "Select the best matching project with project_select preset=full-write.",
              "Call project_rules and project_status.",
              "Break the goal into small tool calls; do not wait in a long thinking-only turn.",
            ];
        return makeResult(
          {
            goalId,
            loopId,
            workSessionId,
            taskState,
            ahaMoments,
            orchestration,
            activeRoleContext,
            recommendedLeasePreset: leasePreset,
            nextActions,
            timeoutGuidance:
              "This tool is intentionally fast. Continue with short inspect/edit/verify tool calls instead of one long action or a silent 30s thinking turn.",
          },
          `Goal ${goalId} recorded. Continue with the next jk tool call now.`,
        );
      });
    },
  );

  registerTool(
    "goal_loop",
    {
      title: "Run local coding loop",
      description:
        "Use for Codex-style autonomous coding through ChatGPT when Codex quota is unavailable. It records/continues a local loop and returns the next concrete inspect/edit/verify batch quickly. Call it again with lastResult after each batch until done or blocked.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Continuing local coding loop...", "Local coding loop ready"),
      inputSchema: {
        goal: z.string().min(1).optional(),
        loopId: z.string().min(1).optional(),
        acknowledgeResult: z.object({ jobId: z.string().min(1), resultRevision: z.string().min(1), deliveryToken: z.string().min(1) }).strict().optional(),
        completionEvidence: z.object({ kind: z.literal("contract-result"), artifacts: z.array(z.string().trim().min(1).max(2000)).min(1).max(30) }).strict().optional(),
        newLoop: z.boolean().optional(),
        projectId: z.string().optional(),
        workSessionId: WorkSessionIdSchema.optional(),
        mode: z.enum(["implement", "research", "debug", "review", "plan"]).optional(),
        executionProfile: z.enum(["auto", "fast", "max"]).optional(),
        coordinationMode: z.enum(["standard", "dispatcher"]).optional(),
        maxTurns: z.number().int().min(1).max(50).optional(),
        lastResult: z.string().optional(),
        phase: z.enum(["discover", "plan", "patch", "verify", "review", "recovery", "release"]).optional(),
        verificationStatus: z.enum(["unknown", "pass", "fail", "blocked"]).optional(),
        reviewVerdict: z.enum(["missing", "approve", "reject"]).optional(),
        failureCount: z.number().int().min(0).max(20).optional(),
        currentTask: z.string().max(500).optional(),
        completed: z.array(z.string().min(1).max(500)).max(50).optional(),
        pending: z.array(z.string().min(1).max(500)).max(50).optional(),
        safety: z.object({
          executionKind: z.enum(["workspace", "live-runtime", "release-deploy"]).optional(),
          preflightStatus: z.enum(["unknown", "pass", "fail", "not-required"]).optional(),
          preflightEvidence: z.array(z.string().min(1).max(2000)).max(30).optional(),
          executionTarget: z.object({
            machine: z.string().min(1).max(200),
            projectRoot: z.string().min(1).max(1000),
            branch: z.string().min(1).max(200),
            dirty: z.boolean(),
            runtimeTarget: z.string().min(1).max(500),
          }).optional(),
          approvalPlan: z.array(z.string().min(1).max(2000)).max(20).optional(),
          rollbackStatus: z.enum(["unknown", "pass", "fail", "not-required"]).optional(),
          releaseCollisionStatus: z.enum(["unknown", "pass", "fail", "not-required"]).optional(),
          runtimeProofStatus: z.enum(["unknown", "pass", "fail", "not-required"]).optional(),
          runtimeProofEvidence: z.array(z.string().min(1).max(2000)).max(30).optional(),
          operationalDrift: z.array(z.string().min(1).max(2000)).max(30).optional(),
        }).optional(),
        fanoutCandidates: z
          .array(
            z.object({
              id: z.string().min(1).max(80),
              task: z.string().min(1).max(500),
              estimatedWeight: z.number().int().min(1).max(5).optional(),
              readScopes: z.array(z.string().min(1).max(300)).max(20).optional(),
              writeScopes: z.array(z.string().min(1).max(300)).max(20).optional(),
              dependsOn: z.array(z.string().min(1).max(80)).max(10).optional(),
              exclusiveResources: z.array(z.string().min(1).max(120)).max(10).optional(),
              latencyBound: z.boolean().optional(),
            }),
          )
          .max(4)
          .optional(),
        decisions: z
          .array(
            z.object({
              summary: z.string().min(1).max(500),
              rationale: z.string().max(1000).optional(),
            }),
          )
          .max(10)
          .optional(),
      },
    },
    async (input) => {
      const telemetryStartedAt = Date.now();
      return withErrorMapping<Record<string, unknown>>(ctx, "goal_loop", { ...input, goal: input.goal ? "[goal redacted]" : undefined }, async () => {
        const currentSessionBeforeLoop = await loadSession(ctx);
        const resolvedProjectId = input.projectId ?? currentSessionBeforeLoop.activeProjectId ?? undefined;
        let continuation = !input.newLoop && resolvedProjectId
          ? input.loopId
            ? findLoopContextById(currentSessionBeforeLoop, resolvedProjectId, input.loopId.trim(), input.workSessionId)
            : findLoopContinuation(currentSessionBeforeLoop, resolvedProjectId, {
                workSessionId: input.workSessionId,
                goalHint: input.goal,
              })
          : null;
        const continuationLoopId = continuation?.context.taskState?.loopId ?? undefined;
        let effectiveGoal = input.goal ?? continuation?.context.taskState?.currentGoal ?? undefined;
        if (!input.loopId && !continuationLoopId && !effectiveGoal) {
          return makeResult(
            {
              continueRequired: false,
              needsGoalOrLoopId: true,
              projectId: resolvedProjectId ?? null,
              workSessionId: input.workSessionId ?? null,
              instruction: "No active coding loop was found. Call goal_intake for a new task, or pass an explicit loopId. goal_loop will not silently create a generic replacement loop.",
            },
            "No active coding loop found; no new loop was created.",
          );
        }
        const loopId = input.loopId?.trim() || continuationLoopId || loopIdFor(effectiveGoal!);
        const ahaMoments = resolvedProjectId && effectiveGoal && !continuationLoopId
          ? await buildAhaMoments(ctx, resolvedProjectId, effectiveGoal, input.workSessionId)
          : [];
        return new Store(ctx.stateDir).lockedGoalLoop(loopId, async () => {
        if (resolvedProjectId && !input.newLoop) continuation = findLoopContextById(await loadSession(ctx), resolvedProjectId, loopId, input.workSessionId);
        let maxTurns = input.maxTurns ?? 12;
        const loopFile = path.join(ctx.stateDir, "goals", `${loopId}.loop.json`);
        let previousTurns = 0;
        let existingTurns: Array<Record<string, unknown>> = [];
        let existingWorkSessionId: string | undefined;
        let existingMode: RoleTaskMode | undefined;
        let existingExecutionProfile: NativeExecutionProfile | undefined;
        let existingCoordinationMode: NativeCoordinationMode | undefined;
        let existingGoalPreview: string | undefined;
        let checkpointTask: TaskState | undefined;
        let revision = 0;
        let terminalResult: Record<string, unknown> | undefined;
        let requiresCodeProof = false;
        try {
          const existing = z.object({
            loopId: z.literal(loopId),
            projectId: z.literal(resolvedProjectId).optional(),
            workSessionId: WorkSessionIdSchema.optional(),
            turns: z.array(z.record(z.unknown())),
            totalTurns: z.number().int().nonnegative().optional(),
            requiresCodeProof: z.boolean().optional(),
            mode: z.enum(["implement", "research", "debug", "review", "plan"]).optional(),
            executionProfile: z.enum(["auto", "fast", "max"]).optional(),
            coordinationMode: z.enum(["standard", "dispatcher"]).optional(),
            goalPreview: z.string().optional(),
            maxTurns: z.number().int().min(1).max(50).optional(),
            schemaVersion: z.literal(1).optional(),
            owner: z.object({ projectId: z.string().nullable(), workSessionId: WorkSessionIdSchema.nullable(), goalId: z.string().nullable(), loopId: z.string() }).optional(),
            revision: z.number().int().positive().optional(),
            taskState: TaskStateSchema.optional(),
            goal: z.string().max(12000).optional(),
            lifecycle: z.enum(["active", "yielded", "reasoning-needed", "blocked", "succeeded"]).optional(),
            terminalResult: z.object({ terminal: z.literal(true), terminalStatus: z.literal("succeeded"), loopId: z.literal(loopId),
              projectId: z.literal(resolvedProjectId ?? null), workSessionId: WorkSessionIdSchema.nullable(),
              completionEvidence: z.object({ kind: z.literal("contract-result"), artifacts: z.array(z.string().min(1).max(2000)).min(1).max(30) }),
            }).passthrough().optional(),
          }).parse(JSON.parse(await fs.readFile(loopFile, "utf8")));
          if (existing.schemaVersion && (!existing.revision || (existing.projectId && (!existing.taskState || existing.taskState.loopId !== loopId ||
              existing.taskState.loopRevision !== existing.revision)) || (existing.lifecycle === "succeeded") !== Boolean(existing.terminalResult))) {
            throw new GoalLoopResumeError(loopId, "Invalid authoritative loop checkpoint");
          }
          if (existing.schemaVersion && (!existing.owner || existing.owner.projectId !== (existing.projectId ?? null) ||
              existing.owner.workSessionId !== (existing.workSessionId ?? null) || existing.owner.loopId !== loopId ||
              (existing.taskState && existing.owner.goalId !== existing.taskState.goalId))) {
            throw new GoalLoopResumeError(loopId, "Authoritative checkpoint owner mismatch");
          }
          checkpointTask = existing.taskState;
          revision = existing.revision ?? 0;
          terminalResult = existing.terminalResult;
          requiresCodeProof = existing.requiresCodeProof ?? (existing.mode === "implement" || existing.mode === "debug");
          maxTurns = input.maxTurns ?? existing.maxTurns ?? 12;
          effectiveGoal = input.goal ?? existing.goal ?? checkpointTask?.currentGoal ?? effectiveGoal;
          existingTurns = existing.turns;
          existingWorkSessionId = existing.workSessionId;
          existingGoalPreview = existing.goalPreview?.trim() || undefined;
          existingMode = existing.mode;
          existingExecutionProfile = existing.executionProfile;
          existingCoordinationMode = existing.coordinationMode;
          previousTurns = existing.totalTurns ?? existingTurns.length;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw new GoalLoopResumeError(loopId,
              `Cannot resume persisted loop: ${error instanceof Error ? error.message : String(error)}`, error);
          }
        }
        effectiveGoal ??= existingGoalPreview;
        const turn = previousTurns + 1;
        const remainingTurns = Math.max(0, maxTurns - turn);
        const workspaceSessionId = resolvedProjectId && isTaskWorkspaceId(resolvedProjectId)
          ? (await new TaskWorkspaceStore(ctx.stateDir).load(resolvedProjectId)).workSessionId : undefined;
        const workSessionId =
          input.workSessionId ??
          workspaceSessionId ??
          continuation?.workSessionId ??
          existingWorkSessionId ??
          (resolvedProjectId && previousTurns === 0 ? createWorkSessionId() : undefined);
        if (existingWorkSessionId !== undefined && existingWorkSessionId !== workSessionId) {
          throw new GoalLoopResumeError(loopId, "Persisted loop workSessionId does not match the requested owner");
        }
        if (terminalResult && terminalResult.workSessionId !== (workSessionId ?? null)) throw new GoalLoopResumeError(loopId, "Terminal result owner mismatch");
        // Validate a currently linked job before repairing any older progress projection.
        if (resolvedProjectId) await takeTaskContinuationNotice(ctx, { projectId: resolvedProjectId, loopId, workSessionId }, false);
        let projectionRecoveredBeforeTurn = false;
        if (checkpointTask && resolvedProjectId) {
          projectionRecoveredBeforeTurn = await reconcileLoopProjection(ctx, resolvedProjectId, workSessionId, checkpointTask);
          continuation = findLoopContextById(await loadSession(ctx), resolvedProjectId, loopId, workSessionId);
        }
        if (input.acknowledgeResult || !terminalResult) await takeTaskContinuationNotice(ctx, { projectId: resolvedProjectId, loopId, workSessionId,
          goalId: checkpointTask?.goalId ?? continuation?.context.taskState.goalId, acknowledgeResult: input.acknowledgeResult }, true);
        if (terminalResult) return makeResult(terminalResult, "Completed goal checkpoint resumed without new work.");
        if (input.acknowledgeResult && Object.entries(input).every(([key, value]) => value === undefined ||
            ["projectId", "loopId", "workSessionId", "acknowledgeResult"].includes(key))) {
          const taskState = resolvedProjectId ? getWorkContext(await loadSession(ctx), resolvedProjectId, workSessionId)?.taskState : undefined;
          return makeResult({ projectId: resolvedProjectId ?? null, loopId, workSessionId: workSessionId ?? null,
            taskState, acknowledgedResult: input.acknowledgeResult, turn: previousTurns, maxTurns,
            remainingTurns: Math.max(0, maxTurns - previousTurns), lifecycle: taskState?.lifecycle ?? "reasoning-needed",
            terminal: false, terminalStatus: null, continueRequired: true, continuationReason: "result-acknowledged",
            nextCall: { toolName: "goal_loop", input: { projectId: resolvedProjectId, loopId, workSessionId } },
          }, "Owned job result acknowledged without advancing the goal loop.");
        }
        const continuationTaskStateBeforeTurn = continuation?.context.taskState;
        const effectiveMode: RoleTaskMode = input.mode ?? existingMode ?? "implement";
        const effectiveExecutionProfile: NativeExecutionProfile = input.executionProfile ?? existingExecutionProfile ?? "auto";
        const previousTurn = existingTurns.at(-1);
        const previousFailureCount =
          typeof previousTurn?.failureCount === "number" && Number.isFinite(previousTurn.failureCount)
            ? Math.max(0, Math.floor(previousTurn.failureCount))
            : 0;
        const effectiveFailureCount =
          input.failureCount ??
          (input.verificationStatus === "pass"
            ? 0
            : input.verificationStatus === "fail" || input.verificationStatus === "blocked"
              ? Math.min(20, previousFailureCount + 1)
              : previousFailureCount);
        const effectiveCurrentTask = input.currentTask ?? continuation?.context.taskState?.currentTask ?? undefined;
        const inferredExecutionKind = inferTaskExecutionKind(`${effectiveGoal ?? ""}\n${effectiveCurrentTask ?? ""}`);
        const effectiveSafety = mergeTaskSafety(
          continuation?.context.taskState?.executionSafety,
          input.safety,
          inferredExecutionKind,
        );
        const safetyGate = buildTaskSafetyGate(effectiveSafety);
        const basePending = input.pending ?? continuation?.context.taskState?.pending ?? [];
        // Impulse Director V2: approved Director tasks for this loop are forced into
        // pending until the caller moves their exact label into completed.
        let directorView: DirectorLoopView | null = null;
        if (resolvedProjectId && impulseScoutEnabled()) {
          try { directorView = await readDirectorLoopView(ctx.stateDir, resolvedProjectId, loopId); } catch { directorView = null; }
        }
        const directorCompletedIds = new Set((input.completed ?? [])
          .map(directorTaskIdFromLabel).filter((id): id is string => Boolean(id))
          .filter((id) => directorView?.openTasks.some((task) => task.taskId === id)));
        const directorOpenTasks = (directorView?.openTasks ?? []).filter((task) => !directorCompletedIds.has(task.taskId));
        const effectivePending = [
          ...basePending.filter((item) => { const id = directorTaskIdFromLabel(item); return !id || !directorCompletedIds.has(id); }),
          ...directorOpenTasks.map((task) => task.label),
          ...effectiveSafety.operationalDrift.map((item) => `Operational drift: ${item}`),
        ].filter((item, index, values) => values.indexOf(item) === index);
        const directorActions = directorView
          ? directorNextActions({ ...directorView, openTasks: directorOpenTasks })
          : [];
        const coordinationTelemetry = input.coordinationMode || existingCoordinationMode
          ? undefined
          : await readGoalLoopTelemetrySummary(ctx.stateDir);
        const effectiveCoordinationMode = inferCoordinationMode({
          requested: input.coordinationMode,
          existing: existingCoordinationMode,
          goal: effectiveGoal,
          currentTask: effectiveCurrentTask,
          pending: effectivePending,
          mode: effectiveMode,
          phase: input.phase,
          verificationStatus: input.verificationStatus,
          turn,
          telemetry: coordinationTelemetry,
        });
        const orchestration = buildNativeOrchestration({
          goal: effectiveGoal,
          currentTask: effectiveCurrentTask,
          pending: effectivePending,
          mode: effectiveMode,
          phase: input.phase,
          verificationStatus: input.verificationStatus,
          reviewVerdict: input.reviewVerdict,
          failureCount: effectiveFailureCount,
          turn,
          executionProfile: effectiveExecutionProfile,
          coordinationMode: effectiveCoordinationMode,
          coordinationTelemetry,
          fanoutCandidates: input.fanoutCandidates,
        });
        const candidateMassUlw =
          orchestration.massUlw.state === "fanout" && orchestration.massUlw.recommended
            ? orchestration.massUlw as MassUlwPlan
            : null;
        const roleProjectId = resolvedProjectId ?? currentSessionBeforeLoop.activeProjectId;
        if (roleProjectId) await autoSelectRoleForTask(ctx, roleProjectId, { mode: effectiveMode, goal: effectiveGoal });
        const activeRoleContext = roleProjectId ? await buildActiveRoleContext(ctx, roleProjectId) : null;
        const leasePreset = recommendedLeasePreset(effectiveMode, activeRoleContext?.rolePermission);
        const massUlwLifecycle = resolvedProjectId
          ? await (async () => {
              const massEntry = await resolveOrThrow(ctx, { projectId: resolvedProjectId });
              // MASS ULW execution is intentionally local-only. Do not try to
              // canonicalize a remote executor path (for example C:\\JK\\...)
              // on the OCI control plane; doing so breaks goal_loop before the
              // remote task can even start.
              if (isRemoteProject(massEntry)) return null;
              return updateMassUlwLifecycle({
                stateDir: ctx.stateDir,
                identity: await createMassUlwExecutionIdentity({
                  projectId: resolvedProjectId,
                  repositoryRoot: massEntry.root,
                  externalLoopId: loopId,
                }),
                candidatePlan: candidateMassUlw,
                explicitFanoutDecision: input.fanoutCandidates !== undefined,
                writeEnabled: leasePreset === "full-write",
              });
            })()
          : null;
        const executableMassUlw = massUlwLifecycle?.state === "approved" ? candidateMassUlw : null;
        const safetyNextActions = effectiveSafety.executionKind === "workspace"
          ? []
          : !safetyGate.approvalReady
            ? [
                `Safety preflight is incomplete (${safetyGate.approvalBlockers.join(", ")}). Run read-only preflight and record safety evidence before requesting any approval or executing a release/runtime mutation.`,
                "Record the exact execution target: machine, absolute project root, branch, dirty state, and runtime target.",
                "Predeclare the full risky command chain in safety.approvalPlan; release/deploy work must also prove immutable-version collision status and rollback readiness before approval.",
              ]
            : !safetyGate.terminalReady
              ? [
                  `Safety completion proof is incomplete (${safetyGate.terminalBlockers.join(", ")}). Do not declare the goal done.`,
                  "After the live change, prove runtime identity/behavior (PID or start-time/runtime marker plus endpoint or behavior verification) and record it in safety.runtimeProofEvidence.",
                  "Resolve operational drift or keep it explicitly pending; warnings such as NeedDaemonReload must not be silently ignored.",
                ]
              : [];
        const reviewNextActions =
          input.phase === "release" && input.verificationStatus === "pass" && Array.isArray(input.pending) && input.pending.length === 0
            ? input.reviewVerdict === "approve"
              ? []
              : input.reviewVerdict === "reject"
                ? ["Final review rejected the current result. Resolve the review findings, re-run verification, then request a fresh final review verdict; do not terminate this loop yet."]
                : ["Verification passed, but final review is still missing. Run a reviewer pass for regression/security/goal-fit and call goal_loop again with reviewVerdict=approve or reviewVerdict=reject before terminal completion."]
            : [];
        const nextActions = resolvedProjectId
          ? [
              ...safetyNextActions,
              ...reviewNextActions,
              ...directorActions,
              `Call project_select with projectId=${resolvedProjectId}${workSessionId ? `, workSessionId=${workSessionId}` : ""}, preset=${leasePreset}, reason=loop ${loopId} turn ${turn}.`,
              `Operate in JK-native ${orchestration.phase} phase with ${orchestration.primaryStage} as the primary workflow stage and ${orchestration.supportingStages.join(", ")} as supporting stages.`,
              `Execution profile: requested=${orchestration.executionProfile.requested}, effective=${orchestration.executionProfile.effective}. ${orchestration.executionProfile.rationale}`,
              ...(effectiveCoordinationMode === "dispatcher"
                ? ["Dispatcher mode is active: the main host should route, decide, and summarize; keep repository reads narrow, do not paste raw command output into the loop, and compress worker/batch results to the declared workerResultContract."]
                : []),
              "Treat the persisted goal contract as the parent objective. The latest user instruction refines or advances it unless the user explicitly replaces the goal.",
              "Honor recorded decisions and settled constraints; do not ask the user to re-decide them unless new evidence creates a real conflict or a security/approval gate requires it.",
              orchestration.massUlw.state === "evaluate"
                ? "Mass ULW evaluation is warranted: identify 2-4 independently verifiable lanes, declare read/write scopes, dependencies, exclusive resources, and estimatedWeight (1-5), then call goal_loop with fanoutCandidates before broad patching."
                : executableMassUlw
                  ? isTaskWorkspaceId(resolvedProjectId)
                    ? `Mass ULW plan ${executableMassUlw.planFingerprint} approved with waves ${JSON.stringify(executableMassUlw.waves)}. Call command_list, then mass_ulw_step action=start with projectId=${resolvedProjectId}, loopId=${loopId}, workSessionId=${workSessionId}, planFingerprint=${executableMassUlw.planFingerprint}, laneVerificationCommandIds and finalVerificationCommandId. Follow its context and nextCall; submit one ready lane or independent ready lanes, repair failures, review, integrate, finish and publish. ChatGPT performs every reasoning/reviewer pass without asking the user to orchestrate tools.`
                    : "For ChatGPT-web MASS ULW, first create a task_workspace from this source project, then call goal_loop with the returned projectId/workSessionId and these fanoutCandidates before mass_ulw_step start. The legacy mass_ulw_execute remains available for an already prepared full patch batch."
                  : orchestration.massUlw.state === "sequential"
                    ? `Mass ULW stays sequential: ${orchestration.massUlw.rationale}`
                    : "Mass ULW is inactive for this turn; use the normal single-lane workflow.",
              orchestration.phase === "recovery"
                ? orchestration.recoveryPolicy
                : "Call project_rules and project_status if they are not already fresh in this chat, then read the smallest relevant context slice.",
              executableMassUlw && isTaskWorkspaceId(resolvedProjectId)
                ? "For this MASS ULW task, submit implementation patches through mass_ulw_step and read its dependency-aware context. The task checkout remains frozen until finish; ordinary file edits belong before start or after the workflow is complete."
                : orchestration.phase === "recovery"
                ? "Do not apply another patch until a new evidence-backed hypothesis is identified. Inspect diff/checkpoint/failing output first."
                : `Apply one coherent patch/create batch${workSessionId ? ` with workSessionId=${workSessionId}` : ""}, then run the closest verification command.`,
              `Call goal_loop again with loopId=${loopId}, projectId=${resolvedProjectId}${workSessionId ? `, workSessionId=${workSessionId}` : ""}, maxTurns=${maxTurns}, and lastResult summarizing the batch; include phase/verificationStatus/failureCount plus currentTask/completed/pending/decisions when they changed.`,
            ]
          : [
              "Call workspace_list_projects or workspace_refresh_index now.",
              "Select the best matching project with project_select preset=full-write.",
              "Call project_rules and project_status.",
              `Call goal_loop again with loopId=${loopId}, the selected projectId, maxTurns=${maxTurns}, and lastResult='project selected'.`,
            ];
        const doneRule =
          "Stop only when the requested work is implemented and verified, a real blocker is proven, or a security/approval gate is hit.";
        const terminalRequested = input.phase === "release" && input.verificationStatus === "pass" && Array.isArray(input.pending) && input.pending.length === 0;
        const pendingWasExplicitlyCleared = Array.isArray(input.pending) && input.pending.length === 0 && effectivePending.length === 0;
        const terminalCandidate = terminalRequested && pendingWasExplicitlyCleared && input.reviewVerdict === "approve";
        const sourceDeliveryTask = Boolean(resolvedProjectId && isTaskWorkspaceId(resolvedProjectId));
        let publicationNextCall: { toolName: string; input: Record<string, unknown>; needs?: string[] } | undefined;
        if (sourceDeliveryTask && resolvedProjectId) {
          publicationNextCall = { toolName: "task_workspace", input: { action: "status", projectId: resolvedProjectId, workSessionId } };
          if (terminalCandidate) {
            const verified = await new TaskWorkspaceStore(ctx.stateDir).assertVerified(resolvedProjectId);
            publicationNextCall = { toolName: "task_workspace", input: { action: "publish", projectId: resolvedProjectId,
              workSessionId, verificationId: verified.verification?.id }, needs: ["reviewSummary"] };
          }
          nextActions.unshift(
            "Source delivery is not complete until task_workspace publish records status=published. Inspect status; discover and run a fresh verify command if needed, review the exact diff, then publish with that verificationId and your reviewSummary.",
            "If source drift blocks publication, preserve source and task edits and use a new task from the current baseline, not a blind retry. After publication acknowledge this existing loop/session with release/pass/approve and pending=[], without progress changes.",
          );
        }
        // Direct-source execution has no authenticated checkout/manifest receipt.
        // Coding must use the existing task_workspace observer, never caller pass flags.
        const codingMode = requiresCodeProof || effectiveMode === "implement" || effectiveMode === "debug" || Boolean(continuation?.context.lastMutation);
        const completionEvidence = !codingMode && input.completionEvidence
          ? { ...input.completionEvidence, artifacts: input.completionEvidence.artifacts.map(redact) } : null;
        const evidenceRequired = !sourceDeliveryTask && terminalCandidate && !completionEvidence;
        if (evidenceRequired && resolvedProjectId) publicationNextCall = codingMode
          ? { toolName: "task_workspace", input: { action: "create", projectId: resolvedProjectId, workSessionId, goal: effectiveGoal } }
          : { toolName: "goal_loop", input: { projectId: resolvedProjectId, workSessionId, loopId }, needs: ["completionEvidence.kind=contract-result", "completionEvidence.artifacts"] };
        const terminalSuccess = !sourceDeliveryTask && terminalCandidate && safetyGate.terminalReady && Boolean(completionEvidence);
        const terminalFailure = !sourceDeliveryTask && input.verificationStatus === "blocked";
        const terminal = terminalSuccess;
        const lifecycle = terminalSuccess ? "succeeded" : terminalFailure ? "blocked" : remainingTurns === 0 ? "yielded" : "reasoning-needed";
        const continuationReason = terminalSuccess ? null : evidenceRequired ? "evidence-required" : terminalFailure ? "blocked" : remainingTurns === 0 ? "turn-budget" : "host-reasoning-needed";
        if (terminalSuccess && massUlwLifecycle?.executable) {
          await cleanupReconciledMassUlwTerminal({
            stateDir: ctx.stateDir,
            executionId: massUlwLifecycle.executionId,
            projectId: resolvedProjectId!,
            externalLoopId: loopId,
          });
        }
        const payload = {
          schemaVersion: 1,
          owner: { projectId: resolvedProjectId ?? null, workSessionId: workSessionId ?? null,
            goalId: continuation ? continuation.context.taskState.goalId : loopId, loopId },
          revision: revision + 1,
          totalTurns: turn,
          requiresCodeProof: codingMode,
          lifecycle,
          completionEvidence,
          goal: effectiveGoal ? cleanTaskText(effectiveGoal, 12000) ?? undefined : undefined,
          loopId,
          goalPreview: effectiveGoal ? redact(effectiveGoal).slice(0, 1000) : undefined,
          projectId: resolvedProjectId,
          workSessionId,
          mode: effectiveMode,
          executionProfile: effectiveExecutionProfile,
          coordinationMode: effectiveCoordinationMode,
          maxTurns,
          turns: [
            ...existingTurns.slice(-49),
            {
              turn,
              at: new Date().toISOString(),
              lastResult: input.lastResult ? redact(input.lastResult).slice(0, 1000) : undefined,
              currentTask: input.currentTask ? redact(input.currentTask).slice(0, 500) : undefined,
              phase: input.phase,
              verificationStatus: input.verificationStatus,
              reviewVerdict: input.reviewVerdict ?? "missing",
              failureCount: effectiveFailureCount,
              executionProfile: orchestration.executionProfile,
              coordinationMode: effectiveCoordinationMode,
              completed: input.completed?.map((item) => redact(item).slice(0, 500)),
              pending: effectivePending.map((item) => redact(item).slice(0, 500)),
              safety: effectiveSafety,
              safetyGate,
              decisions: input.decisions?.map((decision) => ({
                summary: redact(decision.summary).slice(0, 500),
                rationale: decision.rationale ? redact(decision.rationale).slice(0, 1000) : undefined,
              })),
              orchestration,
              nextActions,
            },
          ],
        };
        const taskState = resolvedProjectId
          ? await recordTaskProgress(ctx, resolvedProjectId, workSessionId, {
              goalId: continuation ? continuation.context.taskState.goalId ?? undefined : loopId,
              loopId,
              ...(effectiveGoal ? { currentGoal: effectiveGoal } : {}),
              ...(input.currentTask !== undefined ? { currentTask: input.currentTask } : {}),
              ...(input.lastResult !== undefined ? { lastProgressSummary: input.lastResult } : {}),
              ...(input.completed !== undefined ? { completed: input.completed } : {}),
              pending: effectivePending,
              ...(input.decisions !== undefined ? { decisions: input.decisions } : {}),
              executionSafety: effectiveSafety,
              inferredExecutionKind,
            }, false)
          : undefined;
        if (taskState) { taskState.loopRevision = revision + 1; taskState.lifecycle = lifecycle; }
        // Commit authority first. A failed projection is repaired from this exact revision.
        const committed = { ...payload, taskState, terminalResult: terminalSuccess ? {
          loopId, projectId: resolvedProjectId ?? null, workSessionId: workSessionId ?? null,
          turn, remainingTurns, maxTurns, lifecycle, continuationReason, completionEvidence,
          terminal: true, terminalStatus: "succeeded", continueRequired: false, taskState,
          terminalPushResult: null, nextActions: [], safety: effectiveSafety, safetyGate,
        } : undefined };
        await writeGoalLoop(ctx, loopId, committed);
        if (taskState && resolvedProjectId) {
          await reconcileLoopProjection(ctx, resolvedProjectId, workSessionId, taskState, {
            clearContinuation: terminalSuccess,
          });
        }
        // Impulse Scout V1 checkpoint hook: advisory, JK-private state only, never throws.
        const priorTaskState = checkpointTask ?? continuationTaskStateBeforeTurn;
        const recordedImpulseEvents: ImpulseEvent[] = [];
        if (resolvedProjectId) {
          await recordImpulseCheckpoint({
              stateDir: ctx.stateDir,
              projectId: resolvedProjectId,
              recorded: recordedImpulseEvents,
              events: goalLoopCheckpointEvents({
                loopId,
                goalId: taskState?.goalId ?? payload.owner.goalId ?? null,
                workSessionId: workSessionId ?? null,
                revision: revision + 1,
                phase: input.phase,
                previousPhase: typeof previousTurn?.phase === "string" ? previousTurn.phase : undefined,
                verificationStatus: input.verificationStatus,
                failureCount: effectiveFailureCount,
                lastResult: input.lastResult ? redact(input.lastResult).slice(0, 1000) : undefined,
                currentTask: input.currentTask ? redact(input.currentTask).slice(0, 500) : undefined,
                completed: input.completed,
                previousCompleted: priorTaskState?.completed ?? [],
                pending: input.pending !== undefined ? effectivePending : undefined,
                previousPending: priorTaskState?.pending ?? [],
              }),
            });
        }
        if (resolvedProjectId && directorView) {
          await syncDirectorTasks({
            stateDir: ctx.stateDir,
            projectId: resolvedProjectId,
            loopRevision: revision + 1,
            injectedTaskIds: directorOpenTasks.map((task) => task.taskId),
            completedTaskIds: [...directorCompletedIds],
          }).catch(() => undefined);
        }
        // Delta delivery: report Impulse/Director state only when it changed since the last
        // delivered goal_loop response for this loop. Approved-task pending/nextActions above
        // are unaffected; they are part of the loop contract, not the delta.
        const impulseDelivery = resolvedProjectId && directorView
          ? await prepareLoopImpulseDelta(ctx.stateDir, resolvedProjectId, loopId).catch(() => null)
          : null;
        const impulseDelta = impulseDelivery?.delta ?? null;
        const p0Notice = undecidedP0Notice(impulseDelivery?.newUndecidedP0 ?? 0);
        // Semantic Scout (V2.1): at most one compact review request per loop phase,
        // answered by this same reasoning turn. Advisory; never changes the loop contract.
        const semanticReview = resolvedProjectId && directorView && !terminalSuccess && recordedImpulseEvents.length > 0
          ? await planSemanticReview({
              stateDir: ctx.stateDir,
              projectId: resolvedProjectId,
              loopId,
              goal: effectiveGoal ?? null,
              currentTask: effectiveCurrentTask ?? null,
              events: recordedImpulseEvents,
              verificationStatus: input.verificationStatus ?? null,
              pending: effectivePending,
              loadWorkEvidence: async () => {
                const work = getWorkContext(await loadSession(ctx), resolvedProjectId, workSessionId);
                return {
                  changed: (work?.recentFiles ?? []).filter((file) => file.lastAction !== "read").map((file) => file.path),
                  verificationCommand: work?.lastVerification?.command ?? null,
                };
              },
            }).catch(() => null)
          : null;
        const semanticAction = semanticReview ? semanticReviewNextAction(semanticReview) : null;
        const intentContext = taskState
          ? {
              goalContract: taskState.currentGoal,
              currentTask: taskState.currentTask,
              pending: taskState.pending,
              decisions: taskState.decisions,
              executionSafety: taskState.executionSafety,
              safetyGate: buildTaskSafetyGate(taskState.executionSafety),
              instruction:
                "Preserve the goal contract across turns. Interpret the newest instruction inside that goal and recorded decisions unless the user explicitly changes the objective.",
            }
          : {
              goalContract: effectiveGoal ?? null,
              currentTask: effectiveCurrentTask ?? null,
              pending: effectivePending ?? [],
              decisions: [],
              executionSafety: effectiveSafety,
              safetyGate,
              instruction:
                "Preserve the goal contract across turns. Interpret the newest instruction inside that goal unless the user explicitly changes the objective.",
            };
        let terminalPushResult: "delivered" | "duplicate" | "failed" | null = null;
        if (resolvedProjectId && terminalSuccess) {
          terminalPushResult = await sendJkPushOnce(
            ctx.stateDir,
            `goal-loop:${loopId}:success`,
            { kind: "success", projectId: resolvedProjectId, reason: "요청한 작업이 검증까지 완료됐습니다." },
          );
        } else if (resolvedProjectId && terminalFailure) {
          terminalPushResult = await sendJkPushOnce(
            ctx.stateDir,
            `goal-loop:${loopId}:failure`,
            { kind: "failure", projectId: resolvedProjectId, reason: "작업이 최종적으로 차단됐습니다. JK에서 결과를 확인하세요." },
          );
        }
        const responseTaskState = effectiveCoordinationMode === "dispatcher" && taskState && !projectionRecoveredBeforeTurn
          ? {
              loopRevision: taskState.loopRevision,
              lifecycle: taskState.lifecycle,
              currentTask: taskState.currentTask,
              lastProgressSummary: taskState.lastProgressSummary,
              completed: taskState.completed,
              pending: taskState.pending,
              decisions: taskState.decisions,
            }
          : taskState;
        const responseIntentContext = effectiveCoordinationMode === "dispatcher"
          ? {
              goalContract: intentContext.goalContract,
              currentTask: intentContext.currentTask,
              pending: intentContext.pending,
              decisions: intentContext.decisions,
              instruction: intentContext.instruction,
            }
          : intentContext;
        const responseActiveRoleContext = effectiveCoordinationMode === "dispatcher" && activeRoleContext
          ? {
              projectId: activeRoleContext.projectId,
              projectName: activeRoleContext.projectName,
              role: { id: activeRoleContext.role.id, name: activeRoleContext.role.name },
              selectionSource: activeRoleContext.selectionSource,
              effectivePermission: activeRoleContext.effectivePermission,
            }
          : activeRoleContext;
        // One-shot notices (new undecided P0, semantic review request) appear only on the turn they
        // arise, right after the safety/review/Director-task lines, and are not repeated later.
        const oneShotNotices = [p0Notice, semanticAction].filter((line): line is string => Boolean(line));
        const withP0Notice = (actions: string[]): string[] => {
          if (oneShotNotices.length === 0) return actions;
          const anchors = [...safetyNextActions, ...reviewNextActions, ...directorActions];
          const at = Math.max(0, ...anchors.map((line) => actions.indexOf(line) + 1));
          return [...actions.slice(0, at), ...oneShotNotices, ...actions.slice(at)];
        };
        const responseNextActions = effectiveCoordinationMode === "dispatcher" && !terminal
          ? withP0Notice([
              ...safetyNextActions.slice(0, 1),
              ...reviewNextActions.slice(0, 1),
              ...directorActions,
              nextActions.find((action) => action.startsWith("Call project_select")),
              nextActions.find((action) => action.startsWith("Apply one coherent") || action.startsWith("Do not apply another patch")),
              nextActions.find((action) => action.startsWith("Call goal_loop again")),
            ].filter((action): action is string => Boolean(action)).filter((action, index, values) => values.indexOf(action) === index))
          : terminal ? [] : withP0Notice(nextActions);
        if (committed.terminalResult) {
          const result = makeResult(committed.terminalResult, "Goal completed with explicit contract-result evidence; this is not code verification.");
          await recordGoalLoopTelemetry({
            ctx,
            startedAt: telemetryStartedAt,
            coordinationMode: effectiveCoordinationMode,
            turn,
            failureCount: effectiveFailureCount,
            lifecycle,
            response: result,
          });
          return result;
        }
        const responsePayload = {
            loopId,
            projectId: resolvedProjectId ?? null,
            workSessionId: workSessionId ?? null,
            turn,
            remainingTurns,
            maxTurns,
            lifecycle,
            continuationReason,
            completionEvidence,
            reasoningHostAvailable: "current-tool-turn-only",
            continueRequired: !terminal,
            ...(publicationNextCall ? { nextCall: publicationNextCall, terminalBlockedByPublication: true } : {}),
            terminal,
            terminalStatus: terminalSuccess ? "succeeded" : null,
            terminalPushResult,
            terminalBlockedBySafety: terminalRequested && (!pendingWasExplicitlyCleared || !safetyGate.terminalReady),
            terminalBlockedByReview: terminalRequested && input.reviewVerdict !== "approve",
            terminalBlockedByDirector: terminalRequested && directorOpenTasks.length > 0,
            safety: effectiveSafety,
            safetyGate,
            taskState: responseTaskState,
            ahaMoments,
            intentContext: responseIntentContext,
            orchestration,
            massUlwLifecycle,
            activeRoleContext: responseActiveRoleContext,
            recommendedLeasePreset: leasePreset,
            nextActions: responseNextActions,
            ...(impulseDelta ? { impulse: impulseDelta } : {}),
            ...(semanticReview ? { semanticReview } : {}),
            loopRules: [
              "Do one small inspect/edit/verify batch per action round.",
              "Keep each tool call short; avoid silent long thinking turns.",
              ...(effectiveCoordinationMode === "dispatcher"
                ? ["Dispatcher mode: keep the main context compact. Return only status, up to 8 findings, changed-file summaries, verification summary, up to 3 risks, and one next action; omit raw logs unless needed to diagnose a failure."]
                : []),
              orchestration.verificationGate,
              effectiveSafety.executionKind === "workspace"
                ? "Workspace-only work uses the normal verification gate."
                : "Safety Contract: preflight and exact execution-target proof must pass before approvals; runtime proof and zero unresolved operational drift are required before terminal success.",
              orchestration.recoveryPolicy,
              orchestration.executionProfile.effective === "fast"
                ? "Fast profile: use the narrowest relevant context, one coherent patch, and one targeted verification; do not broaden into audit/fan-out work without new evidence."
                : orchestration.executionProfile.effective === "max"
                  ? "Max profile: optimize for completion speed and success rate by widening independent read-only/QA coverage early, fan out only through the deterministic safety gate, then integrate once and run regression verification."
                  : "Auto profile: stay balanced and let JK promote tiny tasks to Fast or broad/high-impact tasks to Max from current task shape and intent.",
              "Mass ULW may execute only after JK's deterministic gate approves and persists its fingerprint. Valid acyclic dependencies become ordered waves; only unsafe overlap between incomparable lanes, shared exclusive resources, cycles, malformed dependencies, or excessive lane count block fan-out.",
              "Preserve the persisted goal contract and decision ledger across turns; do not collapse the task to only the newest literal command.",
              "Do not re-ask settled non-security choices. Ask only when execution is genuinely blocked, requirements conflict, or a required security/approval boundary is reached.",
              doneRule,
              "This is JK-native orchestration driven by the current ChatGPT web session. It does not require a separate model/provider credential; OMO is optional.",
            ],
          };
        const result = makeResult(
          responsePayload,
          terminal
            ? terminalSuccess
              ? `Loop ${loopId} completed after verified release.`
              : `Loop ${loopId} stopped because the task is blocked.`
            : `Loop ${loopId} turn ${turn} ready. Execute the next action batch now, then call goal_loop again unless done or blocked.`,
        );
        await recordGoalLoopTelemetry({
          ctx,
          startedAt: telemetryStartedAt,
          coordinationMode: effectiveCoordinationMode,
          turn,
          failureCount: effectiveFailureCount,
          lifecycle,
          response: result,
        });
        await impulseDelivery?.commit().catch(() => undefined);
        return result;
        });
      });
    },
  );
}
