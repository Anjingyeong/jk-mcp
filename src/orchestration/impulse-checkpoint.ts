import { AgentBridgeStore, SCOUT_TRIGGER_EVENT_TYPES, type ImpulseEvent, type ImpulseEventInput } from "../state/agent-bridge-store.js";
import { isPublicDistribution } from "../distribution.js";
import { runImpulseScout, summarizeProposals, type ScoutContextProvider } from "./impulse-scout.js";
import { summarizeDirectorForResume, type DirectorResumeSummary } from "./impulse-director.js";

/**
 * goal_intake / goal_loop → Impulse Scout checkpoint hook (V1).
 *
 * The hook is advisory and best-effort: it writes only JK-private
 * agent-bridge state under stateDir, never throws into the caller, never
 * changes goal_loop lifecycle/nextActions, and never schedules work.
 * Disable with JK_IMPULSE_SCOUT=0. Public (jk-mcp) builds default to off;
 * enable there with JK_IMPULSE_SCOUT=1.
 */

export function impulseScoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.JK_IMPULSE_SCOUT?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return !isPublicDistribution(env);
}

/** Resume-time Director status (project_select / session_resume). Never throws; null when nothing is unresolved. */
export async function impulseResumeSummary(stateDir: string, projectId: string): Promise<DirectorResumeSummary | null> {
  if (!impulseScoutEnabled()) return null;
  try {
    return await summarizeDirectorForResume(stateDir, projectId);
  } catch {
    return null;
  }
}

export function impulseResumeLine(summary: DirectorResumeSummary | null): string {
  if (!summary) return "";
  return ` Impulse Director: ${summary.pendingDirectorTasks} pending Director task(s), ${summary.unresolvedP0} undecided P0 proposal(s) — ${summary.hint}`;
}

export interface GoalLoopCheckpointInput {
  loopId: string;
  goalId: string | null;
  workSessionId: string | null;
  revision: number;
  phase?: string;
  previousPhase?: string;
  verificationStatus?: "unknown" | "pass" | "fail" | "blocked";
  failureCount?: number;
  lastResult?: string;
  currentTask?: string;
  /** Explicit completed list sent this turn (undefined = unchanged). */
  completed?: string[];
  previousCompleted: string[];
  /** Explicit pending list sent this turn (undefined = unchanged). */
  pending?: string[];
  previousPending: string[];
}

/** Pure mapping from one goal_loop turn to checkpoint events (idempotent per loop revision). */
export function goalLoopCheckpointEvents(input: GoalLoopCheckpointInput): ImpulseEventInput[] {
  const base = {
    workSessionId: input.workSessionId,
    goalId: input.goalId,
    loopId: input.loopId,
    phaseId: input.phase ?? input.previousPhase ?? null,
    source: "goal_loop" as const,
  };
  const key = (type: string) => `goal_loop:${input.loopId}:r${input.revision}:${type}`;
  const detail = input.lastResult?.trim() || input.currentTask?.trim() || "";
  const events: ImpulseEventInput[] = [];

  if (input.phase && input.previousPhase && input.phase !== input.previousPhase) {
    events.push({ ...base, type: "phase_started", summary: `Phase ${input.phase} started (from ${input.previousPhase})`, dedupeKey: key("phase_started") });
  }
  if (input.verificationStatus === "pass" || input.verificationStatus === "fail") {
    const type = input.verificationStatus === "pass" ? "qa_passed" : "qa_failed";
    events.push({
      ...base,
      type,
      summary: detail || `Verification ${input.verificationStatus} in phase ${base.phaseId ?? "(unspecified)"}`,
      evidence: { verificationStatus: input.verificationStatus, failureCount: input.failureCount },
      dedupeKey: key(type),
    });
  }
  if (input.verificationStatus === "blocked") {
    events.push({
      ...base,
      type: "builder_blocked",
      summary: detail || "Builder reported blocked",
      evidence: { verificationStatus: "blocked", failureCount: input.failureCount },
      dedupeKey: key("builder_blocked"),
    });
  }
  const previousCompleted = new Set(input.previousCompleted);
  const newlyCompleted = (input.completed ?? []).filter((item) => !previousCompleted.has(item));
  if (newlyCompleted.length > 0) {
    events.push({
      ...base,
      type: "phase_completed",
      summary: `Completed: ${newlyCompleted.join("; ")}`,
      evidence: { completed: newlyCompleted, verificationStatus: input.verificationStatus },
      dedupeKey: key("phase_completed"),
    });
  }
  if (input.pending !== undefined) {
    const nextPending = new Set(input.pending);
    const completedNow = new Set([...(input.completed ?? []), ...input.previousCompleted]);
    const dropped = input.previousPending.filter((item) => !nextPending.has(item) && !completedNow.has(item) && !item.startsWith("Operational drift:"));
    if (dropped.length > 0) {
      events.push({
        ...base,
        type: "scope_changed",
        summary: `${dropped.length} pending item(s) removed without completion`,
        evidence: { droppedPending: dropped, pending: input.pending },
        dedupeKey: key("scope_changed"),
      });
    }
  }
  return events;
}

export interface ImpulseCheckpointSummary {
  recordedEvents: number;
  newProposals: number;
  top: ReturnType<typeof summarizeProposals>;
  note: string;
}

/** Record events and, when any is a Scout trigger, run the Scout. Never throws. */
export async function recordImpulseCheckpoint(options: {
  stateDir: string;
  projectId: string;
  events: ImpulseEventInput[];
  context?: ScoutContextProvider;
  /** Receives events newly recorded by this call (duplicates by dedupeKey excluded). */
  recorded?: ImpulseEvent[];
}): Promise<ImpulseCheckpointSummary | null> {
  if (!impulseScoutEnabled() || options.events.length === 0) return null;
  try {
    const store = new AgentBridgeStore(options.stateDir, options.projectId);
    let recorded = 0;
    let trigger = false;
    for (const input of options.events) {
      const { duplicate, event } = await store.recordEvent(input);
      if (!duplicate) { recorded += 1; options.recorded?.push(event); }
      if (SCOUT_TRIGGER_EVENT_TYPES.has(event.type)) trigger = true;
    }
    if (!trigger) return null;
    const run = await runImpulseScout({ stateDir: options.stateDir, projectId: options.projectId, context: options.context });
    if (run.proposals.length === 0) return null;
    return {
      recordedEvents: recorded,
      newProposals: run.proposals.length,
      top: summarizeProposals(run.proposals),
      note: "Advisory Impulse Scout proposals (read-only, V1). They do not change this loop; review with impulse_wake_queue before adding scope.",
    };
  } catch {
    return null;
  }
}
