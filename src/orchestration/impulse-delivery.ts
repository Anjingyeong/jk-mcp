import { z } from "zod";
import { AgentBridgeStore, type WakePriority } from "../state/agent-bridge-store.js";
import {
  DEFAULT_MAX_CYCLES_PER_LOOP,
  annotateProposals,
  compactProposal,
  cycleStatus,
  proposalStatus,
  readDirectorSnapshot,
  type CompactProposal,
  type CycleStatus,
  type DirectorDecisionRecord,
} from "./impulse-director.js";

/**
 * Delta delivery for goal_loop (V2 compactness).
 *
 * goal_loop only reports Impulse/Director information when something changed
 * for the loop since the last delivered response: a new proposal, a new
 * Director decision, a task closing (completed/dropped), or a cycle budget
 * change. The delivered state is a per-loop cursor in JK private state, so it
 * survives restarts and is shared by every chat that continues the loop. New
 * chats learn about still-open work from the project_select/session_resume
 * summary instead of from repeated goal_loop payloads.
 *
 * The cursor is advisory: losing it only causes one re-delivery; it never
 * affects pending, nextActions for approved tasks, lifecycle, or terminal checks.
 */

export const DELIVERY_FILE = "impulse_delivery.json";
const MAX_LOOPS = 200;
const MAX_IDS_PER_KIND = 1000;
const MAX_LISTED = 3;

const LoopCursorSchema = z.object({
  proposalIds: z.array(z.string()).max(MAX_IDS_PER_KIND).default([]),
  decisionIds: z.array(z.string()).max(MAX_IDS_PER_KIND).default([]),
  closedTaskIds: z.array(z.string()).max(MAX_IDS_PER_KIND).default([]),
  cycles: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative(), resets: z.number().int().nonnegative() }),
  at: z.string(),
});
type LoopCursor = z.infer<typeof LoopCursorSchema>;

const DeliveryFileSchema = z.object({
  schemaVersion: z.literal(1),
  loops: z.record(z.string(), LoopCursorSchema).default({}),
});
type DeliveryFile = z.infer<typeof DeliveryFileSchema>;

function parseDelivery(raw: string): DeliveryFile {
  if (!raw.trim()) return { schemaVersion: 1, loops: {} };
  try {
    const parsed = DeliveryFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { schemaVersion: 1, loops: {} };
  } catch {
    return { schemaVersion: 1, loops: {} };
  }
}

export interface ImpulseDelta {
  /** Newly surfaced, still-undecided proposals (compact; details via impulse_wake_queue proposalId). */
  newProposals?: CompactProposal[];
  moreNewProposals?: number;
  /** Director decisions recorded since the last delivery. */
  decisions?: Array<{ proposalId: string; decision: DirectorDecisionRecord["decision"]; taskId: string | null }>;
  tasksCompleted?: string[];
  tasksDropped?: string[];
  cycles?: Pick<CycleStatus, "used" | "max" | "remaining">;
  /** Current open counts for this loop (always present in a delta). */
  open: { tasks: number } & Record<WakePriority, number>;
}

export interface PreparedImpulseDelta {
  delta: ImpulseDelta | null;
  newUndecidedP0: number;
  /** Persist that this delta was delivered. Call only after the response is built. */
  commit(): Promise<void>;
}

function tail(ids: Iterable<string>): string[] {
  return [...new Set(ids)].slice(-MAX_IDS_PER_KIND);
}

