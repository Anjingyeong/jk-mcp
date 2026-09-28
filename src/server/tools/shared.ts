// Shared helpers for the MCP tool registrations in src/server/tools/*.ts.
// Extracted verbatim from src/server/tools.ts (behavior unchanged).
import { z } from "zod";
import { renameWithRetry } from "../../util/fs-retry.js";
import { Store } from "../../state/store.js";
import { isTaskWorkspaceId, taskWorkspaceProjects, TaskWorkspaceStore } from "../../workspace/task-workspaces.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { DomainError, ErrorCode, makeResult, type ExecutionMode, type Lease, type LeasePreset, type Project, type ProjectRegistryEntry, type ToolContext, type ToolResult } from "../../types.js";
import { findProject } from "../../workspace/registry.js";
import { DEFAULT_LEASE_TTL_MS, makeLease, slideLease } from "../../workspace/project-select.js";
import { requireProjectLease as requireCapabilityLease, type LeaseCapability } from "../../workspace/lease-guard.js";
import { ExecutionTargetSchema, sameExecutionTarget, type ExecutionTarget } from "../../executors/target-protocol.js";
import { readSlice } from "../../code/read-slice.js";
import { ProjectMemoryStore } from "../../state/project-memory.js";
import { isProjectImagePath } from "../../assets/images.js";
import { hasActiveTaskNetworkApproval, taskApprovalIdentity } from "../../policy/local-approvals.js";
import { LocalShellJobReadError, quarantineInvalidLocalShellJob, targetApprovalIdentity, readLocalShellJob, type LocalShellJobCompletionProof } from "../../policy/local-shell-jobs.js";
import { buildMassUlwPlan } from "../../orchestration/mass-ulw.js";
import { createE2eScreenshotShare } from "../../e2e/screenshot-share.js";
import { addToolCallProof } from "../tool-proof.js";
import { recordRegisteredToolSchemas } from "../runtime-schema-health.js";
import { isToolListedForProfiles, resolveToolProfiles } from "../tool-profiles.js";
import { createE2eScreenshotPreview } from "../../e2e/local-e2e.js";
import { resolveInProject } from "../../policy/paths.js";
import { isSecretPath, redact } from "../../policy/secrets.js";
import { resolveActiveProject } from "../../workspace/active.js";
import { buildActiveRoleContext, enforceActiveRoleToolAccess, type RoleTaskMode } from "../../roles/roles.js";
import { CONTROL_TOOL_NAMES, isControlChatGptExposed, isControlChatGptExposedForContext } from "../../control/policy.js";
import { dispatchExecutorJob, getExecutorProjectRegistry, listExecutorStatus, resolveRoutedLocalProject } from "../../executors/broker.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { buildTaskSafetyGate, makeDefaultTaskSafety, mergeTaskSafety, type TaskExecutionSafety, type TaskExecutionKind } from "../task-safety.js";

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Shape persisted in sessions.json (PRD §10) — mirrors state/store.ts SessionDocument. */
export interface RecentWorkFile {
  path: string;
  fileHash: string | null;
  lastAction: "read" | "edit" | "create" | "delete" | "move";
  lastTouchedAt: number;
  start?: number;
  end?: number;
}

export interface MutationFileSummary {
  path: string;
  action: "add" | "update" | "delete" | "move" | "create";
  added?: number;
  removed?: number;
}

export interface LastMutation {
  checkpointId: string;
  tool: "file_apply_patch" | "file_create";
  files: MutationFileSummary[];
  at: number;
}

export interface LastVerification {
  tool: "command_run" | "local_shell_run" | "e2e_run_command" | "e2e_test_and_show_screenshot";
  command: string;
  success: boolean;
  exitCode: number | null;
  durationMs: number | null;
  at: number;
}

export interface TaskDecision {
  summary: string;
  rationale: string | null;
  at: number;
}

export interface TaskContinuation {
  jobId: string;
  status: "waiting-approval" | "running" | "ready-to-resume" | "blocked" | "denied";
  updatedAt: number;
  deliveredAt?: number;
  resultRevision?: string;
  deliveryToken?: string;
}

export interface TaskState {
  loopRevision?: number;
  lifecycle?: "active" | "yielded" | "reasoning-needed" | "blocked" | "succeeded";
  goalId: string | null;
  loopId: string | null;
  currentGoal: string | null;
  currentTask: string | null;
  lastProgressSummary: string | null;
  completed: string[];
  pending: string[];
  decisions: TaskDecision[];
  continuation: TaskContinuation | null;
  executionSafety: TaskExecutionSafety;
  updatedAt: number;
}

export function isReleaseShellCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();
  return (
    /(?:^|[;&|]\s*)wrangler(?:\.cmd)?\s+(?:deploy|publish)\b/u.test(normalized) ||
    /(?:^|[;&|]\s*)(?:npm|pnpm)\s+publish\b/u.test(normalized) ||
    /(?:^|[;&|]\s*)yarn\s+npm\s+publish\b/u.test(normalized) ||
    /(?:^|[;&|]\s*)cargo\s+publish\b/u.test(normalized) ||
    /(?:^|[;&|]\s*)gh\s+release\s+(?:create|upload|edit|delete)\b/u.test(normalized) ||
    /(?:^|[;&|]\s*)docker\s+(?:push|buildx\s+build\b[^\r\n]*\s--push\b)/u.test(normalized)
  );
}

export interface WorkContext {
  projectId: string;
  workSessionId: string | null;
  activeArtifact: string | null;
  recentFiles: RecentWorkFile[];
  lastCheckpointId: string | null;
  lastMutation: LastMutation | null;
  lastVerification: LastVerification | null;
  taskState: TaskState;
  lastActivityAt: number;
}

export interface SessionState {
  version?: number;
  updatedAt?: number;
  activeProjectId: string | null;
  mode: ExecutionMode;
  lease: Lease | null;
  controlAllowlist: string[];
  workContexts: Record<string, WorkContext>;
  workSessions: Record<string, Record<string, WorkContext>>;
}

export function emptySession(): SessionState {
  return { activeProjectId: null, mode: "observe", lease: null, controlAllowlist: [], workContexts: {}, workSessions: {} };
}

export function coerceSessionState(raw: unknown): SessionState {
  if (!raw || typeof raw !== "object") return emptySession();
  const s = raw as Partial<SessionState>;
  return {
    activeProjectId: s.activeProjectId ?? null,
    mode: s.mode ?? "observe",
    lease: (s.lease as Lease | null | undefined) ?? null,
    controlAllowlist: Array.isArray(s.controlAllowlist)
      ? s.controlAllowlist.filter((entry): entry is string => typeof entry === "string")
      : [],
    workContexts: (s.workContexts as Record<string, WorkContext> | undefined) ?? {},
    workSessions: (s.workSessions as Record<string, Record<string, WorkContext>> | undefined) ?? {},
  };
}

export async function loadSession(ctx: ToolContext): Promise<SessionState> {
  return coerceSessionState(await ctx.store.getSession());
}

export async function saveSession(ctx: ToolContext, session: SessionState): Promise<void> {
  await ctx.store.setSession(session);
}

export async function updateSessionState(
  ctx: ToolContext,
  mutator: (current: SessionState) => SessionState | Promise<SessionState>,
): Promise<SessionState> {
  if (ctx.store.updateSession) {
    const updated = await ctx.store.updateSession(async (raw) => mutator(coerceSessionState(raw)));
    return coerceSessionState(updated);
  }
  // Compatibility fallback for lightweight test doubles/adapters that have
  // not implemented the atomic update API yet.
  const current = await loadSession(ctx);
  const next = await mutator(current);
  await saveSession(ctx, next);
  return next;
}

export function isMissingProjectFileError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT") return true;
  // Remote executor failures currently cross the broker as Error(message), so
  // preserve missing-file semantics when errno only survives in that message.
  return error instanceof Error && /\bENOENT\b/u.test(error.message);
}

