// MCP tool registrations (command). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../../types.js";
import { ExecutionTargetSchema } from "../../executors/target-protocol.js";
import { listCommands, runCommand } from "../../exec/command-runner.js";
import { isAutonomousDevelopmentNetworkCommand } from "../../exec/local-shell.js";
import { classifyReadOnlyNetworkApprovalScope, inspectShellCommand, runLocalShell } from "../../exec/local-shell.js";
import { consumeLocalShellApprovalGrant, hasActiveTaskNetworkApproval, localShellApprovalId, requestLocalShellApproval, taskApprovalIdentity } from "../../policy/local-approvals.js";
import { isAutonomousCloudInventoryRead, isSafeTaskFollowupNetworkRead } from "../../exec/local-shell.js";
import { isTrustedOwnerRoutineNetworkCommand } from "../../exec/local-shell.js";
import { findReusableLocalShellJob, localShellRunnerInstanceId, queueLocalShellJob, restartStableTargetApprovalIdentity, targetApprovalIdentity, readLocalShellJob, updateLocalShellJob, type LocalShellJobCompletionProof } from "../../policy/local-shell-jobs.js";
import { isJkMaintenanceCommand } from "../../exec/local-shell.js";
import { runOmo } from "../../exec/omo-runner.js";
import { getRuntimeSchemaHealth } from "../runtime-schema-health.js";
import { redact } from "../../policy/secrets.js";
import { dispatchExecutorJob, listExecutorStatus } from "../../executors/broker.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { approvalPlanContains, buildTaskSafetyGate, inferCommandExecutionKind, makeDefaultTaskSafety, mergeTaskSafety, strongerExecutionKind } from "../task-safety.js";
import { isReleaseShellCommand, loadSession, type WorkContextSlice, waitForExecutorReconnectCompletion, WorkSessionIdSchema, getWorkContext, recordTaskContinuation, recordVerification, requireProjectLease, resolveOrThrow, localExecutionRoot, isRemoteProject, remotePayload, READ_ONLY_ANNOTATIONS, COMMAND_RUN_ANNOTATIONS, chatGptToolMeta, withErrorMapping } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerCommandTools(registerTool: RegisterTool, ctx: ToolContext): void {
  // -------------------------------------------------------------------
  // 8.5 Execution tools
  // -------------------------------------------------------------------

  registerTool(
    "command_list",
    {
      title: "List project commands",
      description: "List allowlist-eligible commands discovered from project manifests.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Listing project commands...", "Project commands listed"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "command_list", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const commands = isRemoteProject(entry)
          ? (await dispatchExecutorJob<{ commands: Awaited<ReturnType<typeof listCommands>> }>(
              ctx.stateDir,
              entry.executorId,
              "command_list",
              remotePayload(entry, {}),
            )).commands
          : await listCommands(entry.root);
        return makeResult({ commands }, `Found ${commands.length} allowlisted command(s).`);
      });
    },
  );

  registerTool(
    "command_run",
    {
      title: "Run project command",
      description: "Run an allowlisted discovered command (never arbitrary shell).",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Running project command...", "Project command finished"),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        commandId: z.string(),
        args: z.array(z.string()).optional(),
        intent: z
          .object({
            writesWorkspace: z.boolean().optional(),
            needsNetwork: z.boolean().optional(),
            expectedDurationSec: z.number().int().optional(),
          })
          .optional(),
      },
    },
    async (input) => {
      return withErrorMapping<Record<string, unknown>>(ctx, "command_run", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const commandsForPolicy = isRemoteProject(entry)
          ? (await dispatchExecutorJob<{ commands: Awaited<ReturnType<typeof listCommands>> }>(
              ctx.stateDir,
              entry.executorId,
              "command_list",
              remotePayload(entry, {}),
            )).commands
          : await listCommands(entry.root);
        const commandForPolicy = commandsForPolicy.find((c) => c.commandId === input.commandId);
        const capability = commandForPolicy?.riskTier === "verify" ? "verify" : commandForPolicy?.riskTier === "read" ? "read" : "remote";
        await requireProjectLease(ctx, input.projectId, capability);
        if (commandForPolicy?.riskTier === "destructive" || commandForPolicy?.riskTier === "network") {
          const session = await loadSession(ctx);
          const workContext = getWorkContext(session, input.projectId, input.workSessionId);
          const taskState = workContext?.taskState;
          const approvalWorkSessionId = input.workSessionId ?? workContext?.workSessionId;
          const taskIdentity = targetApprovalIdentity(ExecutionTargetSchema.parse(entry.executionTarget), taskApprovalIdentity({
            goalId: taskState?.goalId,
            loopId: taskState?.loopId,
            workSessionId: approvalWorkSessionId,
            leaseId: session.lease?.projectId === input.projectId && session.lease.expiresAt > Date.now() ? session.lease.leaseId : undefined,
          }));
          const continuation = taskState && (taskState.goalId || taskState.loopId)
            ? {
                workSessionId: approvalWorkSessionId ?? null,
                goalId: taskState.goalId,
                loopId: taskState.loopId,
              }
            : null;
          const needsNetwork = commandForPolicy.riskTier === "network" || Boolean(input.intent?.needsNetwork);
          const destructive = commandForPolicy.riskTier === "destructive";
          const approvalCommand = `command_run ${JSON.stringify({
            commandId: input.commandId,
            args: input.args ?? [],
            manifestFingerprint: commandForPolicy.manifestFingerprint,
          })}`;
          const approvalReason = `Run allowlisted project command ${input.commandId}`;
          const jobInput = {
            projectId: input.projectId,
            executionTarget: entry.executionTarget,
            command: approvalCommand,
            executionKind: "command-run" as const,
            reason: approvalReason,
            taskIdentity,
            workSessionId: approvalWorkSessionId,
            needsNetwork,
            destructive,
            writesWorkspace: input.intent?.writesWorkspace,
          };
          const reusableJob = await findReusableLocalShellJob(ctx.stateDir, jobInput);
          if (reusableJob) {
            if (reusableJob.continuation) {
              const continuationStatus = reusableJob.status === "pending"
                ? "waiting-approval"
                : reusableJob.status === "running"
                  ? "running"
                  : reusableJob.status === "succeeded"
                    ? "ready-to-resume"
                    : "blocked";
              await recordTaskContinuation(
                ctx,
                input.projectId,
                reusableJob.continuation.workSessionId ?? undefined,
                { jobId: reusableJob.id, status: continuationStatus, updatedAt: Date.now() },
              );
            }
            if (reusableJob.status === "pending") {
              throw new DomainError(
                ErrorCode.APPROVAL_REQUIRED,
                "This exact project command is already waiting for local approval. Reuse the existing job; do not create or retry the command.",
                {
                  approvalId: reusableJob.id,
                  jobId: reusableJob.id,
                  expiresAt: reusableJob.expiresAt,
                  approvalReused: "existing-job",
                },
              );
            }
            if (reusableJob.status === "running") {
              return makeResult(
                { jobId: reusableJob.id, status: reusableJob.status, reusedJob: true },
                "The previously approved project command is already running. Do not reissue it; continue from this job result when it completes.",
              );
            }
            if (reusableJob.status === "succeeded") {
              return makeResult(
                {
                  exitCode: reusableJob.exitCode ?? 0,
                  stdoutSummary: reusableJob.stdoutSummary ?? "",
                  stderrSummary: reusableJob.stderrSummary ?? "",
                  durationMs: reusableJob.durationMs ?? 0,
                  outputTruncated: false,
                  jobId: reusableJob.id,
                  reusedJob: true,
                },
                "Reused the completed result of the same approved project command; the command was not executed again.",
              );
            }
            throw new DomainError(
              ErrorCode.COMMAND_FAILED,
              "The same approved project command already failed. Inspect its stored result before deciding on a different command; do not request approval again.",
              {
                jobId: reusableJob.id,
                exitCode: reusableJob.exitCode ?? null,
                stdoutSummary: reusableJob.stdoutSummary ?? "",
                stderrSummary: reusableJob.stderrSummary ?? "",
                error: reusableJob.error ?? null,
              },
            );
          }
          const approvalInput = {
            projectId: input.projectId,
            command: approvalCommand,
            reason: approvalReason,
            taskIdentity,
            workSessionId: approvalWorkSessionId,
            needsNetwork,
            destructive,
          };
          const pending = await requestLocalShellApproval(ctx.stateDir, approvalInput);
          if (pending.status === "denied") {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "This exact project command was denied by the local owner", {
              approvalId: pending.id,
            });
          }
          const queuedJob = await queueLocalShellJob(ctx.stateDir, pending, {
            executionTarget: entry.executionTarget,
            command: approvalCommand,
            executionKind: "command-run",
            commandId: input.commandId,
            args: input.args,
            manifestFingerprint: commandForPolicy.manifestFingerprint,
            reason: approvalReason,
            taskIdentity,
            workSessionId: approvalWorkSessionId,
            needsNetwork,
            destructive,
            timeoutSec: input.intent?.expectedDurationSec,
            writesWorkspace: input.intent?.writesWorkspace,
            continuation,
          });
          if (queuedJob.continuation) {
            await recordTaskContinuation(
              ctx,
              input.projectId,
              queuedJob.continuation.workSessionId ?? undefined,
              { jobId: queuedJob.id, status: "waiting-approval", updatedAt: Date.now() },
            );
          }
          throw new DomainError(
            ErrorCode.APPROVAL_REQUIRED,
            "This allowlisted project command requires local approval in the JK Control Center. Approving it starts this exact pinned command job automatically; do not reissue the command.",
            {
              approvalId: pending.id,
              jobId: queuedJob.id,
              expiresAt: pending.expiresAt,
            },
          );
        }
        await ctx.ledger.append({
          type: "process.started",
          projectId: input.projectId,
          commandId: input.commandId,
        });
        const result = isRemoteProject(entry)
          ? await dispatchExecutorJob<Awaited<ReturnType<typeof runCommand>>>(
              ctx.stateDir,
              entry.executorId,
              "command_run",
              remotePayload(entry, {
                commandId: input.commandId,
                args: input.args,
                timeoutSec: input.intent?.expectedDurationSec,
              }),
              Math.max(60_000, (input.intent?.expectedDurationSec ?? 30) * 1_000 + 10_000),
            )
          : await runCommand(
              await localExecutionRoot(ctx, entry),
              input.commandId,
              input.args,
              input.intent?.expectedDurationSec,
            );
        if (commandForPolicy?.riskTier === "verify") {
          await recordVerification(ctx, input.projectId, input.workSessionId, {
            tool: "command_run",
            command: [input.commandId, ...(input.args ?? [])].join(" ").slice(0, 500),
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          });
        }
        await ctx.ledger.append({
          type: "process.output.redacted",
          projectId: input.projectId,
          commandId: input.commandId,
          exitCode: result.exitCode,
        });
        return makeResult(
          {
            exitCode: result.exitCode,
            stdoutSummary: redact(result.stdoutSummary),
            stderrSummary: redact(result.stderrSummary),
            durationMs: result.durationMs,
            outputTruncated: result.outputTruncated,
          },
          `Command ${input.commandId} exited ${result.exitCode} in ${result.durationMs}ms.`,
        );
      });
    },
  );

  registerTool(
    "local_shell_run",
    {
      title: "Run local project shell",
      description:
        "Run an arbitrary local shell command inside the selected project, Codex-style. Use when allowlisted command_run is too limited. Project-confined; output is redacted; secret-path and OS-destructive commands are blocked. For a known multi-step risky task, predeclare the exact follow-up commands in intent.approvalBundle so one owner approval can cover only that bounded task bundle. Approval UX rule: never tell the user that an approval is pending, visible, or ready to click unless this tool result explicitly contains structuredContent.approvalPending=true. APPROVAL_REQUIRED with approvalPending=false, a blocked/skipped call, timeout, unavailable tool, or missing result is NOT proof that anything appeared in Control Center.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Running local shell...", "Local shell finished"),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        command: z.string(),
        cwd: z.string().optional(),
        timeoutSec: z.number().int().positive().max(900).optional(),
        intent: z
          .object({
            reason: z.string().optional(),
            writesWorkspace: z.boolean().optional(),
            needsNetwork: z.boolean().optional(),
            destructive: z.boolean().optional(),
            approvalBundle: z
              .object({
                label: z.string().min(1).max(160),
                commands: z.array(z.string().min(1)).min(1).max(19),
                ttlMinutes: z.number().int().min(1).max(30).optional(),
              })
              .optional(),
          })
          .optional(),
      },
    },
    async (input) => {
      return withErrorMapping<Record<string, unknown>>(ctx, "local_shell_run", input, async () => {
        await requireProjectLease(ctx, input.projectId, "write");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const session = await loadSession(ctx);
        const workContext = getWorkContext(session, input.projectId, input.workSessionId);
        const taskState = workContext?.taskState;
        const approvalWorkSessionId = input.workSessionId ?? workContext?.workSessionId;
        const approvalTaskIdentity = targetApprovalIdentity(ExecutionTargetSchema.parse(entry.executionTarget), taskApprovalIdentity({
          goalId: taskState?.goalId,
          loopId: taskState?.loopId,
          workSessionId: approvalWorkSessionId,
          leaseId: session.lease?.projectId === input.projectId && session.lease.expiresAt > Date.now() ? session.lease.leaseId : undefined,
        }));
        const detectedRisk = inspectShellCommand(input.command);
        const commandExecutionKind = inferCommandExecutionKind(input.command);
        const persistedSafety = taskState?.executionSafety ?? makeDefaultTaskSafety();
        const requiredExecutionKind = strongerExecutionKind(persistedSafety.executionKind, commandExecutionKind);
        const commandSafety = mergeTaskSafety(persistedSafety, { executionKind: requiredExecutionKind }, requiredExecutionKind);
        const commandSafetyGate = buildTaskSafetyGate(commandSafety);
        const approvalNeedsNetwork = Boolean(input.intent?.needsNetwork || detectedRisk.needsNetwork);
        const approvalDestructive = Boolean(input.intent?.destructive || detectedRisk.destructive);
        const explicitApprovalBundle = input.intent?.approvalBundle;
        const plannedBundleCommands =
          approvalTaskIdentity &&
          requiredExecutionKind !== "workspace" &&
          commandSafetyGate.approvalReady
            ? commandSafety.approvalPlan
            : [];
        const requestedBundleCommands = approvalTaskIdentity && (explicitApprovalBundle || plannedBundleCommands.length > 0)
          ? [...new Set([input.command, ...(explicitApprovalBundle?.commands ?? []), ...plannedBundleCommands])].slice(0, 20)
          : [];
        const approvalBundle = requestedBundleCommands.length
          ? {
              label: explicitApprovalBundle?.label ?? `${requiredExecutionKind} task approval plan`,
              ttlMs: (explicitApprovalBundle?.ttlMinutes ?? 30) * 60 * 1000,
              entries: requestedBundleCommands.map((command) => {
                if (command === input.command) {
                  return { command, needsNetwork: approvalNeedsNetwork, destructive: approvalDestructive };
                }
                const risk = inspectShellCommand(command);
                return { command, needsNetwork: risk.needsNetwork, destructive: risk.destructive };
              }),
            }
          : undefined;
        const maintenanceScope = isJkMaintenanceCommand(input.command)
          ? { key: "maintenance:jk:runtime-reload", label: "JK runtime maintenance", ttlMs: 15 * 60 * 1000 }
          : undefined;
        if (!maintenanceScope && isReleaseShellCommand(input.command)) {
          const schemaHealth = await getRuntimeSchemaHealth();
          if (schemaHealth.releaseBlocked) {
            throw new DomainError(
              ErrorCode.RUNTIME_SCHEMA_MISMATCH,
              "Release command blocked because the running JK source/build/tool schema fingerprints do not agree. Upgrade/reload JK first, then verify the registered goal_loop schema before retrying the release.",
              {
                schemaStatus: schemaHealth.status,
                reasons: schemaHealth.reasons,
                missingGoalLoopInputFields: schemaHealth.missingGoalLoopInputFields,
                toolSchemaFingerprint: schemaHealth.toolSchemaFingerprint,
                sourceFingerprint: schemaHealth.sourceFingerprint,
                expectedSourceFingerprint: schemaHealth.expectedSourceFingerprint,
                buildFingerprint: schemaHealth.buildFingerprint,
                expectedBuildFingerprint: schemaHealth.expectedBuildFingerprint,
              },
            );
          }
        }
        const approvalInput = {
          projectId: input.projectId,
          command: input.command,
          cwd: input.cwd,
          reason: input.intent?.reason,
          taskIdentity: approvalTaskIdentity,
          workSessionId: approvalWorkSessionId,
          needsNetwork: approvalNeedsNetwork,
          destructive: approvalDestructive,
          bundle: approvalBundle,
          scope: maintenanceScope ?? (
            !input.intent?.writesWorkspace && !input.intent?.destructive && !detectedRisk.destructive
              ? classifyReadOnlyNetworkApprovalScope(input.command) ?? undefined
              : undefined
          ),
        };
        if (approvalInput.scope) approvalInput.scope = {
          ...approvalInput.scope,
          key: `${approvalInput.scope.key}:${targetApprovalIdentity(ExecutionTargetSchema.parse(entry.executionTarget))}`,
        };
        const autonomousDevelopmentNetwork =
          approvalInput.needsNetwork &&
          !approvalInput.destructive &&
          Boolean(input.intent?.writesWorkspace) &&
          isAutonomousDevelopmentNetworkCommand(input.command);
        const autonomousCloudInventory =
          approvalInput.needsNetwork &&
          !approvalInput.destructive &&
          !input.intent?.writesWorkspace &&
          isAutonomousCloudInventoryRead(input.command);
        const trustedOwnerRoutineNetwork =
          approvalInput.needsNetwork &&
          !approvalInput.destructive &&
          Boolean(input.intent?.writesWorkspace) &&
          isTrustedOwnerRoutineNetworkCommand(input.command);
        const autonomousScopedRead =
          approvalInput.needsNetwork &&
          !approvalInput.destructive &&
          !input.intent?.writesWorkspace &&
          Boolean(approvalInput.scope);
        const taskApprovedSafeFollowup =
          approvalInput.needsNetwork &&
          !approvalInput.destructive &&
          !input.intent?.writesWorkspace &&
          Boolean(approvalTaskIdentity) &&
          isSafeTaskFollowupNetworkRead(input.command)
            ? await hasActiveTaskNetworkApproval(ctx.stateDir, {
                projectId: input.projectId,
                cwd: input.cwd,
                taskIdentity: approvalTaskIdentity!,
              })
            : false;
        const requiresApproval =
          approvalInput.destructive ||
          (approvalInput.needsNetwork &&
            !autonomousDevelopmentNetwork &&
            !trustedOwnerRoutineNetwork &&
            !autonomousCloudInventory &&
            !autonomousScopedRead &&
            !taskApprovedSafeFollowup);
        const continuationContext = getWorkContext(session, input.projectId, input.workSessionId);
        const continuationTask = continuationContext?.taskState;
        const continuation =
          continuationTask && (continuationTask.goalId || continuationTask.loopId)
            ? {
                workSessionId: input.workSessionId ?? continuationContext?.workSessionId ?? null,
                goalId: continuationTask.goalId,
                loopId: continuationTask.loopId,
              }
            : null;
        if (requiresApproval && requiredExecutionKind !== "workspace") {
          if (!commandSafetyGate.approvalReady) {
            throw new DomainError(
              ErrorCode.COMMAND_NOT_ALLOWED,
              `Safety preflight must pass before creating an approval for ${requiredExecutionKind} work`,
              { safetyBlockers: commandSafetyGate.approvalBlockers, approvalPending: false },
            );
          }
          if (!approvalPlanContains(commandSafety, input.command)) {
            throw new DomainError(
              ErrorCode.COMMAND_NOT_ALLOWED,
              "This risky command was not predeclared in the goal_loop safety approval plan",
              { approvalPending: false },
            );
          }
          if (commandSafety.approvalPlan.length > 1) {
            const bundled = new Set(requestedBundleCommands);
            const missing = commandSafety.approvalPlan.filter((command) => !bundled.has(command));
            if (missing.length > 0) {
              throw new DomainError(
                ErrorCode.COMMAND_NOT_ALLOWED,
                "The approval bundle must include the complete predeclared risky command chain",
                { missingApprovalPlanCommands: missing, approvalPending: false },
              );
            }
          }
        }
        const approvalRuntimeFingerprint = requiresApproval
          ? await getRuntimeSchemaHealth().then((health) => JSON.stringify({
              toolSchemaFingerprint: health.toolSchemaFingerprint,
              sourceFingerprint: health.sourceFingerprint,
              buildFingerprint: health.buildFingerprint,
            }))
          : undefined;
        if (requiresApproval) {
          const reusableJob = await findReusableLocalShellJob(ctx.stateDir, {
            projectId: input.projectId,
            executionTarget: entry.executionTarget,
            command: input.command,
            cwd: input.cwd,
            reason: input.intent?.reason,
            taskIdentity: approvalTaskIdentity,
            workSessionId: approvalWorkSessionId,
            needsNetwork: approvalNeedsNetwork,
            destructive: approvalDestructive,
            writesWorkspace: input.intent?.writesWorkspace,
            manifestFingerprint: approvalRuntimeFingerprint,
          });
          if (reusableJob) {
            if (reusableJob.continuation) {
              const continuationStatus = reusableJob.status === "pending"
                ? "waiting-approval"
                : reusableJob.status === "running"
                  ? "running"
                  : reusableJob.status === "succeeded"
                    ? "ready-to-resume"
                    : "blocked";
              await recordTaskContinuation(
                ctx,
                input.projectId,
                reusableJob.continuation.workSessionId ?? undefined,
                { jobId: reusableJob.id, status: continuationStatus, updatedAt: Date.now() },
              );
            }
            if (reusableJob.status === "pending") {
              throw new DomainError(
                ErrorCode.APPROVAL_REQUIRED,
                "This exact local shell request is already waiting for local approval. Reuse the existing job; do not create or retry the command.",
                {
                  approvalId: reusableJob.id,
                  jobId: reusableJob.id,
                  expiresAt: reusableJob.expiresAt,
                  approvalReused: "existing-job",
                },
              );
            }
            if (reusableJob.status === "running") {
              return makeResult(
                { jobId: reusableJob.id, status: reusableJob.status, reusedJob: true },
                "The previously approved job is already running. Do not reissue the command; continue from this job result when it completes.",
              );
            }
            if (reusableJob.status === "succeeded") {
              return makeResult(
                {
                  cwd: reusableJob.cwd,
                  exitCode: reusableJob.exitCode ?? 0,
                  stdoutSummary: reusableJob.stdoutSummary ?? "",
                  stderrSummary: reusableJob.stderrSummary ?? "",
                  durationMs: reusableJob.durationMs ?? 0,
                  outputTruncated: false,
                  jobId: reusableJob.id,
                  reusedJob: true,
                },
                "Reused the completed result of the same approved job; the command was not executed again.",
              );
            }
            throw new DomainError(
              ErrorCode.COMMAND_FAILED,
              "The same approved job already failed. Inspect its stored result before deciding on a different command; do not request approval again.",
              {
                jobId: reusableJob.id,
                exitCode: reusableJob.exitCode ?? null,
                stdoutSummary: reusableJob.stdoutSummary ?? "",
                stderrSummary: reusableJob.stderrSummary ?? "",
                error: reusableJob.error ?? null,
              },
            );
          }
        }
        const approvalGrant = requiresApproval
          ? await consumeLocalShellApprovalGrant(ctx.stateDir, approvalInput)
          : null;
        const approved = Boolean(approvalGrant);
        if (requiresApproval && !approved) {
          const pending = await requestLocalShellApproval(ctx.stateDir, approvalInput);
          const reusedPendingBundle = pending.id !== localShellApprovalId(approvalInput);
          if (pending.status === "denied") {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "This exact local shell request was denied by the local owner", {
              approvalId: pending.id,
            });
          }
          const queuedJob = reusedPendingBundle
            ? await readLocalShellJob(ctx.stateDir, pending.id)
            : await queueLocalShellJob(ctx.stateDir, pending, {
                executionTarget: entry.executionTarget,
                command: input.command,
                cwd: input.cwd,
                reason: input.intent?.reason,
                taskIdentity: approvalInput.taskIdentity,
                workSessionId: approvalWorkSessionId,
                needsNetwork: approvalInput.needsNetwork,
                destructive: approvalInput.destructive,
                timeoutSec: input.timeoutSec,
                writesWorkspace: input.intent?.writesWorkspace,
                manifestFingerprint: approvalRuntimeFingerprint,
                continuation,
              });
          if (queuedJob?.continuation) {
            await recordTaskContinuation(
              ctx,
              input.projectId,
              queuedJob.continuation.workSessionId ?? undefined,
              { jobId: pending.id, status: "waiting-approval", updatedAt: Date.now() },
            );
          }
          throw new DomainError(
            ErrorCode.APPROVAL_REQUIRED,
            pending.bundleLabel
              ? `This local shell request requires local approval. Approving it authorizes only the ${pending.bundleCommandKeys?.length ?? 0} predeclared command+risk hashes in task bundle ${pending.bundleLabel}.`
              : pending.scopeLabel
              ? `This local shell request requires local approval. Approving it opens a short scoped session for ${pending.scopeLabel}.`
              : "This exact local shell request requires local approval in the JK Control Center",
            {
              approvalId: pending.id,
              jobId: queuedJob?.id ?? pending.id,
              expiresAt: pending.expiresAt,
              scopeLabel: pending.scopeLabel ?? null,
              scopeTtlMs: pending.scopeTtlMs ?? null,
              bundleLabel: pending.bundleLabel ?? null,
              bundleCount: pending.bundleCommandKeys?.length ?? 0,
              bundleTtlMs: pending.bundleTtlMs ?? null,
              approvalReused: reusedPendingBundle ? "task-bundle" : null,
            },
          );
        }
        const bundleJob = approvalGrant?.source === "task-bundle"
          ? await queueLocalShellJob(
              ctx.stateDir,
              {
                id: approvalGrant.approvalId,
                projectId: input.projectId,
                workSessionId: approvalGrant.workSessionId ?? undefined,
                bundleFingerprint: approvalGrant.bundleFingerprint,
                createdAt: approvalGrant.createdAt,
                expiresAt: approvalGrant.expiresAt,
              },
              {
                command: input.command,
                executionTarget: entry.executionTarget,
                cwd: input.cwd,
                reason: input.intent?.reason,
                taskIdentity: approvalTaskIdentity,
                workSessionId: approvalGrant.workSessionId,
                approvalId: approvalGrant.approvalId,
                bundleFingerprint: approvalGrant.bundleFingerprint,
                needsNetwork: approvalNeedsNetwork,
                destructive: approvalDestructive,
                timeoutSec: input.timeoutSec,
                writesWorkspace: input.intent?.writesWorkspace,
                manifestFingerprint: approvalRuntimeFingerprint,
                continuation,
              },
            )
          : null;
        if (bundleJob) {
          await updateLocalShellJob(ctx.stateDir, bundleJob.id, (current) => ({
            ...current,
            status: "running",
            runnerInstanceId: localShellRunnerInstanceId(),
            interruptedByRestart: false,
            startedAt: Date.now(),
          }));
        }
        await ctx.ledger.append({
          type: "process.started",
          projectId: input.projectId,
          command: redact(input.command),
          shell: true,
        });
        const approvedNeedsNetwork =
          autonomousDevelopmentNetwork ||
          trustedOwnerRoutineNetwork ||
          autonomousCloudInventory ||
          autonomousScopedRead ||
          taskApprovedSafeFollowup ||
          (approved && approvalInput.needsNetwork);
        const approvedDestructive = approved && approvalInput.destructive;
        let result: Awaited<ReturnType<typeof runLocalShell>>;
        try {
          result = isRemoteProject(entry)
            ? await dispatchExecutorJob<Awaited<ReturnType<typeof runLocalShell>>>(
                ctx.stateDir,
                entry.executorId,
                "local_shell_run",
                remotePayload(entry, {
                  command: input.command,
                  cwd: input.cwd,
                  timeoutSec: input.timeoutSec,
                  approvedNeedsNetwork,
                  approvedDestructive,
                }),
                Math.max(60_000, (input.timeoutSec ?? 30) * 1_000 + 10_000),
              )
            : await runLocalShell(await localExecutionRoot(ctx, entry), input.command, input.cwd, input.timeoutSec, {
                needsNetwork: approvedNeedsNetwork,
                destructive: approvedDestructive,
              });
        } catch (error) {
          if (bundleJob) {
            await updateLocalShellJob(ctx.stateDir, bundleJob.id, (current) => ({
              ...current,
              status: "failed",
              finishedAt: Date.now(),
              error: redact(error instanceof Error ? error.message : "Local shell job failed"),
            }));
          }
          throw error;
        }
        if (bundleJob) {
          await updateLocalShellJob(ctx.stateDir, bundleJob.id, (current) => ({
            ...current,
            status: result.exitCode === 0 ? "succeeded" : "failed",
            finishedAt: Date.now(),
            exitCode: result.exitCode,
            stdoutSummary: redact(result.stdoutSummary),
            stderrSummary: redact(result.stderrSummary),
            durationMs: result.durationMs,
          }));
        }
        if (!input.intent?.writesWorkspace) {
          await recordVerification(ctx, input.projectId, input.workSessionId, {
            tool: "local_shell_run",
            command: redact(input.command).slice(0, 500),
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          });
        }
        await ctx.ledger.append({
          type: "process.output.redacted",
          projectId: input.projectId,
          command: redact(input.command),
          exitCode: result.exitCode,
        });
        return makeResult(
          {
            cwd: result.cwd,
            exitCode: result.exitCode,
            stdoutSummary: result.stdoutSummary,
            stderrSummary: result.stderrSummary,
            durationMs: result.durationMs,
            outputTruncated: result.outputTruncated,
            jobId: bundleJob?.id,
          },
          `Local shell exited ${result.exitCode} in ${result.durationMs}ms.`,
        );
      });
    },
  );

  registerTool(
    "runtime_upgrade",
    {
      title: "Upgrade or reload JK runtime",
      description:
        "Fixed bootstrap primitive for replacing/reloading the JK runtime without depending on release safety-schema fields. It only runs JK's repository-owned rollback-capable reload script, requires a full-write lease plus one explicit owner approval in the authoritative JK Control Center, supports the local runtime and remote Windows executor targets, and can recover from a stale tool schema without accepting arbitrary commands.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Preparing JK runtime upgrade...", "JK runtime upgrade queued"),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
      },
    },
    async (input) => {
      return withErrorMapping<Record<string, unknown>>(ctx, "runtime_upgrade", input, async () => {
        await requireProjectLease(ctx, input.projectId, "write");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        let command: string;
        let runtimeManifestFingerprint = "";
        let completionProof: LocalShellJobCompletionProof | null = null;
        if (isRemoteProject(entry)) {
          const executor = (await listExecutorStatus(ctx.stateDir)).find((candidate) => candidate.executorId === entry.executorId);
          if (!executor?.online) {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Executor is offline: ${entry.executorId}`, { executorId: entry.executorId });
          }
          if (!executor.platform.toLowerCase().startsWith("win32")) {
            throw new DomainError(
              ErrorCode.COMMAND_NOT_ALLOWED,
              "remote runtime_upgrade currently supports the Windows JK executor only",
              { executorId: entry.executorId, platform: executor.platform },
            );
          }
          completionProof = {
            kind: "executor-reconnect",
            executorId: entry.executorId,
            previousInstanceId: executor.instanceId ?? null,
            requiredHeartbeats: 3,
            timeoutMs: 60_000,
            requiredCapabilities: ["git_sync_start"],
          };
          command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\reload-jk-runtime.ps1 -Root . -ExecutorOnly";

          // A repeated runtime_upgrade call may arrive while the already-approved
          // worker is executing the reload or reconnecting. Reuse that exact
          // persisted task job before dispatching any new preflight reads to the
          // worker, otherwise a busy/restarting worker can be misreported as a
          // checkout missing src/server/tools.ts.
          const replaySession = await loadSession(ctx);
          const replayContext = getWorkContext(replaySession, input.projectId, input.workSessionId);
          const replayTask = replayContext?.taskState;
          const replayWorkSessionId = input.workSessionId ?? replayContext?.workSessionId ?? null;
          const replayJobId = replayTask?.continuation?.jobId;
          if (replayJobId) {
            const replayJob = await readLocalShellJob(ctx.stateDir, replayJobId);
            const previousTarget = replayJob?.executionTarget;
            const currentTarget = ExecutionTargetSchema.parse(entry.executionTarget);
            const sameStableTarget = Boolean(previousTarget) &&
              previousTarget?.kind === currentTarget.kind &&
              previousTarget?.protocolVersion === currentTarget.protocolVersion &&
              previousTarget?.executorId === currentTarget.executorId &&
              previousTarget?.workspaceRoot === currentTarget.workspaceRoot &&
              previousTarget?.projectId === currentTarget.projectId &&
              previousTarget?.sourceProjectId === currentTarget.sourceProjectId &&
              previousTarget?.projectRoot === currentTarget.projectRoot;
            const sameTaskContinuation = replayJob?.continuation?.workSessionId === replayWorkSessionId &&
              replayJob?.continuation?.goalId === (replayTask?.goalId ?? null) &&
              replayJob?.continuation?.loopId === (replayTask?.loopId ?? null);
            if (
              replayJob && sameStableTarget && sameTaskContinuation &&
              replayJob.projectId === input.projectId &&
              replayJob.command === command &&
              (replayJob.workSessionId ?? null) === replayWorkSessionId &&
              replayJob.needsNetwork === false && replayJob.destructive === true && replayJob.writesWorkspace === false &&
              replayJob.completionProof?.kind === "executor-reconnect" && replayJob.completionProof.executorId === entry.executorId
            ) {
              if (replayJob.status === "pending") {
                throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "This JK runtime upgrade is already waiting for owner approval in the authoritative JK Control Center; reuse the existing job.", {
                  approvalId: replayJob.id,
                  jobId: replayJob.id,
                  expiresAt: replayJob.expiresAt,
                  approvalReused: "existing-job",
                });
              }
              if (replayJob.status === "running") {
                return makeResult({ jobId: replayJob.id, status: replayJob.status, reusedJob: true }, "The approved JK runtime upgrade is already running.");
              }
            }
          }
          for (const rel of ["src/server/tools.ts", "dist/runtime-schema-manifest.json", "scripts/reload-jk-runtime.ps1"]) {
            const slice = await dispatchExecutorJob<WorkContextSlice>(
              ctx.stateDir,
              entry.executorId,
              "file_read_slice",
              remotePayload(entry, { path: rel, start: 1, end: rel === "dist/runtime-schema-manifest.json" ? 200 : 1 }),
            ).catch(() => {
              throw new DomainError(
                ErrorCode.COMMAND_NOT_ALLOWED,
                "runtime_upgrade could not verify the remote Windows JK checkout through the executor",
                { projectId: input.projectId, executorId: entry.executorId, unverified: rel },
              );
            });
            if (rel === "dist/runtime-schema-manifest.json") runtimeManifestFingerprint = slice.fileHash;
          }
        } else {
          const windowsScript = path.join(entry.root, "scripts", "reload-jk-runtime.ps1");
          const unixScript = path.join(entry.root, "scripts", "reload-jk-runtime.sh");
          const sourceMarker = path.join(entry.root, "src", "server", "tools.ts");
          const runtimeManifest = path.join(entry.root, "dist", "runtime-schema-manifest.json");
          await fs.access(sourceMarker).catch(() => {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "runtime_upgrade is restricted to the jk source project");
          });
          const script = process.platform === "win32" ? windowsScript : unixScript;
          await fs.access(script).catch(() => {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "The fixed JK runtime reload script is missing", { script });
          });
          runtimeManifestFingerprint = createHash("sha256").update(await fs.readFile(runtimeManifest)).digest("hex");
          command = process.platform === "win32"
            ? "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\reload-jk-runtime.ps1 -Root ."
            : "bash scripts/reload-jk-runtime.sh";
        }
        if (!runtimeManifestFingerprint) {
          throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "JK runtime build identity is unavailable; run the build before runtime_upgrade");
        }
        const session = await loadSession(ctx);
        const workContext = getWorkContext(session, input.projectId, input.workSessionId);
        const taskState = workContext?.taskState;
        const approvalWorkSessionId = input.workSessionId ?? workContext?.workSessionId;
        const taskIdentity = restartStableTargetApprovalIdentity(ExecutionTargetSchema.parse(entry.executionTarget), taskApprovalIdentity({
          goalId: taskState?.goalId,
          loopId: taskState?.loopId,
          workSessionId: approvalWorkSessionId,
          leaseId: session.lease?.projectId === input.projectId && session.lease.expiresAt > Date.now() ? session.lease.leaseId : undefined,
        }));
        const continuation = taskState && (taskState.goalId || taskState.loopId)
          ? {
              workSessionId: approvalWorkSessionId ?? null,
              goalId: taskState.goalId,
              loopId: taskState.loopId,
            }
          : null;
        const jobInput = {
          projectId: input.projectId,
          executionTarget: entry.executionTarget,
          command,
          cwd: undefined,
          reason: isRemoteProject(entry)
            ? "Reload the remote Windows JK runtime through the central rollback-capable runtime_upgrade primitive"
            : "Reload JK runtime through the fixed rollback-capable runtime_upgrade primitive",
          taskIdentity,
          workSessionId: approvalWorkSessionId,
          needsNetwork: false,
          destructive: true,
          writesWorkspace: false,
          manifestFingerprint: runtimeManifestFingerprint,
          completionProof,
        };
        const reusable = await findReusableLocalShellJob(ctx.stateDir, jobInput);
        if (reusable) {
          if (reusable.status === "pending") {
            throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "This JK runtime upgrade is already waiting for owner approval in the authoritative JK Control Center; reuse the existing job.", {
              approvalId: reusable.id,
              jobId: reusable.id,
              expiresAt: reusable.expiresAt,
              approvalReused: "existing-job",
            });
          }
          if (reusable.status === "running") {
            return makeResult({ jobId: reusable.id, status: reusable.status, reusedJob: true }, "The approved JK runtime upgrade is already running.");
          }
          if (reusable.status === "succeeded") {
            return makeResult({
              jobId: reusable.id,
              exitCode: reusable.exitCode ?? 0,
              stdoutSummary: reusable.stdoutSummary ?? "",
              stderrSummary: reusable.stderrSummary ?? "",
              durationMs: reusable.durationMs ?? 0,
              reusedJob: true,
            }, "Reused the completed JK runtime upgrade job result.");
          }
          throw new DomainError(ErrorCode.COMMAND_FAILED, "The previous JK runtime upgrade job failed. Inspect that job result instead of requesting another approval.", {
            jobId: reusable.id,
            exitCode: reusable.exitCode ?? null,
            stdoutSummary: reusable.stdoutSummary ?? "",
            stderrSummary: reusable.stderrSummary ?? "",
            error: reusable.error ?? null,
          });
        }
        const maintenanceScope = {
          key: `maintenance:jk:runtime-reload:${restartStableTargetApprovalIdentity(ExecutionTargetSchema.parse(entry.executionTarget))}:${runtimeManifestFingerprint}`,
          label: "JK runtime maintenance",
          ttlMs: 15 * 60 * 1000,
        };
        const scopedGrant = await consumeLocalShellApprovalGrant(ctx.stateDir, {
          projectId: input.projectId,
          command,
          needsNetwork: false,
          destructive: true,
          scope: maintenanceScope,
        });
        if (scopedGrant?.source === "scope") {
          const result = isRemoteProject(entry)
            ? await dispatchExecutorJob<Awaited<ReturnType<typeof runLocalShell>>>(
                ctx.stateDir,
                entry.executorId,
                "local_shell_run",
                remotePayload(entry, {
                  command,
                  timeoutSec: 120,
                  approvedNeedsNetwork: false,
                  approvedDestructive: true,
                }),
                130_000,
              )
            : await runLocalShell(await localExecutionRoot(ctx, entry), command, undefined, 120, { needsNetwork: false, destructive: true });
          if (result.exitCode !== 0) {
            throw new DomainError(ErrorCode.COMMAND_FAILED, "Scoped JK runtime upgrade failed", {
              exitCode: result.exitCode,
              stdoutSummary: redact(result.stdoutSummary),
              stderrSummary: redact(result.stderrSummary),
            });
          }
          await waitForExecutorReconnectCompletion(ctx, completionProof);
          return makeResult({
            exitCode: result.exitCode,
            stdoutSummary: result.stdoutSummary,
            stderrSummary: result.stderrSummary,
            durationMs: result.durationMs,
            approvalReused: "maintenance-scope",
            scopeKey: maintenanceScope.key,
          }, "Reused the bounded JK runtime maintenance approval scope.");
        }
        const approvalInput = {
          projectId: input.projectId,
          command,
          cwd: undefined,
          reason: jobInput.reason,
          taskIdentity,
          workSessionId: approvalWorkSessionId,
          needsNetwork: false,
          destructive: true,
          scope: maintenanceScope,
        };
        const pending = await requestLocalShellApproval(ctx.stateDir, approvalInput);
        if (pending.status === "denied") {
          throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "This JK runtime upgrade was denied by the local owner", { approvalId: pending.id });
        }
        const queued = await queueLocalShellJob(ctx.stateDir, pending, {
          executionTarget: entry.executionTarget,
          command,
          reason: jobInput.reason,
          taskIdentity,
          workSessionId: approvalWorkSessionId,
          needsNetwork: false,
          destructive: true,
          timeoutSec: 120,
          writesWorkspace: false,
          manifestFingerprint: jobInput.manifestFingerprint,
          continuation,
          completionProof,
        });
        if (queued.continuation) {
          await recordTaskContinuation(ctx, input.projectId, queued.continuation.workSessionId ?? undefined, {
            jobId: queued.id,
            status: "waiting-approval",
            updatedAt: Date.now(),
          });
        }
        throw new DomainError(
          ErrorCode.APPROVAL_REQUIRED,
          "JK runtime upgrade is queued behind one explicit owner approval in the authoritative JK Control Center. After approval the fixed reload script executes automatically on the selected runtime target; do not reissue a shell command.",
          {
            approvalId: pending.id,
            jobId: queued.id,
            expiresAt: pending.expiresAt,
            runtimeUpgrade: true,
          },
        );
      });
    },
  );

  registerTool(
    "omo_run",
    {
      title: "Run OMO coding agent",
      description:
        "Optional adapter, invoked only when the user explicitly asks for OMO; it is never part of the default JK-native goal_loop. Runs compatible legacy or OMO Native non-interactive CLIs and may use remote model providers. Set ultrawork=true to activate the native-compatible ULW path explicitly. Requires a remote-capable lease. The prompt is passed as argv, never through a shell.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Checking OMO compatibility and running agent...", "OMO finished"),
      inputSchema: {
        projectId: z.string(),
        message: z.string().min(1),
        agent: z.string().optional(),
        model: z.string().optional(),
        sessionId: z.string().optional(),
        timeoutSec: z.number().int().positive().max(3600).optional(),
        verbose: z.boolean().optional(),
        ultrawork: z
          .boolean()
          .optional()
          .describe("Explicitly activate OMO-compatible ultrawork mode; omitted and false keep normal execution."),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "omo_run", { ...input, message: "[prompt redacted]" }, async () => {
        await requireProjectLease(ctx, input.projectId, "remote");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        await ctx.ledger.append({
          type: "process.started",
          projectId: input.projectId,
          command: "omo run",
          runner: "omo",
          agent: input.agent,
          model: input.model,
          resumedSession: Boolean(input.sessionId),
          ultraworkRequested: input.ultrawork === true,
        });
        const result = await runOmo(await localExecutionRoot(ctx, entry), {
          message: input.message,
          agent: input.agent,
          model: input.model,
          sessionId: input.sessionId,
          timeoutSec: input.timeoutSec,
          verbose: input.verbose,
          ultrawork: input.ultrawork,
        });
        await ctx.ledger.append({
          type: "process.output.redacted",
          projectId: input.projectId,
          command: "omo run",
          runner: "omo",
          exitCode: result.exitCode,
          sessionId: result.sessionId,
          detectedVersion: result.detectedVersion,
          selectedVersion: result.selectedVersion,
          fallbackFromVersion: result.fallbackFromVersion,
          compatibilityStatus: result.compatibilityStatus,
          cliContract: result.cliContract,
          ultraworkRequested: result.ultraworkRequested,
          ultraworkTransport: result.ultraworkTransport,
        });
        const versionText = result.selectedVersion ? ` ${result.selectedVersion}` : "";
        const fallbackText = result.fallbackFromVersion
          ? ` (fallback from incompatible ${result.fallbackFromVersion})`
          : "";
        return makeResult(
          {
            cwd: result.cwd,
            runnerSource: result.source,
            compatibilityStatus: result.compatibilityStatus,
            cliContract: result.cliContract,
            detectedVersion: result.detectedVersion,
            selectedVersion: result.selectedVersion,
            fallbackFromVersion: result.fallbackFromVersion,
            incompatibleVersions: result.incompatibleVersions,
            exitCode: result.exitCode,
            stdoutSummary: result.stdoutSummary,
            stderrSummary: result.stderrSummary,
            sessionId: result.sessionId,
            ultraworkRequested: result.ultraworkRequested,
            ultraworkTransport: result.ultraworkTransport,
            durationMs: result.durationMs,
            outputTruncated: result.outputTruncated,
          },
          `OMO${versionText}${fallbackText} exited ${result.exitCode} in ${result.durationMs}ms${result.sessionId ? ` (session ${result.sessionId})` : ""}.`,
        );
      });
    },
  );
}