export async function prepareLoopImpulseDelta(stateDir: string, projectId: string, loopId: string): Promise<PreparedImpulseDelta> {
  const store = new AgentBridgeStore(stateDir, projectId);
  const [snapshot, raw] = await Promise.all([readDirectorSnapshot(stateDir, projectId), store.readText(DELIVERY_FILE)]);
  const { ledger, proposals, policy } = snapshot;
  const previous: LoopCursor | undefined = parseDelivery(raw).loops[loopId];
  const seenProposals = new Set(previous?.proposalIds ?? []);
  const seenDecisions = new Set(previous?.decisionIds ?? []);
  const seenClosed = new Set(previous?.closedTaskIds ?? []);

  const loopProposals = [...proposals.values()].filter((proposal) => proposal.loopId === loopId);
  const loopDecisions = ledger.decisions.filter((decision) => decision.loopId === loopId || decision.task?.loopId === loopId);
  const loopTasks = [...ledger.tasks.values()].filter((task) => task.loopId === loopId);
  const closedTasks = loopTasks.filter((task) => task.status === "completed" || task.status === "dropped");
  const cycles = cycleStatus(ledger, policy ?? { schemaVersion: 1, protectedScopes: [], maxCyclesPerLoop: DEFAULT_MAX_CYCLES_PER_LOOP, updatedAt: null }, loopId);
  const prevCycles = previous?.cycles ?? { used: 0, max: cycles.max, resets: 0 };

  const open: ImpulseDelta["open"] = { tasks: loopTasks.filter((t) => t.status === "approved" || t.status === "injected").length, P0: 0, P1: 0, P2: 0 };
  for (const proposal of loopProposals) {
    if (!ledger.latestByProposal.has(proposal.proposalId)) open[proposal.priority] += 1;
  }

  const unseenOpen = loopProposals.filter((proposal) => !seenProposals.has(proposal.proposalId) && proposalStatus(ledger, proposal.proposalId) === "open");
  const newDecisions = loopDecisions.filter((decision) => !seenDecisions.has(decision.decisionId));
  const newClosed = closedTasks.filter((task) => !seenClosed.has(task.taskId));
  const cyclesChanged = prevCycles.used !== cycles.used || prevCycles.max !== cycles.max || prevCycles.resets !== cycles.resets;

  const delta: ImpulseDelta | null = unseenOpen.length || newDecisions.length || newClosed.length || cyclesChanged
    ? { open }
    : null;
  let newUndecidedP0 = 0;
  if (delta && unseenOpen.length) {
    const ordered = unseenOpen.sort((a, b) => a.priority.localeCompare(b.priority) || b.confidence - a.confidence);
    newUndecidedP0 = ordered.filter((proposal) => proposal.priority === "P0").length;
    const annotated = await annotateProposals(stateDir, projectId, ordered.slice(0, MAX_LISTED), snapshot);
    delta.newProposals = annotated.map(compactProposal);
    if (ordered.length > MAX_LISTED) delta.moreNewProposals = ordered.length - MAX_LISTED;
  }
  if (delta && newDecisions.length) {
    delta.decisions = newDecisions.slice(-MAX_LISTED).map((d) => ({ proposalId: d.proposalId, decision: d.decision, taskId: d.task?.taskId ?? null }));
  }
  if (delta && newClosed.length) {
    const completed = newClosed.filter((task) => task.status === "completed").map((task) => task.taskId);
    const dropped = newClosed.filter((task) => task.status === "dropped").map((task) => task.taskId);
    if (completed.length) delta.tasksCompleted = completed;
    if (dropped.length) delta.tasksDropped = dropped;
  }
  if (delta && cyclesChanged) delta.cycles = { used: cycles.used, max: cycles.max, remaining: cycles.remaining };

  const deliveredProposalIds = loopProposals.map((p) => p.proposalId);
  const deliveredDecisionIds = loopDecisions.map((d) => d.decisionId);
  const deliveredClosedIds = closedTasks.map((t) => t.taskId);
  return {
    delta,
    newUndecidedP0,
    commit: async () => {
      // Initialize the cursor on a loop's first turn even without a delta, so
      // later out-of-band marks (semantic submissions) have a cursor to extend.
      if (!delta && previous) return;
      await store.transaction(async (tx) => {
        const doc = parseDelivery(await tx.readText(DELIVERY_FILE));
        const current = doc.loops[loopId];
        doc.loops[loopId] = {
          proposalIds: tail([...(current?.proposalIds ?? []), ...deliveredProposalIds]),
          decisionIds: tail([...(current?.decisionIds ?? []), ...deliveredDecisionIds]),
          closedTaskIds: tail([...(current?.closedTaskIds ?? []), ...deliveredClosedIds]),
          cycles: { used: cycles.used, max: cycles.max, resets: cycles.resets },
          at: new Date().toISOString(),
        };
        const loops = Object.entries(doc.loops).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MAX_LOOPS);
        await tx.writeText(DELIVERY_FILE, JSON.stringify({ schemaVersion: 1, loops: Object.fromEntries(loops) }));
      });
    },
  };
}


/**
 * Mark proposals as already delivered for a loop (e.g. semantic proposals the
 * host itself just submitted), so the next goal_loop delta does not echo them.
 * Only extends an existing cursor; with no cursor yet, the first delta will
 * include them once, which is harmless.
 */
export async function markProposalsDelivered(stateDir: string, projectId: string, loopId: string, proposalIds: string[]): Promise<void> {
  if (proposalIds.length === 0) return;
  const store = new AgentBridgeStore(stateDir, projectId);
  await store.transaction(async (tx) => {
    const doc = parseDelivery(await tx.readText(DELIVERY_FILE));
    const current = doc.loops[loopId];
    if (!current) return;
    doc.loops[loopId] = { ...current, proposalIds: tail([...current.proposalIds, ...proposalIds]) };
    await tx.writeText(DELIVERY_FILE, JSON.stringify(doc));
  });
}