export async function hashProjectFile(root: string, rel: string): Promise<string | null> {
  try {
    const abs = await resolveInProject(root, rel, { allowSymlink: false });
    const bytes = await fs.readFile(abs);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (err) {
    if (isMissingProjectFileError(err)) return null;
    throw err;
  }
}

export type WorkContextSlice = Omit<Awaited<ReturnType<typeof readSlice>>, "fullFileHash"> & { fullFileHash?: string; workContextFileHash?: string };

export async function hashWorkContextFile(
  ctx: ToolContext,
  entry: ProjectRegistryEntry,
  rel: string,
): Promise<string | null> {
  if (!isRemoteProject(entry)) return await hashProjectFile(entry.root, rel);
  try {
    const slice = await dispatchExecutorJob<WorkContextSlice>(
      ctx.stateDir,
      entry.executorId,
      "file_read_slice",
      remotePayload(entry, { path: rel, start: 1, end: 1 }),
    );
    return slice.fullFileHash ?? null;
  } catch (error) {
    if (isMissingProjectFileError(error)) return null;
    throw error;
  }
}

export function makeEmptyWorkContext(projectId: string, now = Date.now(), workSessionId: string | null = null): WorkContext {
  return {
    projectId,
    workSessionId,
    activeArtifact: null,
    recentFiles: [],
    lastCheckpointId: null,
    lastMutation: null,
    lastVerification: null,
    taskState: makeEmptyTaskState(now),
    lastActivityAt: now,
  };
}

export function createWorkSessionId(): string {
  return `ws_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export async function waitForExecutorReconnectCompletion(
  ctx: ToolContext,
  proof: LocalShellJobCompletionProof | null,
): Promise<void> {
  if (!proof || proof.kind !== "executor-reconnect") return;
  const deadline = Date.now() + Math.max(5_000, proof.timeoutMs);
  let observedInstanceId: string | null = null;
  let lastSeenAtMs = 0;
  let heartbeatCount = 0;
  while (Date.now() < deadline) {
    const executor = (await listExecutorStatus(ctx.stateDir)).find((candidate) => candidate.executorId === proof.executorId);
    const instanceId = executor?.instanceId?.trim() || null;
    const isReplacement = Boolean(instanceId) && (!proof.previousInstanceId || instanceId !== proof.previousInstanceId);
    const capabilitiesReady = (proof.requiredCapabilities ?? []).every((capability) => executor?.capabilities?.includes(capability as never));
    if (executor?.online && isReplacement && capabilitiesReady) {
      if (observedInstanceId !== instanceId) {
        observedInstanceId = instanceId;
        lastSeenAtMs = 0;
        heartbeatCount = 0;
      }
      if (executor.lastSeenAtMs > lastSeenAtMs) {
        lastSeenAtMs = executor.lastSeenAtMs;
        heartbeatCount += 1;
      }
      if (heartbeatCount >= Math.max(1, proof.requiredHeartbeats)) return;
    } else if (observedInstanceId && instanceId !== observedInstanceId) {
      observedInstanceId = null;
      lastSeenAtMs = 0;
      heartbeatCount = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new DomainError(
    ErrorCode.COMMAND_FAILED,
    `Runtime command returned but executor ${proof.executorId} did not prove a stable replacement instance`,
    { executorId: proof.executorId, previousInstanceId: proof.previousInstanceId, requiredHeartbeats: proof.requiredHeartbeats },
  );
}

export const WorkSessionIdSchema = z.string().regex(/^ws_[A-Za-z0-9_.-]+$/).max(120);
export const MAX_WORK_SESSIONS_PER_PROJECT = 20;

export function getWorkContext(
  session: SessionState,
  projectId: string,
  workSessionId?: string,
): WorkContext | null {
  if (workSessionId) {
    return session.workSessions[projectId]?.[workSessionId] ?? null;
  }
  return session.workContexts[projectId] ?? null;
}

export async function hasTaskNetworkVerificationApproval(
  ctx: ToolContext,
  projectId: string,
  workSessionId?: string,
  cwd?: string,
): Promise<boolean> {
  const session = await loadSession(ctx);
  const workContext = getWorkContext(session, projectId, workSessionId);
  const identity = taskApprovalIdentity({
    goalId: workContext?.taskState?.goalId,
    loopId: workContext?.taskState?.loopId,
    workSessionId: workSessionId ?? workContext?.workSessionId,
    leaseId: session.lease?.projectId === projectId && session.lease.expiresAt > Date.now() ? session.lease.leaseId : undefined,
  });
  if (!identity) return false;
  const entry = await resolveOrThrow(ctx, { projectId });
  return hasActiveTaskNetworkApproval(ctx.stateDir, { projectId, cwd,
    taskIdentity: targetApprovalIdentity(ExecutionTargetSchema.parse(entry.executionTarget), identity) });
}

export function findLoopContinuation(
  session: SessionState,
  projectId: string,
  input: { workSessionId?: string; goalHint?: string },
): { context: WorkContext; workSessionId?: string } | null {
  if (input.workSessionId) {
    const explicit = getWorkContext(session, projectId, input.workSessionId);
    return explicit?.taskState?.loopId ? { context: explicit, workSessionId: input.workSessionId } : null;
  }

  const ready = Object.values(session.workSessions[projectId] ?? {})
    .filter(
      (context) =>
        Boolean(context.taskState?.loopId) &&
        context.taskState?.continuation?.status === "ready-to-resume" &&
        !context.taskState?.continuation?.deliveredAt,
    )
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  if (ready) return { context: ready, workSessionId: ready.workSessionId ?? undefined };

  const readyLegacy = getWorkContext(session, projectId);
  if (
    readyLegacy?.taskState?.loopId &&
    readyLegacy.taskState.continuation?.status === "ready-to-resume" &&
    !readyLegacy.taskState.continuation?.deliveredAt
  ) {
    return { context: readyLegacy };
  }

  if (input.goalHint?.trim()) {
    const ranked = rankWorkSessions(session, projectId, input.goalHint, 3);
    const selected = chooseResumeCandidate(ranked).selected;
    if (selected?.workSessionId) {
      const matched = getWorkContext(session, projectId, selected.workSessionId);
      if (matched?.taskState?.loopId) return { context: matched, workSessionId: selected.workSessionId };
    }
    return null;
  }

  const recent = Object.values(session.workSessions[projectId] ?? {})
    .filter((context) => Boolean(context.taskState?.loopId))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  if (recent) return { context: recent, workSessionId: recent.workSessionId ?? undefined };

  const legacy = getWorkContext(session, projectId);
  return legacy?.taskState?.loopId ? { context: legacy } : null;
}

export function findLoopContextById(
  session: SessionState,
  projectId: string,
  loopId: string,
  workSessionId?: string,
): { context: WorkContext; workSessionId?: string } | null {
  if (workSessionId) {
    const explicit = getWorkContext(session, projectId, workSessionId);
    return explicit?.taskState?.loopId === loopId ? { context: explicit, workSessionId } : null;
  }

  const matched = Object.values(session.workSessions[projectId] ?? {})
    .filter((context) => context.taskState?.loopId === loopId)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  if (matched) return { context: matched, workSessionId: matched.workSessionId ?? undefined };

  const legacy = getWorkContext(session, projectId);
  return legacy?.taskState?.loopId === loopId ? { context: legacy } : null;
}

export function withWorkContext(
  session: SessionState,
  projectId: string,
  workSessionId: string | undefined,
  context: WorkContext,
): SessionState {
  if (!workSessionId) {
    return {
      ...session,
      workContexts: {
        ...session.workContexts,
        [projectId]: context,
      },
    };
  }
  const nextProjectSessions = {
    ...(session.workSessions[projectId] ?? {}),
    [workSessionId]: context,
  };
  const otherSessions = Object.entries(nextProjectSessions)
    .filter(([id]) => id !== workSessionId)
    .sort(([, a], [, b]) => b.lastActivityAt - a.lastActivityAt);
  const pinned = otherSessions.filter(([, context]) => Boolean(
    (context.taskState?.loopId && context.taskState.lifecycle !== "succeeded") ||
    (context.taskState?.continuation && !context.taskState.continuation.deliveredAt)));
  const retainedOthers = [...pinned, ...otherSessions.filter((item) => !pinned.includes(item))
    .slice(0, Math.max(0, MAX_WORK_SESSIONS_PER_PROJECT - 1 - pinned.length))];
  const retainedProjectSessions = Object.fromEntries([
    [workSessionId, context],
    ...retainedOthers,
  ]);
  return {
    ...session,
    workSessions: {
      ...session.workSessions,
      [projectId]: retainedProjectSessions,
    },
  };
}

export function normalizeSessionMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, " ")
    .trim();
}

export function scoreWorkSessionMatch(
  context: WorkContext,
  hint: string | undefined,
  now: number,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const ageMs = Math.max(0, now - context.lastActivityAt);
  if (ageMs <= 60 * 60 * 1000) {
    score += 30;
    reasons.push("active-within-1h");
  } else if (ageMs <= 24 * 60 * 60 * 1000) {
    score += 20;
    reasons.push("active-within-24h");
  } else if (ageMs <= 7 * 24 * 60 * 60 * 1000) {
    score += 10;
    reasons.push("active-within-7d");
  }

  const pendingCount = context.taskState?.pending?.length ?? 0;
  if (pendingCount > 0) {
    score += Math.min(10, pendingCount * 2);
    reasons.push("has-pending-work");
  }

  const normalizedHint = hint ? normalizeSessionMatchText(hint) : "";
  if (normalizedHint) {
    const searchable = normalizeSessionMatchText(
      [
        context.taskState?.currentGoal ?? "",
        context.taskState?.currentTask ?? "",
        context.activeArtifact ?? "",
      ].join(" "),
    );
    if (searchable.includes(normalizedHint)) {
      score += 80;
      reasons.push("full-hint-match");
    }
    const tokens = [...new Set(normalizedHint.split(/\s+/).filter((token) => token.length >= 2))];
    const matchedTokens = tokens.filter((token) => searchable.includes(token));
    if (matchedTokens.length > 0) {
      score += Math.min(60, matchedTokens.length * 15);
      reasons.push(`hint-token-match:${matchedTokens.length}/${tokens.length}`);
    }
  }

  return { score, reasons };
}

export interface RankedWorkSession {
  context: WorkContext;
  workSessionId: string | null;
  currentGoal: string | null;
  currentTask: string | null;
  activeArtifact: string | null;
  lastActivityAt: number;
  pendingCount: number;
  matchScore: number;
  matchReasons: string[];
}

export function rankWorkSessions(
  session: SessionState,
  projectId: string,
  hint: string | undefined,
  limit = 10,
): RankedWorkSession[] {
  const now = Date.now();
  return Object.values(session.workSessions[projectId] ?? {})
    .map((context) => {
      const match = scoreWorkSessionMatch(context, hint, now);
      return {
        context,
        workSessionId: context.workSessionId,
        currentGoal: context.taskState?.currentGoal ?? null,
        currentTask: context.taskState?.currentTask ?? null,
        activeArtifact: context.activeArtifact,
        lastActivityAt: context.lastActivityAt,
        pendingCount: context.taskState?.pending?.length ?? 0,
        matchScore: match.score,
        matchReasons: match.reasons,
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore || b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
}

export function hasHintMatch(candidate: RankedWorkSession | undefined): boolean {
  return Boolean(
    candidate?.matchReasons.some(
      (reason) => reason === "full-hint-match" || reason.startsWith("hint-token-match:"),
    ),
  );
}

export function chooseResumeCandidate(candidates: RankedWorkSession[]): {
  selected: RankedWorkSession | null;
  ambiguous: boolean;
  reason: string;
} {
  const first = candidates[0];
  if (!first || !hasHintMatch(first)) {
    return { selected: null, ambiguous: false, reason: "no-hint-match" };
  }
  const second = candidates[1];
  if (second && hasHintMatch(second) && first.matchScore - second.matchScore < 15) {
    return { selected: null, ambiguous: true, reason: "top-candidates-too-close" };
  }
  return { selected: first, ambiguous: false, reason: "confident-hint-match" };
}

export interface AhaMoment {
  label: "✦ Aha moment!";
  kind: "known-fix" | "work-session";
  hint: string;
  score: number;
  source: { knownFixId?: string; workSessionId?: string | null };
  caveat: "historical-memory-not-current-state";
}

export function historicalWorkSessionHint(context: WorkContext): string | null {
  const candidate =
    context.taskState.decisions.at(-1)?.summary ??
    context.taskState.lastProgressSummary ??
    context.taskState.completed.at(-1) ??
    context.taskState.currentTask ??
    context.taskState.currentGoal;
  const cleaned = candidate ? cleanTaskText(candidate, 600) : null;
  return cleaned ? redact(cleaned) : null;
}

export async function buildAhaMoments(
  ctx: ToolContext,
  projectId: string,
  goal: string,
  excludeWorkSessionId?: string,
): Promise<AhaMoment[]> {
  const [session, knownFixes] = await Promise.all([
    loadSession(ctx),
    new ProjectMemoryStore(ctx.stateDir).searchKnownFixes(projectId, goal, 3),
  ]);
  const moments: AhaMoment[] = knownFixes
    .filter((fix) => fix.score >= 4)
    .map((fix) => ({
      label: "✦ Aha moment!" as const,
      kind: "known-fix" as const,
      hint: redact(cleanTaskText(`${fix.title}: ${fix.solution}`, 700) ?? fix.title),
      score: fix.score + 20,
      source: { knownFixId: fix.id },
      caveat: "historical-memory-not-current-state" as const,
    }));

  for (const candidate of rankWorkSessions(session, projectId, goal, 5)) {
    if (!hasHintMatch(candidate) || candidate.workSessionId === excludeWorkSessionId) continue;
    const hint = historicalWorkSessionHint(candidate.context);
    if (!hint) continue;
    moments.push({
      label: "✦ Aha moment!",
      kind: "work-session",
      hint,
      score: candidate.matchScore,
      source: { workSessionId: candidate.workSessionId },
      caveat: "historical-memory-not-current-state",
    });
  }

  const seen = new Set<string>();
  return moments
    .sort((left, right) => right.score - left.score)
    .filter((moment) => {
      const key = normalizeSessionMatchText(moment.hint);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

export interface ResumeFileState extends RecentWorkFile {
  validated: boolean;
  currentHash: string | null;
  exists: boolean | null;
  stale: boolean | null;
}

export interface ResumeActiveSlice {
  path: string;
  start: number;
  end: number;
  rememberedStart: number;
  rememberedEnd: number;
  content: string;
  staleAtResume: boolean | null;
  currentHash: string | null;
  truncated: boolean;
}

export interface ResumeSnapshot {
  validationScope: "active" | "recent";
  validatedRecentFileCount: number;
  activeArtifact: string | null;
  activeArtifactStale: boolean | null;
  activePatchPreconditionHashes: Record<string, string> | null;
  recentFiles: ResumeFileState[];
  lastCheckpointId: string | null;
  lastMutation: LastMutation | null;
  lastVerification: LastVerification | null;
  taskState: TaskState;
  activeSlice: ResumeActiveSlice | null;
  activeSliceReason: string | null;
  lastActivityAt: number;
}

export const RESUME_HASH_CONCURRENCY = 4;

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function buildResumeSnapshot(
  ctx: ToolContext,
  entry: ProjectRegistryEntry,
  workContext: WorkContext,
  options: {
    includeActiveSlice?: boolean;
    maxActiveSliceLines?: number;
    validationScope?: "active" | "recent";
  } = {},
): Promise<ResumeSnapshot> {
  const validationScope = options.validationScope ?? "recent";
  const shouldValidate = (recent: RecentWorkFile): boolean =>
    validationScope === "recent" || recent.path === workContext.activeArtifact;
  const recentFiles = await mapWithConcurrency(
    workContext.recentFiles,
    RESUME_HASH_CONCURRENCY,
    async (recent): Promise<ResumeFileState> => {
      if (!shouldValidate(recent) || (options.includeActiveSlice && recent.path === workContext.activeArtifact && recent.start !== undefined && recent.end !== undefined)) {
        return {
          ...recent,
          validated: false,
          currentHash: null,
          exists: null,
          stale: null,
        };
      }
      const currentHash = await hashWorkContextFile(ctx, entry, recent.path);
      const verified = !isRemoteProject(entry) || currentHash !== null;
      return {
        ...recent,
        validated: verified,
        currentHash,
        exists: verified ? currentHash !== null : null,
        stale: verified ? currentHash !== recent.fileHash : null,
      };
    },
  );
  const active = recentFiles.find((file) => file.path === workContext.activeArtifact) ?? null;
  let activeSlice: ResumeActiveSlice | null = null;
  let activeSliceReason: string | null = null;
  if (options.includeActiveSlice) {
    if (!active) {
      activeSliceReason = "active-artifact-not-in-recent-files";
    } else if (active.exists === false) {
      activeSliceReason = "active-artifact-missing";
    } else if (active.start === undefined || active.end === undefined) {
      activeSliceReason = "no-remembered-line-range";
    } else {
      const maxLines = options.maxActiveSliceLines ?? 160;
      const requestedEnd = Math.min(active.end, active.start + maxLines - 1);
      let slice: WorkContextSlice | null;
      try {
      slice = isRemoteProject(entry)
        ? await (async () => {
            const abs = resolveRemotePathLexically(entry.root, active.path);
            await guardSecretPath(ctx, abs, "session_resume");
            return await dispatchExecutorJob<WorkContextSlice>(
              ctx.stateDir,
              entry.executorId,
              "file_read_slice",
              remotePayload(entry, { path: active.path, start: active.start, end: requestedEnd }),
            );
          })()
        : await (async () => {
            const abs = await resolveInProject(entry.root, active.path, { allowSymlink: false });
            await guardSecretPath(ctx, abs, "session_resume");
            return await readSlice(entry.root, active.path, active.start, requestedEnd);
          })();
      } catch (error) {
        if (!isMissingProjectFileError(error)) throw error;
        slice = null;
      }
      if (!slice) {
        active.validated = true; active.exists = false; active.stale = true;
        activeSliceReason = "active-artifact-missing";
      } else {
      active.currentHash = slice.fullFileHash ?? null;
      active.validated = Boolean(slice.fullFileHash);
      active.exists = true;
      active.stale = slice.fullFileHash ? slice.fullFileHash !== active.fileHash : null;
      if (!slice.fullFileHash) activeSliceReason = "unverified-worker-digest";
      activeSlice = {
        path: active.path,
        start: slice.start,
        end: slice.end,
        rememberedStart: active.start,
        rememberedEnd: active.end,
        content: redact(slice.content),
        staleAtResume: active.stale,
        currentHash: active.currentHash,
        truncated: requestedEnd < active.end,
      };
      }
    }
  }
  return {
    validationScope,
    validatedRecentFileCount: recentFiles.filter((file) => file.validated).length,
    activeArtifact: workContext.activeArtifact,
    activeArtifactStale: active?.stale ?? null,
    activePatchPreconditionHashes:
      active?.validated && active.exists === true && active.currentHash
        ? { [active.path]: active.currentHash }
        : null,
    recentFiles,
    lastCheckpointId: workContext.lastCheckpointId,
    lastMutation: workContext.lastMutation,
    lastVerification: workContext.lastVerification,
    taskState: workContext.taskState ?? makeEmptyTaskState(workContext.lastActivityAt),
    activeSlice,
    activeSliceReason,
    lastActivityAt: workContext.lastActivityAt,
  };
}

export function makeEmptyTaskState(now = Date.now()): TaskState {
  return {
    goalId: null,
    loopId: null,
    currentGoal: null,
    currentTask: null,
    lastProgressSummary: null,
    completed: [],
    pending: [],
    decisions: [],
    continuation: null,
    executionSafety: makeDefaultTaskSafety(),
    updatedAt: now,
  };
}

export function cleanTaskText(value: string, maxLength: number): string | null {
  const cleaned = redact(value).trim().slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

export function mergeUniqueTaskItems(existing: string[], additions: string[], maxItems = 50): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...existing, ...additions]) {
    const cleaned = cleanTaskText(raw, 500);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    merged.push(cleaned);
    if (merged.length >= maxItems) break;
  }
  return merged;
}

export async function recordTaskProgress(
  ctx: ToolContext,
  projectId: string,
  workSessionId: string | undefined,
  update: {
    goalId?: string;
    loopId?: string;
    currentGoal?: string;
    currentTask?: string;
    lastProgressSummary?: string;
    completed?: string[];
    pending?: string[];
    decisions?: Array<{ summary: string; rationale?: string }>;
    executionSafety?: Partial<TaskExecutionSafety>;
    inferredExecutionKind?: TaskExecutionKind;
  },
  persist = true,
): Promise<TaskState> {
  const now = Date.now();
  let recorded: TaskState | null = null;
  const apply = async (session: SessionState): Promise<SessionState> => {
    const current = getWorkContext(session, projectId, workSessionId) ?? makeEmptyWorkContext(projectId, now, workSessionId ?? null);
    const previousTask = current.taskState ?? makeEmptyTaskState(now);
    const previous = update.loopId && previousTask.loopId !== update.loopId ? makeEmptyTaskState(now) : previousTask;
    const appendedDecisions = (update.decisions ?? [])
      .map((decision) => ({
        summary: cleanTaskText(decision.summary, 500),
        rationale: decision.rationale === undefined ? null : cleanTaskText(decision.rationale, 1000),
        at: now,
      }))
      .filter((decision): decision is TaskDecision => decision.summary !== null);
    const decisionMap = new Map<string, TaskDecision>();
    for (const decision of [...previous.decisions, ...appendedDecisions]) {
      decisionMap.set(`${decision.summary}\n${decision.rationale ?? ""}`, decision);
    }
    const taskState: TaskState = {
      ...previous,
      goalId: update.goalId ?? previous.goalId,
      loopId: update.loopId ?? previous.loopId,
      currentGoal:
        update.currentGoal === undefined ? previous.currentGoal : cleanTaskText(update.currentGoal, 12000),
      currentTask:
        update.currentTask === undefined ? previous.currentTask : cleanTaskText(update.currentTask, 500),
      lastProgressSummary:
        update.lastProgressSummary === undefined
          ? previous.lastProgressSummary
          : cleanTaskText(update.lastProgressSummary, 1000),
      completed:
        update.completed === undefined
          ? previous.completed
          : mergeUniqueTaskItems(previous.completed, update.completed),
      pending:
        update.pending === undefined ? previous.pending : mergeUniqueTaskItems([], update.pending),
      decisions: [...decisionMap.values()].slice(-30),
      executionSafety: mergeTaskSafety(
        previous.executionSafety,
        update.executionSafety,
        update.inferredExecutionKind ?? "workspace",
      ),
      continuation: previous.continuation,
      updatedAt: now,
    };
    recorded = taskState;
    return withWorkContext(session, projectId, workSessionId, {
      ...current,
      taskState,
      lastActivityAt: now,
    });
  };
  if (persist) await updateSessionState(ctx, apply);
  else await apply(await loadSession(ctx));
  return recorded ?? makeEmptyTaskState(now);
}

export async function reconcileLoopProjection(
  ctx: ToolContext,
  projectId: string,
  workSessionId: string | undefined,
  task: TaskState,
  options: { clearContinuation?: boolean } = {},
): Promise<boolean> {
  const current = getWorkContext(await loadSession(ctx), projectId, workSessionId);
  const currentMatchesLoop = current?.taskState.loopId === task.loopId;
  if (
    currentMatchesLoop &&
    (current.taskState.loopRevision ?? 0) >= (task.loopRevision ?? 0) &&
    (!options.clearContinuation || current.taskState.continuation === null)
  ) return false;
  await updateSessionState(ctx, async (session) => {
    const context = getWorkContext(session, projectId, workSessionId) ?? makeEmptyWorkContext(projectId, task.updatedAt, workSessionId ?? null);
    // Job delivery belongs to the independently updated session, never the loop snapshot.
    // Once a loop succeeds, its old approval/job continuation is no longer
    // actionable and must not be re-attached to terminal or later status calls.
    const sameLoop = context.taskState.loopId === task.loopId;
    return withWorkContext(session, projectId, workSessionId, { ...context,
      taskState: {
        ...task,
        continuation: options.clearContinuation && sameLoop
          ? null
          : sameLoop ? context.taskState.continuation : null,
      },
      lastActivityAt: task.updatedAt,
    });
  });
  return true;
}

export async function recordTaskContinuation(
  ctx: ToolContext,
  projectId: string,
  workSessionId: string | undefined,
  continuation: TaskContinuation,
): Promise<void> {
  const now = Date.now();
  await updateSessionState(ctx, async (session) => {
    const current = getWorkContext(session, projectId, workSessionId);
    if (!current) return session;
    const previous = current.taskState ?? makeEmptyTaskState(now);
    return withWorkContext(session, projectId, workSessionId, {
      ...current,
      taskState: {
        ...previous,
        continuation: { ...continuation, updatedAt: now },
        updatedAt: now,
      },
      lastActivityAt: now,
    });
  });
}

export async function recordRecentWork(
  ctx: ToolContext,
  input: {
    projectId: string;
    path: string;
    fileHash: string | null;
    lastAction: RecentWorkFile["lastAction"];
    start?: number;
    end?: number;
    checkpointId?: string;
    workSessionId?: string;
  },
): Promise<void> {
  const now = Date.now();
  await updateSessionState(ctx, async (session) => {
    if (session.activeProjectId !== input.projectId) return session;
    const current = getWorkContext(session, input.projectId, input.workSessionId);
    const previousForPath = current?.recentFiles.find((file) => file.path === input.path);
    const entry: RecentWorkFile = {
      path: input.path,
      fileHash: input.fileHash,
      lastAction: input.lastAction,
      lastTouchedAt: now,
      ...(input.start !== undefined
        ? { start: input.start }
        : previousForPath?.start !== undefined
          ? { start: previousForPath.start }
          : {}),
      ...(input.end !== undefined
        ? { end: input.end }
        : previousForPath?.end !== undefined
          ? { end: previousForPath.end }
          : {}),
    };
    const recentFiles = [entry, ...(current?.recentFiles ?? []).filter((f) => f.path !== input.path)].slice(0, 20);
    const removesCurrentPath = input.lastAction === "delete" || input.lastAction === "move";
    const nextActiveArtifact =
      removesCurrentPath
        ? current?.activeArtifact === input.path
          ? (recentFiles.find((f) => f.lastAction !== "delete" && f.lastAction !== "move" && f.fileHash !== null)?.path ?? null)
          : (current?.activeArtifact ?? null)
        : input.path;
    return withWorkContext(session, input.projectId, input.workSessionId, {
      ...(current ?? makeEmptyWorkContext(input.projectId, now, input.workSessionId ?? null)),
      activeArtifact: nextActiveArtifact,
      recentFiles,
      lastCheckpointId: input.checkpointId ?? current?.lastCheckpointId ?? null,
      lastActivityAt: now,
    });
  });
}

export async function recordLastMutation(
  ctx: ToolContext,
  projectId: string,
  workSessionId: string | undefined,
  mutation: Omit<LastMutation, "at">,
): Promise<void> {
  const now = Date.now();
  await updateSessionState(ctx, async (session) => {
    if (session.activeProjectId !== projectId) return session;
    const current = getWorkContext(session, projectId, workSessionId) ?? makeEmptyWorkContext(projectId, now, workSessionId ?? null);
    return withWorkContext(session, projectId, workSessionId, {
      ...current,
      lastCheckpointId: mutation.checkpointId,
      lastMutation: { ...mutation, at: now },
      lastActivityAt: now,
    });
  });
}

export async function recordVerification(
  ctx: ToolContext,
  projectId: string,
  workSessionId: string | undefined,
  verification: Omit<LastVerification, "at">,
): Promise<void> {
  const now = Date.now();
  await updateSessionState(ctx, async (session) => {
    if (session.activeProjectId !== projectId) return session;
    const current = getWorkContext(session, projectId, workSessionId) ?? makeEmptyWorkContext(projectId, now, workSessionId ?? null);
    return withWorkContext(session, projectId, workSessionId, {
      ...current,
      lastVerification: { ...verification, at: now },
      lastActivityAt: now,
    });
  });
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

export async function currentRegistry(ctx: ToolContext): Promise<ProjectRegistryEntry[]> {
  if (ctx.registry.length === 0) {
    const loaded = await ctx.store.loadProjects();
    ctx.registry.splice(0, ctx.registry.length, ...loaded);
  }
  const tasks = await taskWorkspaceProjects(ctx.stateDir);
  const sourceEntries = ctx.registry.filter((entry) => !isTaskWorkspaceId(entry.projectId));
  ctx.registry.splice(0, ctx.registry.length, ...sourceEntries, ...tasks);
  const remote = await getExecutorProjectRegistry(ctx.stateDir, ctx.registry);
  return [...ctx.registry, ...remote];
}

export function toProject(entry: ProjectRegistryEntry): Project {
  return { ...entry };
}

export async function resolveExecutionProject(
  ctx: ToolContext,
  q: { projectId?: string; name?: string },
): Promise<ProjectRegistryEntry> {
  const entries = await currentRegistry(ctx);
  const result = findProject(entries, q);
  if (result.ok) {
    const entry = await resolveRoutedLocalProject(ctx.stateDir, result.entry, ctx.workspaceRoot);
    const target = ExecutionTargetSchema.parse(entry.executionTarget);
    return { ...entry, root: target.projectRoot, executionTarget: target };
  }
  if (result.reason === "ambiguous") {
    throw new DomainError(ErrorCode.AMBIGUOUS_PROJECT, "Multiple projects match", {
      candidates: (result.candidates ?? []).map((c) => c.projectId),
    });
  }
  throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project not found: ${q.projectId ?? q.name}`);
}

export function assertSelectedExecutionTarget(entry: ProjectRegistryEntry, lease: Lease): void {
  const saved = lease.leaseId.match(/:target:([a-f0-9]{64})$/u)?.[1];
  const actual = ExecutionTargetSchema.parse(entry.executionTarget);
  const matches = saved ? `target:${saved}` === targetApprovalIdentity(actual)
    : actual.kind === "local" && path.resolve(lease.projectRoot) === actual.projectRoot;
  if (!matches) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED,
    "Selected execution target changed; select the intended project again before executing", { expected: saved ?? lease.projectRoot, actual });
}

export function bindExecutionLease(lease: Lease, entry: ProjectRegistryEntry): Lease {
  const target = ExecutionTargetSchema.parse(entry.executionTarget);
  return { ...lease, projectRoot: target.projectRoot,
    leaseId: `${lease.leaseId.replace(/:target:[a-f0-9]{64}$/u, "")}:${targetApprovalIdentity(target)}` };
}

export function hasReconnectableWorkContext(session: SessionState, projectId: string): boolean {
  const contexts = [
    session.workContexts[projectId],
    ...Object.values(session.workSessions[projectId] ?? {}),
  ].filter((context): context is WorkContext => Boolean(context));
  return contexts.some((context) => {
    const task = context.taskState;
    return Boolean(
      context.projectId === projectId &&
      (task.goalId || task.loopId) &&
      task.lifecycle !== "succeeded",
    );
  });
}

export async function recoverRemoteReconnectLease(ctx: ToolContext, projectId: string): Promise<boolean> {
  if (!ctx.remote) return false;
  const snapshot = await loadSession(ctx);
  const expired = snapshot.lease;
  if (
    !expired ||
    snapshot.activeProjectId !== projectId ||
    expired.projectId !== projectId ||
    expired.preset === "control" ||
    Date.now() <= expired.expiresAt ||
    !hasReconnectableWorkContext(snapshot, projectId)
  ) return false;

  const entry = await resolveExecutionProject(ctx, { projectId });
  assertSelectedExecutionTarget(entry, expired);
  let recovered = false;
  await updateSessionState(ctx, (current) => {
    const currentLease = current.lease;
    if (
      !currentLease ||
      current.activeProjectId !== projectId ||
      currentLease.projectId !== projectId ||
      currentLease.leaseId !== expired.leaseId ||
      currentLease.preset === "control" ||
      Date.now() <= currentLease.expiresAt ||
      !hasReconnectableWorkContext(current, projectId)
    ) return current;
    recovered = true;
    return { ...current, lease: bindExecutionLease(makeLease(entry, currentLease.preset, leaseTtlMs(ctx)), entry) };
  });
  if (recovered) {
    await ctx.ledger.append({
      type: "project.lease.recovered",
      projectId,
      reason: "remote-reconnect",
      preset: expired.preset,
    });
  }
  return recovered;
}

export async function requireProjectLease(ctx: ToolContext, projectId: string, capability: LeaseCapability = "read"): Promise<Lease> {
  let lease: Lease;
  try {
    lease = await requireCapabilityLease(ctx, projectId, capability);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== ErrorCode.LEASE_REQUIRED || !(await recoverRemoteReconnectLease(ctx, projectId))) throw error;
    lease = await requireCapabilityLease(ctx, projectId, capability);
  }
  assertSelectedExecutionTarget(await resolveExecutionProject(ctx, { projectId }), lease);
  return slideActiveLease(ctx, projectId, lease);
}

export function leaseTtlMs(ctx: ToolContext): number {
  const configured = ctx.config.defaultLeaseTtlMs;
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LEASE_TTL_MS;
}

/** Extend a lease that is in active use; see slideLease for the policy. */
export async function slideActiveLease(ctx: ToolContext, projectId: string, lease: Lease): Promise<Lease> {
  const ttlMs = leaseTtlMs(ctx);
  if (!slideLease(lease, ttlMs)) return lease;
  let result = lease;
  await updateSessionState(ctx, (current) => {
    const stored = current.lease;
    if (!stored || stored.leaseId !== lease.leaseId || stored.projectId !== projectId) return current;
    const extended = slideLease(stored, ttlMs);
    if (!extended) return current;
    result = extended;
    return { ...current, lease: extended };
  });
  return result;
}

export async function resolveOrThrow(ctx: ToolContext, q: { projectId?: string; name?: string }): Promise<ProjectRegistryEntry> {
  const entry = await resolveExecutionProject(ctx, q);
  const session = await loadSession(ctx);
  if (session.lease?.projectId === entry.projectId) assertSelectedExecutionTarget(entry, session.lease);
  return entry;
}

export async function assertExecutionTarget(ctx: ToolContext, projectId: string, expected: ExecutionTarget | undefined): Promise<ProjectRegistryEntry> {
  const proof = ExecutionTargetSchema.safeParse(expected);
  if (!proof.success) throw new DomainError(ErrorCode.APPROVAL_RESUME_FAILED,
    "Execution target proof is missing or invalid; select the intended project and request fresh approval", { projectId });
  let actual: ProjectRegistryEntry;
  try {
    actual = await resolveExecutionProject(ctx, { projectId });
  } catch (error) {
    throw new DomainError(ErrorCode.APPROVAL_RESUME_FAILED,
      `Execution target unavailable; restore the approved host/project or request fresh approval: ${(error as Error).message}`,
      { projectId, expected: proof.data });
  }
  if (!sameExecutionTarget(proof.data, ExecutionTargetSchema.parse(actual.executionTarget))) throw new DomainError(ErrorCode.APPROVAL_RESUME_FAILED,
    "Execution target changed; select the intended host/project and request fresh approval",
    { projectId, expected: proof.data, actual: actual.executionTarget });
  return actual;
}

export async function localExecutionRoot(ctx: ToolContext, entry: ProjectRegistryEntry): Promise<string> {
  if (isRemoteProject(entry)) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED,
    "This operation requires an explicit local project route; it cannot execute on the selected worker", { executionTarget: entry.executionTarget });
  return (await assertExecutionTarget(ctx, entry.projectId, entry.executionTarget)).root;
}

export function isRemoteProject(entry: ProjectRegistryEntry): entry is ProjectRegistryEntry & { executorId: string } {
  return entry.executorKind === "remote" && typeof entry.executorId === "string" && entry.executorId.length > 0;
}

export function remotePayload(entry: ProjectRegistryEntry, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    sourceProjectId: entry.sourceProjectId ?? entry.projectId,
    executionTarget: ExecutionTargetSchema.parse(entry.executionTarget),
  };
}

export function remotePathApi(root: string): typeof path.win32 | typeof path.posix {
  return /^[A-Za-z]:[\\/]/u.test(root) ? path.win32 : path.posix;
}

export function resolveRemotePathLexically(root: string, rel: string): string {
  const api = remotePathApi(root);
  if (!rel || api.isAbsolute(rel)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Remote git path must be project-relative", { path: rel });
  }
  const abs = api.resolve(root, rel);
  const relative = api.relative(root, abs);
  if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Remote git path escapes the project root", { path: rel });
  }
  return abs;
}

export function remoteNodeCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

export function parseRemoteJsonOutput<T>(stdoutSummary: string, label: string): T {
  const lines = stdoutSummary.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!) as T;
    } catch {
      // Keep scanning because git can emit informational lines before our final JSON record.
    }
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `${label} did not return structured JSON`);
}

// ---------------------------------------------------------------------------
// Error mapping — DomainError -> MCP tool error content
// ---------------------------------------------------------------------------

/** Success-path output already goes through redact() (see the tool handlers
 * above); the error path must too, or a raw thrown error message (e.g. a
 * git/exec error that happens to echo secret material from local state
 * rather than from the model's own input) reaches both the permanent ledger
 * `error` field and the untrusted-model-facing tool result unredacted. */
export function mapError(err: unknown): ToolResult<{
  error: string;
  code: string;
  details?: unknown;
  approvalId?: string;
  jobId?: string;
  approvalReused?: string;
  approvalRequired?: boolean;
  approvalPending?: boolean;
  approvalInstruction?: string;
}> {
  if (err instanceof DomainError) {
    const safeMessage = redact(err.message);
    const safeDetails = redactUnknown(err.details);
    const safeDetailsRecord = safeDetails && typeof safeDetails === "object"
      ? safeDetails as Record<string, unknown>
      : null;
    const rawDetailsRecord = err.details && typeof err.details === "object"
      ? err.details as Record<string, unknown>
      : null;
    const correlationId = (value: unknown): string | undefined =>
      typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
    const approvalId = correlationId(rawDetailsRecord?.approvalId);
    const jobId = correlationId(rawDetailsRecord?.jobId);
    const approvalRequired = err.code === ErrorCode.APPROVAL_REQUIRED;
    const approvalPending = Boolean(
      approvalRequired &&
      err.details !== null &&
      typeof err.details === "object" &&
      "approvalId" in err.details &&
      typeof (err.details as { approvalId?: unknown }).approvalId === "string" &&
      (err.details as { approvalId: string }).approvalId.length > 0,
    );
    return makeResult(
      {
        error: safeMessage,
        code: err.code,
        details: safeDetails,
        ...(approvalId ? { approvalId } : {}),
        ...(jobId ? { jobId } : {}),
        ...(typeof safeDetailsRecord?.approvalReused === "string" ? { approvalReused: safeDetailsRecord.approvalReused } : {}),
        approvalRequired,
        approvalPending,
        approvalInstruction: approvalPending
          ? "A real JK Control Center approval is pending. Only now may the assistant ask the user to approve it."
          : approvalRequired
            ? "No pending JK Control Center approval record was proven. Do not tell the user that an approval is waiting or ask them to approve anything."
            : "This error is not an approval request. Do not tell the user that an approval is waiting.",
      },
      `Error [${err.code}]: ${safeMessage}`,
      true,
    );
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = redact(rawMessage);
  return makeResult(
    { error: message, code: ErrorCode.NOT_IMPLEMENTED },
    `Error: ${message}`,
    true,
  );
}

/** Plain-object shape matching the MCP SDK's `CallToolResult` wire type. */
export interface CallToolResultLike {
  content: ToolResult["content"];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export const LOCAL_STATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export const LOCAL_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

export const COMMAND_RUN_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

export const E2E_ONE_SHOT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Desktop-control tools synthesize input on the operator's Mac; even
 * computer_screenshot is marked non-read-only/destructive because it is
 * gated the same way (control lease) and never exposed to ChatGPT. */
export const CONTROL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

export const CHATGPT_SAFETY_HIDDEN_TOOL_NAMES = new Set(["code_context_pack"]);

export const JK_SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;
export const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object",
  properties: {},
  "$schema": "http://json-schema.org/draft-07/schema#",
} as const;

export interface RegisteredToolLike {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
  enabled?: boolean;
  _meta?: Record<string, unknown>;
}

export function chatGptToolMeta(invoking: string, invoked: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    securitySchemes: JK_SECURITY_SCHEMES,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
    ...(extra ?? {}),
  };
}

export function schemaToJsonSchema(schema: unknown, pipeStrategy: "input" | "output"): Record<string, unknown> {
  const obj = normalizeObjectSchema(schema as never);
  return obj
    ? (toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy }) as Record<string, unknown>)
    : { ...EMPTY_OBJECT_JSON_SCHEMA };
}

export function installChatGptToolListHandler(s: McpServer, ctx: ToolContext): void {
  const registeredTools = (s as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
  const listVisibleTools = (exposeControl: boolean) => {
    // Resolved per call so JK_TOOL_PROFILES changes apply without a restart.
    const profiles = resolveToolProfiles();
    return Object.entries(registeredTools)
      .filter(
        ([name, tool]) =>
          tool.enabled !== false &&
          !CHATGPT_SAFETY_HIDDEN_TOOL_NAMES.has(name) &&
          isToolListedForProfiles(name, profiles) &&
          (exposeControl || !CONTROL_TOOL_NAMES.has(name)),
      )
      .map(([name, tool]) => {
        const definition: Record<string, unknown> = {
          name,
          title: tool.title,
          description: tool.description,
          inputSchema: schemaToJsonSchema(tool.inputSchema, "input"),
          securitySchemes: JK_SECURITY_SCHEMES,
          annotations: tool.annotations,
          execution: tool.execution,
          _meta: {
            securitySchemes: JK_SECURITY_SCHEMES,
            ui: { visibility: ["model"] },
            "openai/visibility": "public",
            ...(tool._meta ?? {}),
          },
        };
        if (tool.outputSchema) definition.outputSchema = schemaToJsonSchema(tool.outputSchema, "output");
        return definition;
      });
  };
  s.server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Re-read at request time (not server-construction time) so tests/ops
    // toggling the env var or arming a control lease takes effect immediately.
    const tools = listVisibleTools(await isControlChatGptExposedForContext(ctx));
    recordRegisteredToolSchemas(tools.map((tool) => ({ name: String(tool.name), inputSchema: tool.inputSchema })));
    return { tools };
  });
  const tools = listVisibleTools(isControlChatGptExposed());
  recordRegisteredToolSchemas(tools.map((tool) => ({ name: String(tool.name), inputSchema: tool.inputSchema })));
}

/**
 * Adapt our internal `ToolResult` shape to the MCP SDK's `CallToolResult`
 * wire shape expected by `registerTool` callbacks (plain object + index
 * signature, rather than our narrower interface type).
 */
export function toCallToolResult(toolName: string, result: ToolResult<Record<string, unknown>>): CallToolResultLike {
  return {
    content: result.content,
    structuredContent: addToolCallProof(result.structuredContent, toolName, result.isError !== true),
    ...(result.isError ? { isError: true } : {}),
    ...(result._meta ? { _meta: result._meta } : {}),
  };
}

export async function attachCompactActiveRoleContext<T extends Record<string, unknown>>(
  ctx: ToolContext,
  input: unknown,
  result: ToolResult<T>,
): Promise<ToolResult<Record<string, unknown>>> {
  const structured = result.structuredContent as Record<string, unknown>;
  if (structured.activeRoleContext) return result as ToolResult<Record<string, unknown>>;

  let projectId: string | null = null;
  if (input && typeof input === "object") {
    const candidate = (input as { projectId?: unknown }).projectId;
    if (typeof candidate === "string" && candidate.trim()) projectId = candidate;
  }
  if (!projectId) {
    const session = await loadSession(ctx);
    projectId = session.activeProjectId ?? null;
  }
  if (!projectId) return result as ToolResult<Record<string, unknown>>;

  try {
    const active = await buildActiveRoleContext(ctx, projectId);
    return {
      ...result,
      structuredContent: {
        ...structured,
        activeRoleContext: {
          projectId: active.projectId,
          projectName: active.projectName,
          role: { id: active.role.id, name: active.role.name },
          selectionSource: active.selectionSource,
          projectPermission: active.projectPermission,
          rolePermission: active.rolePermission,
          effectivePermission: active.effectivePermission,
        },
      },
    };
  } catch {
    return result as ToolResult<Record<string, unknown>>;
  }
}

export function continuationProjectId(input: unknown, session: SessionState): string | null {
  if (input && typeof input === "object") {
    const candidate = (input as { projectId?: unknown }).projectId;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return session.activeProjectId ?? null;
}

export function isDeliverableContinuation(continuation: TaskContinuation | null | undefined): continuation is TaskContinuation {
  return Boolean(
    continuation &&
      !continuation.deliveredAt &&
      ["ready-to-resume", "blocked", "denied"].includes(continuation.status),
  );
}

export function continuationStatusForJob(
  job: Awaited<ReturnType<typeof readLocalShellJob>>,
  now = Date.now(),
): TaskContinuation["status"] | null {
  if (!job) return null;
  if (job.status === "pending") return job.expiresAt <= now ? null : "waiting-approval";
  if (job.status === "expired") return null;
  if (job.status === "running") return "running";
  if (job.status === "succeeded") return "ready-to-resume";
  if (job.status === "denied") return "denied";
  return "blocked";
}

export async function takeTaskContinuationNotice(
  ctx: ToolContext,
  input: unknown,
  consume = true,
): Promise<Record<string, unknown> | null> {
  let notice: Record<string, unknown> | null = null;
  const quarantinedJobIds = new Set<string>();
  const select = async (session: SessionState): Promise<SessionState> => {
    const projectId = continuationProjectId(input, session);
    if (!projectId) return session;

    const selection = z.object({
      loopId: z.string().optional(), workSessionId: z.string().nullable().optional(), goalId: z.string().nullable().optional(),
      acknowledgeResult: z.object({ jobId: z.string(), resultRevision: z.string(), deliveryToken: z.string() }).optional(),
    }).parse(input);
    const requestedWorkSessionId = selection.workSessionId;
    const candidates: Array<{ context: WorkContext; workSessionId?: string }> = [];
    if (selection.loopId) {
      const explicit = findLoopContextById(session, projectId, selection.loopId, requestedWorkSessionId ?? undefined);
      if (explicit && (requestedWorkSessionId === undefined || (explicit.workSessionId ?? null) === requestedWorkSessionId)) {
        candidates.push(explicit);
      }
    } else if (requestedWorkSessionId) {
      const explicit = getWorkContext(session, projectId, requestedWorkSessionId);
      if (explicit) candidates.push({ context: explicit, workSessionId: requestedWorkSessionId });
    } else if (!consume) {
      for (const context of Object.values(session.workSessions[projectId] ?? {})) {
        candidates.push({ context, workSessionId: context.workSessionId ?? undefined });
      }
      const legacy = getWorkContext(session, projectId);
      if (legacy) candidates.push({ context: legacy });
      candidates.sort(
        (a, b) =>
          (b.context.taskState?.continuation?.updatedAt ?? b.context.lastActivityAt) -
          (a.context.taskState?.continuation?.updatedAt ?? a.context.lastActivityAt),
      );
    }

    let nextSession = session;
    for (const candidate of candidates) {
      const task = candidate.context.taskState;
      const continuation = task?.continuation;
      if (!task || !continuation) continue;
      const ownerSessionId = candidate.workSessionId ?? null;
      if (candidate.context.projectId !== projectId || candidate.context.workSessionId !== ownerSessionId ||
          (selection.loopId !== undefined && task.loopId !== selection.loopId) ||
          (selection.goalId !== undefined && task.goalId !== selection.goalId)) continue;

      let job: Awaited<ReturnType<typeof readLocalShellJob>>;
      try {
        job = await readLocalShellJob(ctx.stateDir, continuation.jobId);
      } catch (error) {
        if (!(error instanceof LocalShellJobReadError) || error.reason !== "invalid-record" || error.jobId !== continuation.jobId) throw error;
        if (consume) {
          await quarantineInvalidLocalShellJob(ctx.stateDir, error);
          quarantinedJobIds.add(continuation.jobId);
          nextSession = withWorkContext(nextSession, projectId, candidate.workSessionId, {
            ...candidate.context,
            taskState: { ...task, continuation: null, updatedAt: Date.now() },
          });
          await ctx.ledger.append({
            type: "local.job.invalid-quarantined",
            projectId,
            workSessionId: ownerSessionId,
            jobId: continuation.jobId,
          });
        }
        continue;
      }
      if (!job) {
        if (consume && quarantinedJobIds.has(continuation.jobId)) nextSession = withWorkContext(nextSession, projectId, candidate.workSessionId, {
          ...candidate.context,
          taskState: { ...task, continuation: null, updatedAt: Date.now() },
        });
        continue;
      }
      if (job.projectId !== projectId || (job.workSessionId ?? null) !== ownerSessionId ||
          !job.continuation || job.continuation.workSessionId !== ownerSessionId ||
          job.continuation.goalId !== task.goalId || job.continuation.loopId !== task.loopId) continue;
      const reconciledStatus = continuationStatusForJob(job);
      if (!reconciledStatus) {
        if (consume) nextSession = withWorkContext(nextSession, projectId, candidate.workSessionId, {
          ...candidate.context,
          taskState: { ...task, continuation: null, updatedAt: Date.now() },
        });
        continue;
      }

      const reconciledContinuation: TaskContinuation = reconciledStatus === continuation.status
        ? continuation
        : { ...continuation, status: reconciledStatus, updatedAt: Date.now(), deliveredAt: undefined };
      if (!isDeliverableContinuation({ ...reconciledContinuation, deliveredAt: undefined })) {
        if (consume && reconciledContinuation !== continuation) {
          nextSession = withWorkContext(nextSession, projectId, candidate.workSessionId, {
            ...candidate.context,
            taskState: { ...task, continuation: reconciledContinuation, updatedAt: Date.now() },
          });
        }
        continue;
      }

      const resultRevision = createHash("sha256").update(JSON.stringify({ status: job.status, finishedAt: job.finishedAt,
        exitCode: job.exitCode, stdout: job.stdoutSummary, stderr: job.stderrSummary, error: job.error, durationMs: job.durationMs })).digest("hex");
      const deliveryToken = createHash("sha256").update(JSON.stringify([projectId, ownerSessionId, task.goalId, task.loopId, job.id, resultRevision])).digest("hex");
      if (selection.acknowledgeResult) {
        const ack = selection.acknowledgeResult;
        if (ack.jobId !== job.id || ack.resultRevision !== resultRevision || ack.deliveryToken !== deliveryToken) {
          throw new GoalLoopResumeError(task.loopId ?? "unknown", "Result acknowledgement does not match the current owner/job/revision");
        }
        if (continuation.deliveredAt && continuation.resultRevision === resultRevision) return session;
        return withWorkContext(session, projectId, candidate.workSessionId, { ...candidate.context,
          taskState: { ...task, continuation: { ...reconciledContinuation, resultRevision, deliveryToken, deliveredAt: Date.now() } } });
      }
      if (continuation.deliveredAt && continuation.resultRevision === resultRevision) continue;
      const deliveredAt = null;
      const commandPreview = redact(job.command).slice(0, 800);
      const recoveryInstruction =
        reconciledContinuation.status === "ready-to-resume"
          ? "Continue this prior task without asking the user to repeat context. Prefer goal_loop with the supplied loopId/workSessionId."
          : reconciledContinuation.status === "blocked"
            ? "The approved job failed. Diagnose the supplied result and continue recovery without asking the user to restate the task."
            : "The owner denied the prior job. Do not silently retry the same risky action; continue with a safer alternative or wait for an explicit new request.";
      notice = {
        deliveryToken,
        resultRevision,
        projectId,
        workSessionId: candidate.workSessionId ?? candidate.context.workSessionId ?? null,
        goalId: task.goalId,
        loopId: task.loopId,
        currentGoal: task.currentGoal,
        currentTask: task.currentTask,
        lastProgressSummary: task.lastProgressSummary,
        pending: task.pending,
        continuationStatus: reconciledContinuation.status,
        jobResult: {
          jobId: job.id,
          status: job.status,
          commandPreview,
          exitCode: job.exitCode ?? null,
          stdoutSummary: job.stdoutSummary ? redact(job.stdoutSummary).slice(0, 4000) : null,
          stderrSummary: job.stderrSummary ? redact(job.stderrSummary).slice(0, 4000) : null,
          error: job.error ? redact(job.error).slice(0, 2000) : null,
          durationMs: job.durationMs ?? null,
          finishedAt: job.finishedAt ?? null,
        },
        deliveredAt,
        instruction: `${recoveryInstruction} This notice does not grant permission for any new risky action; normal approval checks still apply.`,
      };
      return nextSession;
    }
    if (selection.acknowledgeResult) throw new GoalLoopResumeError(selection.loopId ?? "unknown", "No matching owned job result to acknowledge");
    return nextSession;
  };
  const current = await loadSession(ctx);
  const selected = await select(current);
  // A repeated acknowledgement and a read are byte-stable. Revalidate any
  // actual delivery-state change inside the existing atomic session update.
  if (consume && selected !== current) await updateSessionState(ctx, select);
  return notice;
}

export async function attachTaskContinuationNotice<T extends Record<string, unknown>>(
  ctx: ToolContext,
  input: unknown,
  result: ToolResult<T>,
  consume = true,
  exposure: "full" | "compact" = consume ? "full" : "compact",
): Promise<ToolResult<Record<string, unknown>>> {
  const notice = await takeTaskContinuationNotice(ctx, input, consume);
  if (!notice) return result as ToolResult<Record<string, unknown>>;
  const status = String(notice.continuationStatus ?? "ready-to-resume");
  const loopId = typeof notice.loopId === "string" ? notice.loopId : "unknown";
  const exposedNotice = exposure === "full"
    ? notice
    : {
        projectId: notice.projectId,
        workSessionId: notice.workSessionId,
        goalId: notice.goalId,
        loopId: notice.loopId,
        continuationStatus: notice.continuationStatus,
        instruction:
          "A prior task continuation is available. Resume the supplied loop/work-session with goal_loop to receive the full approved job result.",
      };
  return {
    ...result,
    structuredContent: {
      ...(result.structuredContent as Record<string, unknown>),
      taskContinuation: exposedNotice,
    },
    content: [
      ...result.content,
      {
        type: "text",
        text: exposure === "full"
          ? `[JK task continuation] ${status}; loopId=${loopId}. Prior approved job result is attached as structuredContent.taskContinuation. Continue from it without asking the user to repeat context.`
          : `[JK task continuation] ${status}; loopId=${loopId}. Resume this loop with goal_loop for the full approved job result.`,
      },
    ],
  };
}

export function continuationExposureFromInput(input: unknown): "full" | "compact" {
  if (!input || typeof input !== "object") return "compact";
  return (input as { continuationDetail?: unknown }).continuationDetail === "full" ? "full" : "compact";
}

export async function withErrorMapping<T extends Record<string, unknown>>(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  fn: () => Promise<ToolResult<T>>,
): Promise<CallToolResultLike> {
  let workspaceLock: { release(): Promise<void> } | undefined;
  let publishedTask = false;
  let taskProjectId: string | undefined;
  try {
    await currentRegistry(ctx);
    if (toolName !== "task_workspace" && toolName !== "mass_ulw_step") {
      const selected = input && typeof input === "object" ? (input as { projectId?: unknown }).projectId : undefined;
      const session = await loadSession(ctx);
      const projectId = typeof selected === "string" && selected !== "@active" ? selected : session.activeProjectId;
      if (projectId && isTaskWorkspaceId(projectId)) {
        const workspaces = new TaskWorkspaceStore(ctx.stateDir);
        workspaceLock = await workspaces.acquire(projectId);
        taskProjectId = projectId;
        const workspace = await workspaces.load(projectId);
        publishedTask = workspace.status === "published";
        const suppliedSession = (input as { workSessionId?: string }).workSessionId;
        if (suppliedSession && suppliedSession !== workspace.workSessionId) {
          throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "workSessionId does not belong to this task workspace");
        }
        if (publishedTask && toolName === "goal_loop") {
          // Publication removes the task's registry entry and lease. A receipt
          // acknowledgement must never enter the mutable loop/role/notice path.
          const acknowledgement = z.object({
            projectId: z.literal(projectId), workSessionId: z.literal(workspace.workSessionId),
            loopId: z.string().min(1), phase: z.literal("release"),
            verificationStatus: z.literal("pass"), reviewVerdict: z.literal("approve"),
            pending: z.array(z.never()).length(0),
          }).strict().safeParse(Object.fromEntries(Object.entries(z.record(z.unknown()).parse(input)).filter(([, value]) => value !== undefined)));
          if (!acknowledgement.success) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY,
            "Published tasks accept only an explicit existing loop/session release/pass/approve acknowledgement with pending=[] and no progress changes");
          const { loopId, workSessionId } = acknowledgement.data;
          const persistedSession = await loadSession(ctx);
          const taskState = findLoopContextById(persistedSession, projectId, loopId, workSessionId)?.context.taskState;
          if (!taskState) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "No matching persisted task loop/session for acknowledgement");
          const persistedLoop = z.object({ loopId: z.literal(loopId), projectId: z.literal(projectId),
            workSessionId: z.literal(workSessionId), turns: z.array(z.unknown()) }).safeParse(
            JSON.parse(await fs.readFile(path.join(ctx.stateDir, "goals", `${loopId}.loop.json`), "utf8")),
          );
          if (!persistedLoop.success) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Persisted loop identity does not match the published task");
          const safetyGate = buildTaskSafetyGate(taskState.executionSafety);
          const terminal = safetyGate.terminalReady && taskState.executionSafety.operationalDrift.length === 0 && taskState.pending.length === 0;
          const result = makeResult({ projectId, workSessionId, loopId, goalId: taskState.goalId,
            taskState, safety: taskState.executionSafety, safetyGate,
            terminal, terminalStatus: terminal ? "succeeded" : null, continueRequired: !terminal,
            terminalBlockedBySafety: !terminal, terminalPushResult: null,
            nextActions: terminal ? [] : [
              `Source is published, but stored completion gates remain: ${[...safetyGate.terminalBlockers, ...taskState.pending].join(", ")}. Publication is not runtime/deployment proof.`,
              "Inspect task_workspace status; preserve this receipt and continue outstanding safety/runtime work in an explicitly selected source project or a new task. Published task progress is read-only.",
            ],
          }, terminal ? "Published source delivery acknowledged." : "Source delivery acknowledged; outstanding safety/progress gates prevent completion.");
          await ctx.ledger.append({ type: "tool.call.completed", tool: toolName, input: redactUnknown(input), isError: false });
          return toCallToolResult(toolName, result);
        }
        await workspaces.assertActive(projectId);
      }
    }
    await enforceActiveRoleToolAccess(ctx, toolName, input);
    const rawResult = await fn();
    const stableTerminal = toolName === "goal_loop" && rawResult.structuredContent.terminal === true;
    const toolResult = stableTerminal ? rawResult : await attachCompactActiveRoleContext(ctx, input, rawResult);
    const resolvedLoop = toolName === "goal_loop" && !toolResult.isError
      ? z.object({ projectId: z.string(), loopId: z.string(), workSessionId: z.string().nullable(),
          taskState: z.object({ goalId: z.string().nullable(), loopId: z.string().nullable() }),
        }).safeParse(toolResult.structuredContent)
      : null;
    const result = toolName === "goal_loop"
      ? resolvedLoop?.success && resolvedLoop.data.loopId === resolvedLoop.data.taskState.loopId
        ? await attachTaskContinuationNotice(ctx, { ...resolvedLoop.data, goalId: resolvedLoop.data.taskState.goalId }, toolResult, false, "full")
        : toolResult
      : await attachTaskContinuationNotice(ctx, input, toolResult, false, continuationExposureFromInput(input));
    await ctx.ledger.append({
      type: "tool.call.completed",
      tool: toolName,
      input: redactUnknown(input),
      isError: result.isError ?? false,
    });
    return toCallToolResult(toolName, result);
  } catch (err) {
    const request = z.object({ projectId: z.string().optional(), workSessionId: z.string().optional(), action: z.string().optional() }).parse(input);
    const completionProjectId = taskProjectId ?? request.projectId;
    const completionError = completionProjectId && isTaskWorkspaceId(completionProjectId) &&
      (toolName === "goal_loop" || (toolName === "task_workspace" && request.action === "publish"));
    const errorResult = mapError(err);
    const result = completionError ? { ...errorResult, structuredContent: {
      ...errorResult.structuredContent, terminal: false, terminalStatus: null, terminalPushResult: null, continueRequired: true,
      nextCall: { toolName: "task_workspace", input: { action: "status", projectId: completionProjectId, workSessionId: request.workSessionId } },
      nextActions: [
        "Inspect task_workspace status and the error before continuing; no source-delivery completion has been recorded.",
        "For missing, failed or stale proof, call command_list, repair and task_workspace verify, then review the exact fresh diff before publish.",
        "If the source baseline changed, preserve both source and task edits and create a new task from the current baseline; do not blindly retry publication. Published tasks accept only a matching read-only acknowledgement.",
      ],
    } } : errorResult;
    // A rejected persisted resume must not reconcile or consume session state either.
    const mapped = publishedTask || toolName === "goal_loop" || err instanceof GoalLoopResumeError
      ? result : await attachTaskContinuationNotice(ctx, input, result, false, continuationExposureFromInput(input));
    await ctx.ledger.append({
      type: "tool.call.failed",
      tool: toolName,
      input: redactUnknown(input),
      code: mapped.structuredContent.code,
      error: mapped.structuredContent.error,
    });
    return toCallToolResult(toolName, mapped);
  } finally {
    await workspaceLock?.release();
  }
}

/** Best-effort redaction of tool input before it lands in the ledger. */
export function redactUnknown(input: unknown): unknown {
  try {
    const json = JSON.stringify(input);
    return JSON.parse(redact(json));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Lease enforcement for mutating tools
// ---------------------------------------------------------------------------
// requireProjectLease now lives in src/workspace/lease-guard.ts (imported
// above) so src/control/tools.ts can share the exact same preset ->
// capability table without importing this module (avoiding a cycle).

/** Whether a destination is confined to canonical or legacy project images. */
export function isWithinImagesDir(destRel: string | undefined): boolean {
  return !destRel || isProjectImagePath(destRel);
}

export function goalIdFor(goal: string): string {
  const digest = createHash("sha256").update(goal).digest("hex").slice(0, 8);
  return `goal-${Date.now()}-${digest}`;
}

export function loopIdFor(goal: string): string {
  const digest = createHash("sha256").update(goal).digest("hex").slice(0, 8);
  return `loop-${Date.now()}-${digest}`;
}

export type NativeOrchestrationPhase = "discover" | "plan" | "patch" | "verify" | "review" | "recovery" | "release";
export type NativeVerificationStatus = "unknown" | "pass" | "fail" | "blocked";
export type NativeReviewVerdict = "missing" | "approve" | "reject";
export type WorkflowStage = "explorer" | "oracle" | "implementer" | "reviewer" | "verifier" | "recovery";
export type NativeExecutionProfile = "auto" | "fast" | "max";
export type NativeCoordinationMode = "standard" | "dispatcher";
export const GOAL_LOOP_TELEMETRY_MAX_BYTES = 5 * 1024 * 1024;
export const GOAL_LOOP_TELEMETRY_KEEP_RECORDS = 5000;
export const GOAL_LOOP_TELEMETRY_REPORT_WINDOW = 200;

export type GoalLoopTelemetryRecord = {
  schemaVersion: 1;
  at: string;
  coordinationMode: NativeCoordinationMode;
  durationMs: number;
  responseBytes: number;
  turn: number;
  failureCount: number;
  retryCount: number;
  lifecycle: string;
};

export function summarizeGoalLoopTelemetry(records: GoalLoopTelemetryRecord[]) {
  const summarize = (mode: NativeCoordinationMode) => {
    const rows = records.filter((record) => record.coordinationMode === mode);
    const samples = rows.length;
    const average = (pick: (record: GoalLoopTelemetryRecord) => number) =>
      samples === 0 ? null : Math.round(rows.reduce((sum, record) => sum + pick(record), 0) / samples);
    const ratio = (pick: (record: GoalLoopTelemetryRecord) => boolean) =>
      samples === 0 ? null : Number((rows.filter(pick).length / samples).toFixed(4));
    return {
      samples,
      avgResponseBytes: average((record) => record.responseBytes),
      avgDurationMs: average((record) => record.durationMs),
      avgTurn: samples === 0 ? null : Number((rows.reduce((sum, record) => sum + record.turn, 0) / samples).toFixed(2)),
      failureRate: ratio((record) => record.failureCount > 0),
      retryRate: ratio((record) => record.retryCount > 0),
    };
  };
  const standard = summarize("standard");
  const dispatcher = summarize("dispatcher");
  const deltaPct = (dispatcherValue: number | null, standardValue: number | null) =>
    dispatcherValue === null || standardValue === null || standardValue === 0
      ? null
      : Number((((dispatcherValue - standardValue) / standardValue) * 100).toFixed(1));
  return {
    windowSize: GOAL_LOOP_TELEMETRY_REPORT_WINDOW,
    samples: records.length,
    standard,
    dispatcher,
    dispatcherVsStandard: {
      responseBytesDeltaPct: deltaPct(dispatcher.avgResponseBytes, standard.avgResponseBytes),
      durationDeltaPct: deltaPct(dispatcher.avgDurationMs, standard.avgDurationMs),
    },
  };
}
export type GoalLoopTelemetrySummary = ReturnType<typeof summarizeGoalLoopTelemetry>;

export function telemetrySuggestsStandardForBorderlineDispatcher(summary?: GoalLoopTelemetrySummary): boolean {
  if (!summary || summary.standard.samples < 20 || summary.dispatcher.samples < 20) return false;
  const standardFailure = summary.standard.failureRate ?? 0;
  const dispatcherFailure = summary.dispatcher.failureRate ?? 0;
  const standardRetry = summary.standard.retryRate ?? 0;
  const dispatcherRetry = summary.dispatcher.retryRate ?? 0;
  const durationDelta = summary.dispatcherVsStandard.durationDeltaPct;
  const payloadDelta = summary.dispatcherVsStandard.responseBytesDeltaPct;
  if (dispatcherFailure - standardFailure >= 0.05) return true;
  if (dispatcherRetry - standardRetry >= 0.05) return true;
  return durationDelta !== null && payloadDelta !== null && durationDelta >= 30 && payloadDelta > -10;
}

export async function readGoalLoopTelemetrySummary(stateDir: string) {
  try {
    const telemetryPath = path.join(stateDir, "telemetry", "goal-loop.jsonl");
    const raw = await fs.readFile(telemetryPath, "utf8");
    const records = raw.trim().split("\n").filter(Boolean).slice(-GOAL_LOOP_TELEMETRY_REPORT_WINDOW)
      .map((line) => JSON.parse(line) as GoalLoopTelemetryRecord);
    return summarizeGoalLoopTelemetry(records);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return summarizeGoalLoopTelemetry([]);
    }
    return { ...summarizeGoalLoopTelemetry([]), unavailable: true };
  }
}

export async function recordGoalLoopTelemetry(input: {
  ctx: ToolContext;
  startedAt: number;
  coordinationMode: NativeCoordinationMode;
  turn: number;
  failureCount: number;
  lifecycle: string;
  response: ToolResult;
}): Promise<void> {
  try {
    const telemetryDir = path.join(input.ctx.stateDir, "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true, mode: 0o700 });
    const record = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      coordinationMode: input.coordinationMode,
      durationMs: Math.max(0, Date.now() - input.startedAt),
      responseBytes: Buffer.byteLength(JSON.stringify(input.response), "utf8"),
      turn: input.turn,
      failureCount: input.failureCount,
      retryCount: Math.max(0, input.failureCount - 1),
      lifecycle: input.lifecycle,
    };
    const telemetryPath = path.join(telemetryDir, "goal-loop.jsonl");
    await fs.appendFile(
      telemetryPath,
      `${JSON.stringify(record)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const stat = await fs.stat(telemetryPath);
    if (stat.size > GOAL_LOOP_TELEMETRY_MAX_BYTES) {
      const raw = await fs.readFile(telemetryPath, "utf8");
      const retained = raw.trim().split("\n").filter(Boolean).slice(-GOAL_LOOP_TELEMETRY_KEEP_RECORDS);
      const tempPath = `${telemetryPath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, retained.length > 0 ? `${retained.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
      try {
        await renameWithRetry(tempPath, telemetryPath);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  } catch {
    // Telemetry is best-effort and must never block the coding loop.
  }
}

export type NativeFanoutCandidate = {
  id: string;
  task: string;
  estimatedWeight?: number;
  readScopes?: string[];
  writeScopes?: string[];
  dependsOn?: string[];
  exclusiveResources?: string[];
  latencyBound?: boolean;
};

export function normalizeFanoutScope(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

export function fanoutScopesOverlap(left: string, right: string): boolean {
  const a = normalizeFanoutScope(left);
  const b = normalizeFanoutScope(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function inferExecutionProfile(input: {
  requested?: NativeExecutionProfile;
  complexity: "low" | "medium" | "high";
  mode: "implement" | "research" | "debug" | "review" | "plan";
  text: string;
  pendingCount: number;
}) {
  const requested = input.requested ?? "auto";
  if (requested !== "auto") {
    return {
      requested,
      effective: requested,
      source: "explicit" as const,
      rationale: requested === "max"
        ? "Max was explicitly requested; optimize for wall-clock speed, verification coverage, and reduced rework while preserving hard safety guards."
        : "Fast was explicitly requested; keep the workflow narrow and avoid coordination overhead unless safety/recovery requires otherwise.",
    };
  }

  const text = input.text.toLowerCase();
  const maxIntent =
    /\b(max|maximum|full qa|full audit|comprehensive|end[- ]to[- ]end|e2e|regression|release|deploy|migration|refactor|audit)\b/i.test(text) ||
    /(끝까지|전체\s*qa|전체적으로|전부|빡세게|세게|최종까지|풀\s*qa|전체\s*검증|배포까지)/i.test(input.text);
  const fastIntent =
    /\b(fast|quick|tiny|typo|copy change|one[- ]file|small fix)\b/i.test(text) ||
    /(빠르게|간단히|오타|문구|버튼\s*글자|한\s*파일|작은\s*수정)/i.test(input.text);

  if (maxIntent || input.pendingCount >= 4 || (input.complexity === "high" && input.pendingCount >= 2)) {
    return {
      requested,
      effective: "max" as const,
      source: "auto" as const,
      rationale: "Auto detected a broad/high-impact task; prefer aggressive safe fan-out, wider verification coverage, and early failure discovery.",
    };
  }
  if (fastIntent || (input.complexity === "low" && input.pendingCount <= 1 && input.text.length <= 180 && input.mode !== "debug")) {
    return {
      requested,
      effective: "fast" as const,
      source: "auto" as const,
      rationale: "Auto detected a small/narrow task; avoid fan-out overhead and use one focused inspect/patch/verify path.",
    };
  }
  return {
    requested,
    effective: "auto" as const,
    source: "auto" as const,
    rationale: "Auto kept the balanced profile because the task is neither tiny nor broad enough to justify forcing Fast or Max.",
  };
}

export function inferTaskComplexity(input: {
  text: string;
  pendingCount: number;
  mode: "implement" | "research" | "debug" | "review" | "plan";
}): "low" | "medium" | "high" {
  let complexityScore = 0;
  if (input.text.length > 220) complexityScore += 1;
  if (input.pendingCount >= 3) complexityScore += 1;
  if (/architecture|refactor|migration|security|integration|end[- ]to[- ]end|multi[- ]file|cross[- ]module/i.test(input.text)) {
    complexityScore += 1;
  }
  if (input.mode === "plan" || input.mode === "debug") complexityScore += 1;
  return complexityScore >= 3 ? "high" : complexityScore >= 1 ? "medium" : "low";
}

export function inferCoordinationMode(input: {
  requested?: NativeCoordinationMode;
  existing?: NativeCoordinationMode;
  goal?: string;
  currentTask?: string;
  pending?: string[];
  mode?: "implement" | "research" | "debug" | "review" | "plan";
  phase?: NativeOrchestrationPhase;
  verificationStatus?: NativeVerificationStatus;
  turn?: number;
  telemetry?: GoalLoopTelemetrySummary;
}): NativeCoordinationMode {
  if (input.requested) return input.requested;
  if (input.existing) return input.existing;
  const mode = input.mode ?? "implement";
  const text = `${input.goal ?? ""} ${input.currentTask ?? ""}`.trim();
  const pendingCount = input.pending?.length ?? 0;
  const complexity = inferTaskComplexity({ text, pendingCount, mode });
  const phaseNeedsCoordination = input.phase === "verify" || input.phase === "review" || input.phase === "recovery" || input.phase === "release";
  const multiTurnShape = (input.turn ?? 1) > 1 || pendingCount >= 2;
  const verificationActive = input.verificationStatus !== undefined && input.verificationStatus !== "unknown";
  const hardDispatcher = complexity === "high" || phaseNeedsCoordination || multiTurnShape || verificationActive;
  if (hardDispatcher) return "dispatcher";
  if (complexity === "medium") {
    return telemetrySuggestsStandardForBorderlineDispatcher(input.telemetry) ? "standard" : "dispatcher";
  }
  return "standard";
}

export function buildLegacyMassUlwDecision(input: {
  complexity: "low" | "medium" | "high";
  mode: "implement" | "research" | "debug" | "review" | "plan";
  pendingCount: number;
  executionProfile: NativeExecutionProfile;
  candidates?: NativeFanoutCandidate[];
}) {
  const maxLanes = 4;
  const candidates = input.candidates ?? [];
  const shouldEvaluate =
    candidates.length === 0 &&
    input.pendingCount >= 2 &&
    input.executionProfile !== "fast" &&
    (input.executionProfile === "max" || input.complexity !== "low") &&
    input.mode !== "review" &&
    input.mode !== "plan";

  if (candidates.length === 0) {
    return {
      state: shouldEvaluate ? "evaluate" : "inactive",
      recommended: false,
      maxLanes,
      candidateCount: 0,
      netGain: 0,
      hardBlocks: [] as string[],
      rationale: shouldEvaluate
        ? `${input.executionProfile === "max" ? "Max profile favors early safe fan-out. " : ""}Multiple non-trivial pending tasks exist. Describe 2-4 candidate lanes with scopes/resources so JK can make a deterministic fan-out decision.`
        : input.executionProfile === "fast"
          ? "Fast profile keeps this turn single-lane to avoid coordination overhead."
          : "Mass ULW fan-out is not warranted from the current task shape.",
    };
  }

  const hardBlocks: string[] = [];
  if (candidates.length < 2) hardBlocks.push("fewer-than-two-lanes");
  if (candidates.length > maxLanes) hardBlocks.push(`lane-count-exceeds-${maxLanes}`);

  const ids = new Set(candidates.map((candidate) => candidate.id));
  if (ids.size !== candidates.length) hardBlocks.push("duplicate-lane-id");

  for (const candidate of candidates) {
    const internalDependency = (candidate.dependsOn ?? []).find((dependency) => ids.has(dependency));
    if (internalDependency) hardBlocks.push(`dependency:${candidate.id}->${internalDependency}`);
  }

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]!;
      const right = candidates[j]!;
      const leftWrites = left.writeScopes ?? [];
      const rightWrites = right.writeScopes ?? [];
      const leftReadsAndWrites = [...(left.readScopes ?? []), ...leftWrites];
      const rightReadsAndWrites = [...(right.readScopes ?? []), ...rightWrites];
      const scopeCollision =
        leftWrites.some((scope) => rightReadsAndWrites.some((other) => fanoutScopesOverlap(scope, other))) ||
        rightWrites.some((scope) => leftReadsAndWrites.some((other) => fanoutScopesOverlap(scope, other)));
      if (scopeCollision) hardBlocks.push(`scope-collision:${left.id}<->${right.id}`);

      const leftResources = new Set((left.exclusiveResources ?? []).map(normalizeFanoutScope).filter(Boolean));
      const resourceCollision = (right.exclusiveResources ?? [])
        .map(normalizeFanoutScope)
        .filter(Boolean)
        .some((resource) => leftResources.has(resource));
      if (resourceCollision) hardBlocks.push(`exclusive-resource:${left.id}<->${right.id}`);
    }
  }

  const weights = candidates.map((candidate) => Math.min(5, Math.max(1, candidate.estimatedWeight ?? 1)));
  const serialWork = weights.reduce((sum, weight) => sum + weight, 0);
  const criticalPathWork = Math.max(...weights, 0);
  const writeLaneCount = candidates.filter((candidate) => (candidate.writeScopes?.length ?? 0) > 0).length;
  const readOnlyLaneCount = candidates.filter((candidate) => (candidate.writeScopes?.length ?? 0) === 0).length;
  const verificationLaneCount = candidates.filter((candidate) =>
    /(test|qa|verify|verification|review|audit|regression|e2e|검증|테스트|회귀)/i.test(candidate.task),
  ).length;
  const unknownScopeCount = candidates.filter(
    (candidate) => (candidate.readScopes?.length ?? 0) === 0 && (candidate.writeScopes?.length ?? 0) === 0,
  ).length;
  const maxProfile = input.executionProfile === "max";
  const latencyBonus = candidates.filter((candidate) => candidate.latencyBound).length * (maxProfile ? 0.75 : 0.5);
  const coverageBonus = verificationLaneCount * (maxProfile ? 0.75 : 0.4);
  const readParallelBonus = readOnlyLaneCount * (maxProfile ? 0.4 : 0.2);
  const coordinationCost =
    (maxProfile ? 0.4 : 0.75) +
    Math.max(0, candidates.length - 2) * (maxProfile ? 0.2 : 0.35) +
    writeLaneCount * (maxProfile ? 0.25 : 0.35);
  const contextPollutionCost = candidates.length * 0.1 + unknownScopeCount * 0.35;
  const threshold = maxProfile ? 0.25 : 0.75;
  const netGain = Number(
    (serialWork - criticalPathWork + latencyBonus + coverageBonus + readParallelBonus - coordinationCost - contextPollutionCost).toFixed(2),
  );
  const policyBlocked = input.executionProfile === "fast";
  const recommended = !policyBlocked && hardBlocks.length === 0 && netGain >= threshold;

  return {
    state: recommended ? "fanout" : "sequential",
    recommended,
    maxLanes,
    candidateCount: candidates.length,
    serialWork,
    criticalPathWork,
    coordinationCost,
    latencyBonus,
    coverageBonus,
    readParallelBonus,
    contextPollutionCost,
    threshold,
    netGain,
    hardBlocks,
    lanes: candidates.map((candidate, index) => ({
      id: candidate.id,
      task: candidate.task,
      estimatedWeight: weights[index],
      readScopes: candidate.readScopes ?? [],
      writeScopes: candidate.writeScopes ?? [],
      dependsOn: candidate.dependsOn ?? [],
      exclusiveResources: candidate.exclusiveResources ?? [],
      latencyBound: candidate.latencyBound ?? false,
    })),
    rationale:
      hardBlocks.length > 0
        ? `Fan-out blocked by safety guard(s): ${hardBlocks.join(", ")}.`
        : policyBlocked
          ? "Fast profile keeps candidate lanes sequential to avoid coordination overhead."
        : recommended
          ? `Performance-first fan-out gain ${netGain} clears the ${input.executionProfile} threshold (>= ${threshold}) after coordination and context-pollution costs.`
          : `Performance-first fan-out gain ${netGain} does not clear the ${input.executionProfile} threshold (>= ${threshold}); keep the work sequential.`,
  };
}

export function buildMassUlwDecision(input: {
  complexity: "low" | "medium" | "high";
  mode: "implement" | "research" | "debug" | "review" | "plan";
  pendingCount: number;
  executionProfile: NativeExecutionProfile;
  candidates?: NativeFanoutCandidate[];
}) {
  if (!input.candidates || input.candidates.length === 0) {
    return buildLegacyMassUlwDecision(input);
  }
  return buildMassUlwPlan({ executionProfile: input.executionProfile, candidates: input.candidates });
}

export function recommendedLeasePreset(mode: RoleTaskMode, rolePermission?: string | null): LeasePreset {
  if (rolePermission === "read-only") return "read-only";
  if (rolePermission === "tests-only") return "tests-only";
  if (rolePermission === "image-only") return "image-only";
  if (rolePermission === "full-write") return "full-write";
  return mode === "research" || mode === "review" || mode === "plan" ? "read-only" : "full-write";
}

export function buildNativeOrchestration(input: {
  goal?: string;
  currentTask?: string;
  pending?: string[];
  mode?: "implement" | "research" | "debug" | "review" | "plan";
  phase?: NativeOrchestrationPhase;
  verificationStatus?: NativeVerificationStatus;
  reviewVerdict?: NativeReviewVerdict;
  failureCount?: number;
  turn?: number;
  executionProfile?: NativeExecutionProfile;
  coordinationMode?: NativeCoordinationMode;
  coordinationTelemetry?: GoalLoopTelemetrySummary;
  fanoutCandidates?: NativeFanoutCandidate[];
}) {
  const mode = input.mode ?? "implement";
  const verificationStatus = input.verificationStatus ?? "unknown";
  const reviewVerdict = input.reviewVerdict ?? "missing";
  const failureCount = Math.max(0, input.failureCount ?? 0);
  const text = `${input.goal ?? ""} ${input.currentTask ?? ""}`.trim();
  const pendingCount = input.pending?.length ?? 0;
  const complexity = inferTaskComplexity({ text, pendingCount, mode });
  const executionProfile = inferExecutionProfile({
    requested: input.executionProfile,
    complexity,
    mode,
    text,
    pendingCount,
  });
  const coordinationMode = inferCoordinationMode({
    requested: input.coordinationMode,
    goal: input.goal,
    currentTask: input.currentTask,
    pending: input.pending,
    mode,
    phase: input.phase,
    verificationStatus,
    turn: input.turn,
    telemetry: input.coordinationTelemetry,
  });
  const massUlw = buildMassUlwDecision({
    complexity,
    mode,
    pendingCount,
    executionProfile: executionProfile.effective,
    candidates: input.fanoutCandidates,
  });

  let phase: NativeOrchestrationPhase;
  if (failureCount >= 2 || verificationStatus === "blocked") phase = "recovery";
  else if (reviewVerdict === "reject") phase = "review";
  else if (input.phase) phase = input.phase;
  else if (verificationStatus === "fail") phase = "verify";
  else if (mode === "research") phase = "discover";
  else if (mode === "plan") phase = "plan";
  else if (mode === "review") phase = "review";
  else if ((input.turn ?? 1) <= 1) phase = "discover";
  else phase = "patch";

  const primaryStageByPhase: Record<NativeOrchestrationPhase, WorkflowStage> = {
    discover: "explorer",
    plan: "oracle",
    patch: "implementer",
    verify: "verifier",
    review: "reviewer",
    recovery: "recovery",
    release: "reviewer",
  };
  const supportingStagesByPhase: Record<NativeOrchestrationPhase, WorkflowStage[]> = {
    discover: complexity === "high" ? ["oracle", "reviewer"] : ["reviewer"],
    plan: ["explorer", "reviewer"],
    patch: ["explorer", "verifier"],
    verify: ["reviewer", "explorer"],
    review: ["verifier", "oracle"],
    recovery: ["oracle", "reviewer", "explorer"],
    release: ["verifier", "reviewer"],
  };
  const stageInstructions: Record<WorkflowStage, string> = {
    explorer: "Inspect the repository and evidence first; search/read before making claims or choosing a patch.",
    oracle: "Challenge assumptions, compare alternatives, and choose the smallest architecture or strategy that satisfies the goal.",
    implementer: "Make one coherent, scoped change using the current local context; do not broaden scope without evidence.",
    reviewer: "Review the proposed/current change for regressions, security, maintainability, and mismatch with the user's actual goal.",
    verifier: "Run the closest targeted verification and require evidence before declaring the slice complete.",
    recovery: "Stop repeating the same fix; preserve evidence, re-check the failing assumption, and switch to a materially different approach.",
  };

  let recoveryPolicy = "Proceed normally; verification must still pass before completion.";
  if (failureCount === 1) {
    recoveryPolicy = "First failure: inspect the exact failing output and the assumption behind the last change before editing again.";
  } else if (failureCount === 2) {
    recoveryPolicy = "Second failure: stop the current fix path, identify a root cause from fresh evidence, and only then try a materially different approach.";
  } else if (failureCount >= 3) {
    recoveryPolicy =
      "Three or more failures: stop editing, preserve the current diff/checkpoint evidence, and escalate beyond the local symptom to harness/environment/architecture assumptions before any further patch.";
  }

  return {
    engine: "jk-native",
    externalModelRequired: false,
    note: "Workflow stages are reasoning lenses for the current ChatGPT web session. User-selectable Roles are a separate permission/workflow-profile concept.",
    complexity,
    executionProfile,
    coordination: coordinationMode === "dispatcher"
      ? {
          mode: "dispatcher" as const,
          mainRole: "route-decide-summarize" as const,
          contextPolicy: "narrow" as const,
          rawOutputPolicy: "summary-only" as const,
          workerResultContract: {
            status: "success|partial|blocked",
            maxFindings: 8,
            maxRisks: 3,
            requireChangedSummary: true,
            requireVerificationSummary: true,
            requireNextAction: true,
            rawOutput: false,
          },
        }
      : {
          mode: "standard" as const,
          mainRole: "reason-and-execute" as const,
          contextPolicy: "normal" as const,
          rawOutputPolicy: "normal" as const,
        },
    phase,
    primaryStage: primaryStageByPhase[phase],
    supportingStages: supportingStagesByPhase[phase],
    stageInstructions,
    verificationStatus,
    reviewVerdict,
    failureCount,
    massUlw,
    verificationGate:
      mode === "research"
        ? "Ground conclusions in inspected local evidence; do not claim implementation work."
        : "Do not mark the slice complete until the closest relevant test/typecheck/build/E2E check passes or a real blocker is proven.",
    recoveryPolicy,
  };
}

export const E2E_SCRIPT_CANDIDATES = [
  "test:e2e",
  "e2e",
  "e2e:test",
  "test:playwright",
  "playwright",
  "test:ui",
  "test:browser",
  "cypress",
  "test",
] as const;

export const BUILD_SCRIPT_CANDIDATES = ["build", "typecheck", "lint"] as const;
export const DEV_SCRIPT_CANDIDATES = ["dev", "start", "serve", "preview"] as const;

export type E2eTargetKind = "web" | "desktop-app" | "generic";

export interface E2eAutomation {
  command?: string;
  commandSource: string;
  devCommand?: string;
  devSource?: string;
  devUrl?: string;
  devPort?: number;
  targetKind: E2eTargetKind;
  targetAppName?: string;
  targetAppPath?: string;
  scriptNames: string[];
}

// ---------------------------------------------------------------------------
// E2E screenshot delivery — ChatGPT Apps SDK widget + MCP image content
// ---------------------------------------------------------------------------

/**
 * ChatGPT ignores MCP image content blocks and strips markdown images from
 * connector tool results, so the only reliable way to show captured
 * screenshots inside ChatGPT is an Apps SDK widget: the tool declares
 * `openai/outputTemplate` pointing at this `ui://` resource, and ChatGPT
 * renders the HTML in a sandboxed iframe with the tool result exposed on
 * `window.openai`. Screenshots travel as data URIs in the result `_meta`
 * (visible to the widget, not the model) with the short-lived public share
 * URL as fallback `src`.
 */
export const E2E_SCREENSHOT_WIDGET_URI = "ui://widget/e2e-screenshots.html";
export const E2E_SCREENSHOT_WIDGET_MIME = "text/html+skybridge";
export const E2E_SCREENSHOT_META_KEY = "chatgpt2codex/screenshots";
export const E2E_WIDGET_TOOL_META = { "openai/outputTemplate": E2E_SCREENSHOT_WIDGET_URI } as const;

export const E2E_SCREENSHOT_WIDGET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: transparent; }
  #status { font-size: 13px; color: #8e8ea0; margin: 8px 10px; }
  #grid { display: flex; flex-direction: column; gap: 10px; padding: 0 10px 10px; }
  figure { margin: 0; }
  img { width: 100%; border-radius: 8px; border: 1px solid rgba(128, 128, 128, 0.35); display: block; }
  figcaption { font-size: 12px; color: #8e8ea0; margin-top: 4px; }
</style>
</head>
<body>
<div id="status">Loading E2E screenshots...</div>
<div id="grid"></div>
<script>
(function () {
  function shotList() {
    var api = window.openai || {};
    var meta = api.toolResponseMetadata || {};
    var shots = meta["${E2E_SCREENSHOT_META_KEY}"];
    if (Array.isArray(shots) && shots.length) return shots;
    var out = api.toolOutput || {};
    var set = Array.isArray(out.screenshotSet) ? out.screenshotSet : out.inlineUrl ? [out] : [];
    return set.map(function (s, i) {
      return { label: s.shotLabel || "E2E screenshot " + (i + 1), url: s.inlineUrl };
    });
  }
  function render() {
    var shots = shotList();
    var grid = document.getElementById("grid");
    grid.textContent = "";
    var shown = 0;
    shots.forEach(function (shot, i) {
      var src = shot.dataUri || shot.url;
      if (!src) return;
      var fig = document.createElement("figure");
      var img = document.createElement("img");
      img.alt = shot.label || "E2E screenshot " + (i + 1);
      img.src = src;
      if (shot.dataUri && shot.url) {
        img.onerror = function () {
          if (img.src !== shot.url) img.src = shot.url;
        };
      }
      fig.appendChild(img);
      var cap = document.createElement("figcaption");
      cap.textContent = shot.label || "E2E screenshot " + (i + 1);
      fig.appendChild(cap);
      grid.appendChild(fig);
      shown += 1;
    });
    document.getElementById("status").textContent = shown
      ? shown + " E2E screenshot" + (shown > 1 ? "s" : "")
      : "No screenshots returned.";
  }
  window.addEventListener("openai:set_globals", render);
  render();
})();
</script>
</body>
</html>
`;

export function e2eWidgetResourceMeta(publicUrl?: string): Record<string, unknown> {
  let resourceDomains: string[] = [];
  if (publicUrl) {
    try {
      resourceDomains = [new URL(publicUrl).origin];
    } catch {
      resourceDomains = [];
    }
  }
  return {
    "openai/widgetDescription": "Inline gallery of the E2E screenshots captured by jk.",
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": { connect_domains: [], resource_domains: resourceDomains },
  };
}

export async function attachE2eInlineShare<T extends { path: string }>(
  ctx: ToolContext,
  shot: T,
  alt: string,
): Promise<T & { markdown: string; inlineUrl?: string; inlineMarkdown?: string; inlineExpiresAt?: string }> {
  if (ctx.config.publicUrl) {
    try {
      const share = await createE2eScreenshotShare(ctx.stateDir, shot.path, ctx.config.publicUrl);
      const markdown = `![${alt}](${share.url})`;
      return {
        ...shot,
        inlineUrl: share.url,
        inlineMarkdown: markdown,
        inlineExpiresAt: share.expiresAt,
        markdown,
      };
    } catch {
      // Fall back to the local path only when inline sharing itself fails.
    }
  }
  return { ...shot, markdown: `![${alt}](${shot.path})` };
}

export async function attachE2eInlineShareSet<T extends { path: string }>(
  ctx: ToolContext,
  shots: T[],
): Promise<Array<T & { markdown: string; inlineUrl?: string; inlineMarkdown?: string; inlineExpiresAt?: string }>> {
  return Promise.all(shots.map((shot, index) => attachE2eInlineShare(ctx, shot, `E2E screenshot ${index + 1}`)));
}

export interface E2eDeliverableShot {
  path: string;
  inlineUrl?: string;
  inlineExpiresAt?: string;
  shotLabel?: string;
}

export interface RemoteE2eScreenshotResult {
  path: string;
  bytes: number;
  opened: boolean;
  captureMode: "screen";
  imageBase64: string;
  mimeType: "image/png";
}

export async function materializeRemoteE2eScreenshot(
  ctx: ToolContext,
  remote: RemoteE2eScreenshotResult,
): Promise<RemoteE2eScreenshotResult & { path: string; remotePath: string }> {
  const image = Buffer.from(remote.imageBase64, "base64");
  if (image.length === 0 || image.length > 6 * 1024 * 1024) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Remote E2E screenshot payload is empty or too large.");
  }
  const dir = path.join(ctx.stateDir, "remote-e2e-screenshots");
  await fs.mkdir(dir, { recursive: true });
  const localPath = path.join(dir, `${Date.now()}-${randomUUID()}.png`);
  await fs.writeFile(localPath, image);
  return { ...remote, path: localPath, remotePath: remote.path };
}

export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

export async function e2eScreenshotPayload(shots: E2eDeliverableShot[]): Promise<{
  images: Array<{ type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }>;
  widgetShots: Array<Record<string, unknown>>;
}> {
  const images: Array<{ type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }> = [];
  const widgetShots: Array<Record<string, unknown>> = [];
  for (const [index, shot] of shots.slice(0, 6).entries()) {
    const label = shot.shotLabel ? `E2E screenshot (${shot.shotLabel})` : `E2E screenshot ${index + 1}`;
    if (shot.inlineUrl) {
      widgetShots.push({
        label,
        url: shot.inlineUrl,
        ...(shot.inlineExpiresAt ? { expiresAt: shot.inlineExpiresAt } : {}),
      });
      continue;
    }
    const preview = await createE2eScreenshotPreview(shot.path);
    const filePath = preview?.path ?? shot.path;
    const mimeType: "image/png" | "image/jpeg" = preview ? "image/jpeg" : "image/png";
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile() && stat.size > 0 && stat.size <= MAX_INLINE_IMAGE_BYTES) {
      const base64 = (await fs.readFile(filePath)).toString("base64");
      images.push({ type: "image", data: base64, mimeType });
    }
  }
  return { images, widgetShots };
}

/**
 * Use exactly one delivery channel per captured screenshot: short-lived URLs
 * in the Apps SDK widget for HTTP/WebGPT, or MCP image content for local
 * clients that have no public URL.
 */
export async function withE2eImageContent<T extends Record<string, unknown>>(
  result: ToolResult<T>,
  shots: E2eDeliverableShot[],
): Promise<ToolResult<T>> {
  const { images, widgetShots } = await e2eScreenshotPayload(shots);
  const next: ToolResult<T> = { ...result };
  if (images.length > 0) {
    next.content = [...result.content, ...images];
  }
  if (widgetShots.length > 0) {
    next._meta = { ...(result._meta ?? {}), [E2E_SCREENSHOT_META_KEY]: widgetShots };
  }
  return next;
}

export async function getFreeLocalPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

export async function resolveProjectForE2e(ctx: ToolContext, projectId?: string): Promise<{ projectId: string; root: string }> {
  if (projectId) {
    await requireProjectLease(ctx, projectId, "verify");
    const entry = await resolveOrThrow(ctx, { projectId });
    return { projectId, root: await localExecutionRoot(ctx, entry) };
  }
  const active = await resolveActiveProject(ctx);
  if (!active) {
    throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Select a project once, then say: e2e 테스트하고 스크린샷 보여줘");
  }
  await requireProjectLease(ctx, active.projectId, "verify");
  const entry = await resolveOrThrow(ctx, { projectId: active.projectId });
  return { projectId: active.projectId, root: await localExecutionRoot(ctx, entry) };
}

export function isLocalHttpUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(value);
}

export async function readPackageScripts(root: string, cwd?: string): Promise<{ scripts: Record<string, string>; source: string; commandCwd: string }> {
  const baseRoot = await fs.realpath(root);
  const commandCwd = cwd ? await resolveInProject(baseRoot, cwd, { allowSymlink: false }) : baseRoot;
  const packageJsonPath = path.join(commandCwd, "package.json");
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return { scripts: {}, source: "no package.json", commandCwd };
  }
  return { scripts: parsed.scripts ?? {}, source: "package.json", commandCwd };
}

export async function detectTauriProject(commandCwd: string, scripts: Record<string, string>): Promise<{ appName?: string; devUrl?: string } | undefined> {
  const tauriConfigPath = path.join(commandCwd, "src-tauri", "tauri.conf.json");
  const hasTauriScript = typeof scripts.tauri === "string";
  let parsed:
    | {
        productName?: unknown;
        build?: { devUrl?: unknown };
      }
    | undefined;
  try {
    parsed = JSON.parse(await fs.readFile(tauriConfigPath, "utf8")) as typeof parsed;
  } catch {
    if (!hasTauriScript) {
      return undefined;
    }
  }
  const devUrlCandidate = typeof parsed?.build?.devUrl === "string" ? parsed.build.devUrl : undefined;
  return {
    appName: typeof parsed?.productName === "string" ? parsed.productName : undefined,
    devUrl: isLocalHttpUrl(devUrlCandidate) ? devUrlCandidate : undefined,
  };
}

export async function discoverE2eAutomation(root: string, cwd?: string): Promise<E2eAutomation> {
  const { scripts, source, commandCwd } = await readPackageScripts(root, cwd);
  const scriptNames = Object.keys(scripts);
  const tauri = await detectTauriProject(commandCwd, scripts);
  const targetKind: E2eTargetKind = tauri ? "desktop-app" : "web";
  const targetAppName = tauri?.appName;
  const targetAppPath = targetAppName ? path.join(commandCwd, "src-tauri", "target", "release", "bundle", "macos", `${targetAppName}.app`) : undefined;
  for (const name of E2E_SCRIPT_CANDIDATES) {
    if (typeof scripts[name] === "string") {
      return {
        command: name === "test" ? "npm test" : `npm run ${name}`,
        commandSource: `package.json script ${name}`,
        targetKind,
        targetAppName,
        targetAppPath,
        scriptNames,
      };
    }
  }
  if (tauri && typeof scripts.tauri === "string") {
    return {
      command: "npm run tauri -- build",
      commandSource: "Tauri desktop app build fallback",
      targetKind: "desktop-app",
      targetAppName,
      targetAppPath,
      scriptNames,
    };
  }
  for (const name of BUILD_SCRIPT_CANDIDATES) {
    if (typeof scripts[name] === "string") {
      const automation: E2eAutomation = {
        command: `npm run ${name}`,
        commandSource: `package.json script ${name} fallback`,
        targetKind,
        scriptNames,
      };
      for (const devName of DEV_SCRIPT_CANDIDATES) {
        if (typeof scripts[devName] === "string") {
          const port = await getFreeLocalPort();
          automation.devPort = port;
          automation.devUrl = `http://127.0.0.1:${port}/`;
          automation.devCommand =
            devName === "preview"
              ? `npm run ${devName} -- --host 127.0.0.1 --port ${port}`
              : `npm run ${devName} -- --host 127.0.0.1 --port ${port}`;
          automation.devSource = `package.json script ${devName} fallback`;
          break;
        }
      }
      return automation;
    }
  }
  for (const name of DEV_SCRIPT_CANDIDATES) {
    if (typeof scripts[name] === "string") {
      const port = await getFreeLocalPort();
      return {
        commandSource: "no e2e/test/build npm script",
        devCommand:
          name === "preview"
            ? `npm run ${name} -- --host 127.0.0.1 --port ${port}`
            : `npm run ${name} -- --host 127.0.0.1 --port ${port}`,
        devSource: `package.json script ${name} smoke fallback`,
        devUrl: `http://127.0.0.1:${port}/`,
        devPort: port,
        targetKind,
        scriptNames,
      };
    }
  }
  return { commandSource: source === "package.json" ? "no e2e/test/build/dev npm script" : source, targetKind: "generic", scriptNames };
}

export async function writeGoalIntake(ctx: ToolContext, payload: Record<string, unknown>): Promise<string> {
  const goalId = String(payload.goalId);
  const goalsDir = path.join(ctx.stateDir, "goals");
  await fs.mkdir(goalsDir, { recursive: true });
  await fs.writeFile(path.join(goalsDir, `${goalId}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return goalId;
}

export class GoalLoopResumeError extends DomainError {
  constructor(loopId: string, message: string, cause?: unknown) {
    super(ErrorCode.WORKSPACE_NOT_READY, message, { loopId });
    this.cause = cause;
  }
}

export async function writeGoalLoop(ctx: ToolContext, loopId: string, payload: Record<string, unknown>): Promise<void> {
  await new Store(ctx.stateDir).writeGoalLoop(loopId, payload);
}


/**
 * image-intake destinations default into `.jk/images/**`, which only
 * needs the `image` lease capability (same as save_image). Writing anywhere
 * else in the project (e.g. `assets/hero.png`) is a normal project write and
 * requires a full-write lease.
 */
export async function requireIntakeLease(ctx: ToolContext, projectId: string, destRel: string | undefined): Promise<Lease> {
  if (isWithinImagesDir(destRel)) {
    return requireProjectLease(ctx, projectId, "image");
  }
  return requireProjectLease(ctx, projectId, "write");
}

/** Default destination for URL and app-friendly image intake when destPath is
 * omitted: a full-write lease defaults into assets/, otherwise (image-only
 * lease, or no lease info) it's confined to .jk/images/. */
export function defaultUrlIntakeDest(preset: LeasePreset | undefined, sha8: string, ext: string): string {
  const ts = Date.now();
  if (preset === "full-write") {
    return path.join("assets", `gpt-${ts}-${sha8}.${ext}`);
  }
  return path.join(".jk", "images", `${ts}-${sha8}.${ext}`);
}

// ---------------------------------------------------------------------------
// Secret denylist guard (applies to any read/list path)
// ---------------------------------------------------------------------------

export async function guardSecretPath(ctx: ToolContext, absPath: string, toolName: string): Promise<void> {
  if (isSecretPath(absPath)) {
    await ctx.ledger.append({ type: "fs.read.blocked", tool: toolName, path: absPath });
    throw new DomainError(ErrorCode.SECRET_BLOCKED, `Access to secret-classified path is blocked: ${absPath}`, {
      path: absPath,
    });
  }
}


export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
