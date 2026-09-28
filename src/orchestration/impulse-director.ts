import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import {
  AgentBridgeStore,
  DIRECTOR_DECISIONS,
  WAKE_PRIORITIES,
  type AgentBridgeTx,
  type DirectorDecision,
  type WakePriority,
  type WakeProposal,
} from "../state/agent-bridge-store.js";

/**
 * Impulse Director V2 (docs/JK_IMPULSE_SCOUT_DIRECTOR_ROADMAP.ko.md §3.3, §8, §9, §10, §13 V2).
 *
 * The Director is the only authority that can turn a Scout wake proposal into
 * work. In V2 the Director is the human-facing web Director (the user +
 * ChatGPT through MCP); JK only validates decisions against Director Policy,
 * records them, and links approved work into goal_loop. There is no local
 * surrogate Director and nothing runs unattended (that is V3).
 *
 * State (under <stateDir>/agent-bridge/<projectKey>/):
 *   director_policy.json  protected scopes + cycle budget (fails closed when corrupt)
 *   decisions.jsonl       append-only authority for decisions, task status and cycle resets;
 *                         approved tasks and cycle counts are derived from it
 *
 * Invariants:
 *  - the Scout never writes here; tasks exist only as the result of a decision
 *  - a decision must be in the proposal's allowedDecisions (P2 → BACKLOG/REJECT only,
 *    INTERRUPT_P0 → P0 only)
 *  - approved scopes may not touch protected scopes; protected scopes can be
 *    removed only by a local (non-remote) caller
 *  - NEXT_PHASE approvals per loop are capped by maxCyclesPerLoop; P0 interrupts are exempt
 *  - one live decision per proposal; only BACKLOG may be promoted, and an approved
 *    task may only be cancelled (REJECT) while it is not completed
 */

export const DECISIONS_FILE = "decisions.jsonl";
export const POLICY_FILE = "director_policy.json";
const MAX_DECISION_RECORDS = 5000;
const KEEP_DECISION_RECORDS = 4000;
export const DEFAULT_MAX_CYCLES_PER_LOOP = 3;
export const HARD_MAX_CYCLES_PER_LOOP = 10;
const NEXT_PHASE_MIN_CONFIDENCE = 0.7;
const INTERRUPT_MIN_CONFIDENCE = 0.8;

const Text = (max: number) => z.string().min(1).max(max);
const IsoTime = z.string().datetime({ offset: true });
const Scope = z.string().trim().min(1).max(300);

export const DirectorPolicySchema = z.object({
  schemaVersion: z.literal(1),
  protectedScopes: z.array(Scope).max(100).default([]),
  maxCyclesPerLoop: z.number().int().min(0).max(HARD_MAX_CYCLES_PER_LOOP).default(DEFAULT_MAX_CYCLES_PER_LOOP),
  updatedAt: IsoTime.nullable().default(null),
});
export type DirectorPolicy = z.infer<typeof DirectorPolicySchema>;

export function defaultDirectorPolicy(): DirectorPolicy {
  return { schemaVersion: 1, protectedScopes: [], maxCyclesPerLoop: DEFAULT_MAX_CYCLES_PER_LOOP, updatedAt: null };
}

export const DIRECTOR_TASK_STATUSES = ["approved", "injected", "completed", "dropped"] as const;
export type DirectorTaskStatus = (typeof DIRECTOR_TASK_STATUSES)[number];
export const PROPOSAL_STATUSES = ["open", "backlog", "rejected", "approved", "completed", "cancelled"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

const TaskRefSchema = z.object({
  taskId: z.string().regex(/^dt_[A-Za-z0-9_-]+$/),
  label: Text(500),
  loopId: Text(200),
  cycle: z.number().int().nonnegative().nullable(),
});

const RecommendationSchema = z.object({
  decision: z.enum(DIRECTOR_DECISIONS),
  checks: z.array(z.object({ id: Text(40), ok: z.boolean(), detail: Text(300) })).max(10),
});
export type DirectorRecommendation = z.infer<typeof RecommendationSchema>;

const DecisionRecordSchema = z.object({
  kind: z.literal("decision"),
  schemaVersion: z.literal(1),
  decisionId: z.string().regex(/^dec_[A-Za-z0-9_-]+$/),
  proposalId: z.string().regex(/^wake_[A-Za-z0-9_-]+$/),
  fingerprint: z.string(),
  decision: z.enum(DIRECTOR_DECISIONS),
  reason: Text(1000),
  approvedScope: z.array(Scope).max(20),
  constraints: z.array(Text(500)).max(30),
  priority: z.enum(WAKE_PRIORITIES),
  category: Text(80),
  scopeKey: Text(300),
  loopId: z.string().max(200).nullable(),
  goalId: z.string().max(200).nullable(),
  workSessionId: z.string().max(120).nullable(),
  previousDecisionId: z.string().nullable(),
  task: TaskRefSchema.nullable(),
  recommendation: RecommendationSchema,
  caller: z.enum(["remote", "local"]),
  decidedAt: IsoTime,
});
export type DirectorDecisionRecord = z.infer<typeof DecisionRecordSchema>;

const TaskStatusRecordSchema = z.object({
  kind: z.literal("task_status"),
  schemaVersion: z.literal(1),
  taskId: z.string().regex(/^dt_[A-Za-z0-9_-]+$/),
  status: z.enum(["injected", "completed", "dropped"]),
  loopRevision: z.number().int().nonnegative().nullable(),
  reason: z.string().max(500).nullable(),
  at: IsoTime,
});

const CycleResetRecordSchema = z.object({
  kind: z.literal("cycle_reset"),
  schemaVersion: z.literal(1),
  loopId: Text(200),
  reason: Text(1000),
  caller: z.enum(["remote", "local"]),
  at: IsoTime,
});

const LedgerRecordSchema = z.discriminatedUnion("kind", [DecisionRecordSchema, TaskStatusRecordSchema, CycleResetRecordSchema]);
type LedgerRecord = z.infer<typeof LedgerRecordSchema>;

export interface DirectorTask {
  taskId: string;
  label: string;
  proposalId: string;
  decisionId: string;
  decision: Extract<DirectorDecision, "NEXT_PHASE" | "INTERRUPT_P0">;
  priority: WakePriority;
  suggestedNext: string;
  approvedScope: string[];
  constraints: string[];
  loopId: string;
  cycle: number | null;
  status: DirectorTaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DirectorLedger {
  decisions: DirectorDecisionRecord[];
  /** Latest live decision per proposal. */
  latestByProposal: Map<string, DirectorDecisionRecord>;
  tasks: Map<string, DirectorTask>;
  resets: Array<z.infer<typeof CycleResetRecordSchema>>;
}

function buildLedger(records: LedgerRecord[], proposals: Map<string, WakeProposal>): DirectorLedger {
  const decisions: DirectorDecisionRecord[] = [];
  const latestByProposal = new Map<string, DirectorDecisionRecord>();
  const tasks = new Map<string, DirectorTask>();
  const resets: DirectorLedger["resets"] = [];
  for (const record of records) {
    if (record.kind === "decision") {
      decisions.push(record);
      const previous = latestByProposal.get(record.proposalId);
      if (previous?.task && record.decision === "REJECT") {
        const task = tasks.get(previous.task.taskId);
        if (task && task.status !== "completed") tasks.set(task.taskId, { ...task, status: "dropped", updatedAt: record.decidedAt });
      }
      latestByProposal.set(record.proposalId, record);
      if (record.task && (record.decision === "NEXT_PHASE" || record.decision === "INTERRUPT_P0")) {
        tasks.set(record.task.taskId, {
          taskId: record.task.taskId,
          label: record.task.label,
          proposalId: record.proposalId,
          decisionId: record.decisionId,
          decision: record.decision,
          priority: record.priority,
          suggestedNext: proposals.get(record.proposalId)?.suggestedNext ?? record.task.label,
          approvedScope: record.approvedScope,
          constraints: record.constraints,
          loopId: record.task.loopId,
          cycle: record.task.cycle,
          status: "approved",
          createdAt: record.decidedAt,
          updatedAt: record.decidedAt,
        });
      }
    } else if (record.kind === "task_status") {
      const task = tasks.get(record.taskId);
      // Terminal task states are final; later status records cannot revive them.
      if (!task || task.status === "completed" || task.status === "dropped") continue;
      tasks.set(task.taskId, { ...task, status: record.status, updatedAt: record.at });
    } else {
      resets.push(record);
    }
  }
  return { decisions, latestByProposal, tasks, resets };
}

export function proposalStatus(ledger: DirectorLedger, proposalId: string): ProposalStatus {
  const latest = ledger.latestByProposal.get(proposalId);
  if (!latest) return "open";
  if (latest.decision === "BACKLOG") return "backlog";
  if (latest.decision === "REJECT") return ledger.decisions.some((d) => d.proposalId === proposalId && d.task) ? "cancelled" : "rejected";
  const task = latest.task ? ledger.tasks.get(latest.task.taskId) : undefined;
  if (task?.status === "completed") return "completed";
  if (task?.status === "dropped") return "cancelled";
  return "approved";
}

export interface CycleStatus {
  loopId: string;
  used: number;
  max: number;
  remaining: number;
  exhausted: boolean;
  resets: number;
}

export function cycleStatus(ledger: DirectorLedger, policy: DirectorPolicy, loopId: string): CycleStatus {
  const loopResets = ledger.resets.filter((reset) => reset.loopId === loopId);
  const since = loopResets.at(-1)?.at;
  const used = ledger.decisions.filter((d) =>
    d.decision === "NEXT_PHASE" && d.task?.loopId === loopId && (!since || Date.parse(d.decidedAt) > Date.parse(since))).length;
  const remaining = Math.max(0, policy.maxCyclesPerLoop - used);
  return { loopId, used, max: policy.maxCyclesPerLoop, remaining, exhausted: remaining === 0, resets: loopResets.length };
}

function normalizeScope(scope: string): string {
  return scope.trim().replace(/\\/g, "/").replace(/\/+$/g, "").replace(/^\.\//, "").toLowerCase();
}

/** Scopes overlap when equal or one is a path-prefix of the other. */
export function scopesOverlap(a: string, b: string): boolean {
  const x = normalizeScope(a);
  const y = normalizeScope(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function protectedConflicts(scopes: string[], policy: DirectorPolicy): string[] {
  return policy.protectedScopes.filter((guarded) => scopes.some((scope) => scopesOverlap(scope, guarded)));
}

async function loopLifecycle(stateDir: string, loopId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_.-]+$/.test(loopId)) return null;
  try {
    const raw = JSON.parse(await readFile(path.join(stateDir, "goals", `${loopId}.loop.json`), "utf8")) as { lifecycle?: unknown };
    return typeof raw.lifecycle === "string" ? raw.lifecycle : null;
  } catch {
    return null;
  }
}

/** Director Policy §9 checks, evaluated in order, producing an advisory recommendation. */
export function recommendDecision(input: {
  proposal: WakeProposal;
  policy: DirectorPolicy;
  ledger: DirectorLedger;
  targetLoopId: string | null;
  targetLoopLifecycle: string | null;
}): DirectorRecommendation {
  const { proposal, policy, ledger, targetLoopId, targetLoopLifecycle } = input;
  const checks: DirectorRecommendation["checks"] = [];
  const linked = Boolean(targetLoopId) && targetLoopLifecycle !== "succeeded";
  checks.push({ id: "goal-linked", ok: linked, detail: !targetLoopId
    ? "proposal is not bound to a goal loop"
    : targetLoopLifecycle === "succeeded" ? `loop ${targetLoopId} already succeeded` : `bound to loop ${targetLoopId}` });
  const evidenced = proposal.evidence.some((item) => /\bevt_[A-Za-z0-9_-]+/.test(item));
  checks.push({ id: "evidence", ok: evidenced, detail: evidenced ? `${proposal.evidence.length} evidence item(s) with event ids` : "no event-backed evidence" });
  const planned = [...ledger.tasks.values()].some((task) =>
    task.loopId === targetLoopId && (task.status === "approved" || task.status === "injected") &&
    ledger.latestByProposal.get(task.proposalId)?.category === proposal.category);
  checks.push({ id: "not-already-planned", ok: !planned, detail: planned ? `an open Director task of category ${proposal.category} already exists` : "no open task of this category" });
  const conflicts = protectedConflicts(proposal.readScopes, policy);
  checks.push({ id: "protected-scope", ok: conflicts.length === 0, detail: conflicts.length ? `touches protected scope(s): ${conflicts.join(", ")}` : "no protected scope overlap" });
  const urgent = proposal.priority === "P0" && proposal.confidence >= INTERRUPT_MIN_CONFIDENCE;
  checks.push({ id: "urgency", ok: urgent, detail: urgent ? "P0 with high confidence" : `${proposal.priority} does not justify interrupting` });
  const valuable = proposal.confidence >= NEXT_PHASE_MIN_CONFIDENCE && proposal.priority !== "P2";
  checks.push({ id: "value", ok: valuable, detail: `priority ${proposal.priority}, confidence ${proposal.confidence}` });
  const recentlyRejected = ledger.decisions.some((d) =>
    d.decision === "REJECT" && d.scopeKey === proposal.scopeKey && d.category === proposal.category && d.proposalId !== proposal.proposalId);
  checks.push({ id: "not-recently-rejected", ok: !recentlyRejected, detail: recentlyRejected ? `a ${proposal.category} proposal was already rejected in this scope` : "no prior rejection in this scope" });
  const budget = targetLoopId ? cycleStatus(ledger, policy, targetLoopId) : null;
  checks.push({ id: "cycle-budget", ok: Boolean(budget && !budget.exhausted), detail: budget ? `${budget.used}/${budget.max} cycles used` : "no loop budget" });

  let decision: DirectorDecision;
  if (!evidenced || recentlyRejected) decision = "REJECT";
  else if (urgent && linked && proposal.allowedDecisions.includes("INTERRUPT_P0")) decision = "INTERRUPT_P0";
  else if (valuable && linked && !planned && conflicts.length === 0 && budget && !budget.exhausted) decision = "NEXT_PHASE";
  else decision = "BACKLOG";
  if (!proposal.allowedDecisions.includes(decision)) decision = proposal.allowedDecisions.includes("BACKLOG") ? "BACKLOG" : "REJECT";
  return { decision, checks };
}

async function readPolicyStrict(tx: Pick<AgentBridgeTx, "readText">): Promise<DirectorPolicy> {
  const raw = await tx.readText(POLICY_FILE);
  if (!raw.trim()) return defaultDirectorPolicy();
  try {
    return DirectorPolicySchema.parse(JSON.parse(raw));
  } catch (error) {
    // Fail closed: a corrupt policy must never silently drop protected scopes.
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Director policy is corrupt; repair director_policy.json before deciding", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readLedger(tx: Pick<AgentBridgeTx, "readJsonl" | "readProposals">): Promise<{ ledger: DirectorLedger; proposals: Map<string, WakeProposal> }> {
  const [records, proposals] = await Promise.all([tx.readJsonl(DECISIONS_FILE, LedgerRecordSchema), tx.readProposals()]);
  const byId = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
  return { ledger: buildLedger(records, byId), proposals: byId };
}

function lockFreeTx(store: AgentBridgeStore): Pick<AgentBridgeTx, "readJsonl" | "readProposals" | "readText"> {
  return {
    readJsonl: (name, schema) => store.readJsonl(name, schema),
    readProposals: () => store.readProposals(),
    readText: (name) => store.readText(name),
  };
}

function clean(value: string, max: number): string {
  const text = redact(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function uniqueClean(values: string[] | undefined, maxItems: number, maxLength: number): string[] {
  return Array.from(new Set((values ?? []).map((value) => clean(value, maxLength)).filter(Boolean))).slice(0, maxItems);
}

export function directorTaskLabel(taskId: string, suggestedNext: string): string {
  const prefix = `[director:${taskId}] `;
  return `${prefix}${clean(suggestedNext, 500 - prefix.length)}`;
}

export function directorTaskIdFromLabel(item: string): string | null {
  return /\[director:(dt_[A-Za-z0-9_-]+)\]/.exec(item)?.[1] ?? null;
}

export interface DecideInput {
  stateDir: string;
  projectId: string;
  proposalId: string;
  decision: DirectorDecision;
  reason: string;
  approvedScope?: string[];
  constraints?: string[];
  /** Target loop for approved work when the proposal is not bound to one. */
  loopId?: string;
  caller: "remote" | "local";
  now?: () => Date;
}

export interface DecideResult {
  decision: DirectorDecisionRecord;
  task: DirectorTask | null;
  duplicate: boolean;
  cycles: CycleStatus | null;
  proposalStatus: ProposalStatus;
}

function refuse(message: string, details: Record<string, unknown>): never {
  throw new DomainError(ErrorCode.PERMISSION_DENIED, message, details);
}

export async function decideProposal(input: DecideInput): Promise<DecideResult> {
  const store = new AgentBridgeStore(input.stateDir, input.projectId);
  const now = input.now ?? (() => new Date());
  return store.transaction(async (tx) => {
    const policy = await readPolicyStrict(tx);
    const { ledger, proposals } = await readLedger(tx);
    const proposal = proposals.get(input.proposalId);
    if (!proposal) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Wake proposal ${input.proposalId} not found`, { proposalId: input.proposalId });
    const details = { proposalId: proposal.proposalId, priority: proposal.priority, decision: input.decision };

    if (!proposal.allowedDecisions.includes(input.decision)) {
      refuse(`${input.decision} is not allowed for a ${proposal.priority} proposal (allowed: ${proposal.allowedDecisions.join(", ")})`, details);
    }
    const approving = input.decision === "NEXT_PHASE" || input.decision === "INTERRUPT_P0";
    const approvedScope = uniqueClean(input.approvedScope, 20, 300);
    const reason = clean(input.reason, 1000);
    if (!reason) refuse("A decision reason is required", details);

    const previous = ledger.latestByProposal.get(proposal.proposalId) ?? null;
    if (previous) {
      const sameScope = JSON.stringify(previous.approvedScope) === JSON.stringify(approvedScope);
      if (previous.decision === input.decision && (!approving || sameScope)) {
        const task = previous.task ? ledger.tasks.get(previous.task.taskId) ?? null : null;
        return { decision: previous, task, duplicate: true, cycles: task ? cycleStatus(ledger, policy, task.loopId) : null,
          proposalStatus: proposalStatus(ledger, proposal.proposalId) };
      }
      const previousTask = previous.task ? ledger.tasks.get(previous.task.taskId) : undefined;
      const cancellable = Boolean(previousTask) && input.decision === "REJECT" && previousTask!.status !== "completed" && previousTask!.status !== "dropped";
      if (previous.decision !== "BACKLOG" && !cancellable) {
        refuse(`Proposal already decided as ${previous.decision}; only BACKLOG can be promoted and an open approved task can only be cancelled with REJECT`,
          { ...details, previousDecisionId: previous.decisionId, previousDecision: previous.decision });
      }
    }

    let task: DirectorDecisionRecord["task"] = null;
    let cycles: CycleStatus | null = null;
    const constraints = uniqueClean(input.constraints, 20, 500);
    if (approving) {
      if (approvedScope.length === 0) refuse("approvedScope is required when approving work", details);
      const conflicts = protectedConflicts(approvedScope, policy);
      if (conflicts.length > 0) {
        refuse(`approvedScope overlaps protected scope(s): ${conflicts.join(", ")}. Protected scopes cannot be approved from a decision.`, { ...details, conflicts });
      }
      const loopId = input.loopId?.trim() || proposal.loopId;
      if (!loopId) refuse("Approved work needs a target goal loop; pass loopId", details);
      if (proposal.loopId && input.loopId && input.loopId !== proposal.loopId) {
        refuse("loopId must match the proposal's own loop", { ...details, proposalLoopId: proposal.loopId });
      }
      const lifecycle = await loopLifecycle(input.stateDir, loopId);
      if (lifecycle === "succeeded") refuse(`Loop ${loopId} already succeeded; BACKLOG this proposal or start a new goal`, { ...details, loopId });
      cycles = cycleStatus(ledger, policy, loopId);
      if (input.decision === "NEXT_PHASE" && cycles.exhausted) {
        refuse(`Autonomous improvement cycle budget exhausted for loop ${loopId} (${cycles.used}/${cycles.max}). Return to the user before approving more work.`,
          { ...details, cycles });
      }
      if (policy.protectedScopes.length > 0) constraints.push(clean(`Protected scopes (do not modify): ${policy.protectedScopes.join(", ")}`, 500));
      const taskId = `dt_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      task = {
        taskId,
        label: directorTaskLabel(taskId, proposal.suggestedNext),
        loopId,
        cycle: input.decision === "NEXT_PHASE" ? cycles.used + 1 : null,
      };
    }

    const recommendation = recommendDecision({
      proposal,
      policy,
      ledger,
      targetLoopId: task?.loopId ?? proposal.loopId,
      targetLoopLifecycle: await loopLifecycle(input.stateDir, task?.loopId ?? proposal.loopId ?? ""),
    });
    const record = DecisionRecordSchema.parse({
      kind: "decision",
      schemaVersion: 1,
      decisionId: `dec_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      proposalId: proposal.proposalId,
      fingerprint: proposal.fingerprint,
      decision: input.decision,
      reason,
      approvedScope: approving ? approvedScope : [],
      constraints: Array.from(new Set(constraints)).slice(0, 30),
      priority: proposal.priority,
      category: proposal.category,
      scopeKey: proposal.scopeKey,
      loopId: proposal.loopId,
      goalId: proposal.goalId,
      workSessionId: proposal.workSessionId,
      previousDecisionId: previous?.decisionId ?? null,
      task,
      recommendation,
      caller: input.caller,
      decidedAt: now().toISOString(),
    });
    await tx.appendJsonl(DECISIONS_FILE, [record], MAX_DECISION_RECORDS, KEEP_DECISION_RECORDS);
    const next = buildLedger([...(await tx.readJsonl(DECISIONS_FILE, LedgerRecordSchema))], proposals);
    const createdTask = task ? next.tasks.get(task.taskId) ?? null : null;
    return {
      decision: record,
      task: createdTask,
      duplicate: false,
      cycles: task ? cycleStatus(next, policy, task.loopId) : cycles,
      proposalStatus: proposalStatus(next, proposal.proposalId),
    };
  });
}

export interface PolicyUpdateInput {
  stateDir: string;
  projectId: string;
  caller: "remote" | "local";
  addProtectedScopes?: string[];
  removeProtectedScopes?: string[];
  maxCyclesPerLoop?: number;
  now?: () => Date;
}

export async function readDirectorPolicy(stateDir: string, projectId: string): Promise<DirectorPolicy> {
  return readPolicyStrict(lockFreeTx(new AgentBridgeStore(stateDir, projectId)));
}

export async function updateDirectorPolicy(input: PolicyUpdateInput): Promise<{ policy: DirectorPolicy; changed: boolean }> {
  const store = new AgentBridgeStore(input.stateDir, input.projectId);
  return store.transaction(async (tx) => {
    const current = await readPolicyStrict(tx);
    const remove = uniqueClean(input.removeProtectedScopes, 100, 300);
    const removable = remove.filter((scope) => current.protectedScopes.some((guarded) => normalizeScope(guarded) === normalizeScope(scope)));
    if (removable.length > 0 && input.caller !== "local") {
      refuse("Protected scopes can only be released by a local JK caller (not the remote ChatGPT connector)", { scopes: removable });
    }
    const kept = current.protectedScopes.filter((guarded) => !removable.some((scope) => normalizeScope(scope) === normalizeScope(guarded)));
    const added = uniqueClean(input.addProtectedScopes, 100, 300)
      .filter((scope) => !kept.some((guarded) => normalizeScope(guarded) === normalizeScope(scope)));
    const next: DirectorPolicy = DirectorPolicySchema.parse({
      ...current,
      protectedScopes: [...kept, ...added].slice(0, 100),
      maxCyclesPerLoop: input.maxCyclesPerLoop ?? current.maxCyclesPerLoop,
      updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    const changed = JSON.stringify({ ...next, updatedAt: null }) !== JSON.stringify({ ...current, updatedAt: null });
    if (!changed) return { policy: current, changed: false };
    await tx.writeText(POLICY_FILE, JSON.stringify(next, null, 2));
    return { policy: next, changed: true };
  });
}

export async function resetDirectorCycles(input: {
  stateDir: string;
  projectId: string;
  loopId: string;
  reason: string;
  caller: "remote" | "local";
  now?: () => Date;
}): Promise<CycleStatus> {
  const store = new AgentBridgeStore(input.stateDir, input.projectId);
  return store.transaction(async (tx) => {
    const policy = await readPolicyStrict(tx);
    const reason = clean(input.reason, 1000);
    if (!reason) refuse("A reset reason is required", { loopId: input.loopId });
    const record = CycleResetRecordSchema.parse({
      kind: "cycle_reset", schemaVersion: 1, loopId: input.loopId, reason, caller: input.caller,
      at: (input.now ?? (() => new Date()))().toISOString(),
    });
    await tx.appendJsonl(DECISIONS_FILE, [record], MAX_DECISION_RECORDS, KEEP_DECISION_RECORDS);
    const { ledger } = await readLedger(tx);
    return cycleStatus(ledger, policy, input.loopId);
  });
}

export interface AnnotatedProposal extends WakeProposal {
  status: ProposalStatus;
  decisionId: string | null;
  taskId: string | null;
  recommendation: DirectorRecommendation | null;
}

/** Lock-free read-only view for impulse_wake_queue. */
export async function annotateProposals(
  stateDir: string,
  projectId: string,
  proposals: WakeProposal[],
  snapshot?: DirectorSnapshot,
): Promise<AnnotatedProposal[]> {
  const { ledger, policy } = snapshot ?? await readDirectorSnapshot(stateDir, projectId);
  const lifecycles = new Map<string, string | null>();
  for (const loopId of new Set(proposals.map((p) => p.loopId).filter((id): id is string => Boolean(id)))) {
    lifecycles.set(loopId, await loopLifecycle(stateDir, loopId));
  }
  return proposals.map((proposal) => {
    const latest = ledger.latestByProposal.get(proposal.proposalId) ?? null;
    const status = proposalStatus(ledger, proposal.proposalId);
    return {
      ...proposal,
      status,
      decisionId: latest?.decisionId ?? null,
      taskId: latest?.task?.taskId ?? null,
      recommendation: (status === "open" || status === "backlog") && policy
        ? recommendDecision({ proposal, policy, ledger, targetLoopId: proposal.loopId,
            targetLoopLifecycle: proposal.loopId ? lifecycles.get(proposal.loopId) ?? null : null })
        : null,
    };
  });
}

export interface DirectorLoopView {
  /** Approved/injected tasks bound to this loop (not completed/dropped). */
  openTasks: DirectorTask[];
  openProposals: Record<WakePriority, number>;
  cycles: CycleStatus;
}

/** Lock-free view used by goal_loop. Returns null only when there is nothing to show. */
export async function readDirectorLoopView(stateDir: string, projectId: string, loopId: string): Promise<DirectorLoopView> {
  const store = new AgentBridgeStore(stateDir, projectId);
  const tx = lockFreeTx(store);
  const { ledger, proposals } = await readLedger(tx);
  const policy = await readPolicyStrict(tx).catch(() => defaultDirectorPolicy());
  const openTasks = [...ledger.tasks.values()]
    .filter((task) => task.loopId === loopId && (task.status === "approved" || task.status === "injected"))
    .sort((a, b) => (a.decision === b.decision ? a.createdAt.localeCompare(b.createdAt) : a.decision === "INTERRUPT_P0" ? -1 : 1));
  const openProposals: Record<WakePriority, number> = { P0: 0, P1: 0, P2: 0 };
  for (const proposal of proposals.values()) {
    if (proposal.loopId === loopId && !ledger.latestByProposal.has(proposal.proposalId)) openProposals[proposal.priority] += 1;
  }
  return { openTasks, openProposals, cycles: cycleStatus(ledger, policy, loopId) };
}

/** Post-commit goal_loop sync: approved → injected, and label in completed → completed. */
export async function syncDirectorTasks(input: {
  stateDir: string;
  projectId: string;
  loopRevision: number;
  injectedTaskIds: string[];
  completedTaskIds: string[];
  now?: () => Date;
}): Promise<void> {
  if (input.injectedTaskIds.length === 0 && input.completedTaskIds.length === 0) return;
  const store = new AgentBridgeStore(input.stateDir, input.projectId);
  await store.transaction(async (tx) => {
    const { ledger } = await readLedger(tx);
    const at = (input.now ?? (() => new Date()))().toISOString();
    const records: Array<z.infer<typeof TaskStatusRecordSchema>> = [];
    const completed = new Set(input.completedTaskIds);
    for (const taskId of completed) {
      const task = ledger.tasks.get(taskId);
      if (task && (task.status === "approved" || task.status === "injected")) {
        records.push({ kind: "task_status", schemaVersion: 1, taskId, status: "completed", loopRevision: input.loopRevision, reason: "moved to completed in goal_loop", at });
      }
    }
    for (const taskId of input.injectedTaskIds) {
      if (completed.has(taskId)) continue;
      if (ledger.tasks.get(taskId)?.status === "approved") {
        records.push({ kind: "task_status", schemaVersion: 1, taskId, status: "injected", loopRevision: input.loopRevision, reason: null, at });
      }
    }
    await tx.appendJsonl(DECISIONS_FILE, records.map((record) => TaskStatusRecordSchema.parse(record)), MAX_DECISION_RECORDS, KEEP_DECISION_RECORDS);
  });
}

/** goal_loop next-action lines for open Director work. */
export function directorNextActions(view: DirectorLoopView): string[] {
  const actions: string[] = [];
  for (const task of view.openTasks) {
    const scope = `Approved scope: ${task.approvedScope.join(", ")}.`;
    const constraints = task.constraints.length ? ` Constraints: ${task.constraints.join("; ")}.` : "";
    const done = ` When done, move the exact pending label "${task.label}" into completed.`;
    actions.push(task.decision === "INTERRUPT_P0"
      ? `Director-approved P0 interrupt ${task.taskId}: pause the current phase and do this first: ${task.suggestedNext} ${scope}${constraints}${done}`
      : `Director-approved next phase ${task.taskId} (cycle ${task.cycle ?? "?"}/${view.cycles.max}): after finishing the current phase, ${task.suggestedNext} ${scope}${constraints}${done}`);
  }
  return actions;
}

/** One-shot notice for newly surfaced undecided P0 proposals (delivered once, not every turn). */
export function undecidedP0Notice(count: number): string | null {
  return count > 0
    ? `Impulse Scout raised ${count} new undecided P0 proposal(s) for this loop. Review impulse_wake_queue and record a decision with impulse_director_decide before continuing; do not act on a proposal before it is decided.`
    : null;
}

export interface DirectorSnapshot {
  ledger: DirectorLedger;
  proposals: Map<string, WakeProposal>;
  /** null when director_policy.json is corrupt (callers must fail closed for writes). */
  policy: DirectorPolicy | null;
}

/** Lock-free read of the whole Director state for one project. */
export async function readDirectorSnapshot(stateDir: string, projectId: string): Promise<DirectorSnapshot> {
  const tx = lockFreeTx(new AgentBridgeStore(stateDir, projectId));
  const [{ ledger, proposals }, policy] = await Promise.all([readLedger(tx), readPolicyStrict(tx).catch(() => null)]);
  return { ledger, proposals, policy };
}

export function shortText(value: string, max = 140): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface CompactProposal {
  proposalId: string;
  priority: WakePriority;
  status: ProposalStatus;
  reason: string;
  recommendedDecision: DirectorDecision | null;
}

export function compactProposal(proposal: AnnotatedProposal): CompactProposal {
  return {
    proposalId: proposal.proposalId,
    priority: proposal.priority,
    status: proposal.status,
    reason: shortText(proposal.reason),
    recommendedDecision: proposal.recommendation?.decision ?? null,
  };
}

export interface DirectorResumeSummary {
  pendingDirectorTasks: number;
  unresolvedP0: number;
  openProposals: number;
  /** Loops with open Director work, most urgent first (max 3). */
  loops: Array<{ loopId: string; pendingTasks: number; unresolvedP0: number; cyclesRemaining: number | null }>;
  hint: string;
}

/**
 * Tiny, payload-free Director status for project_select / session_resume so a
 * new chat notices open Director work and undecided P0s on its first call.
 * Returns null when there is nothing unresolved.
 */
export async function summarizeDirectorForResume(stateDir: string, projectId: string): Promise<DirectorResumeSummary | null> {
  const { ledger, proposals, policy } = await readDirectorSnapshot(stateDir, projectId);
  const perLoop = new Map<string, { pendingTasks: number; unresolvedP0: number }>();
  const bump = (loopId: string | null, key: "pendingTasks" | "unresolvedP0") => {
    const id = loopId ?? "(unbound)";
    const entry = perLoop.get(id) ?? { pendingTasks: 0, unresolvedP0: 0 };
    entry[key] += 1;
    perLoop.set(id, entry);
  };
  let pendingDirectorTasks = 0;
  for (const task of ledger.tasks.values()) {
    if (task.status === "approved" || task.status === "injected") { pendingDirectorTasks += 1; bump(task.loopId, "pendingTasks"); }
  }
  let unresolvedP0 = 0;
  let openProposals = 0;
  for (const proposal of proposals.values()) {
    if (ledger.latestByProposal.has(proposal.proposalId)) continue;
    openProposals += 1;
    if (proposal.priority === "P0") { unresolvedP0 += 1; bump(proposal.loopId, "unresolvedP0"); }
  }
  if (pendingDirectorTasks === 0 && unresolvedP0 === 0 && openProposals === 0) return null;
  const loops = [...perLoop.entries()]
    .sort((a, b) => b[1].unresolvedP0 - a[1].unresolvedP0 || b[1].pendingTasks - a[1].pendingTasks)
    .slice(0, 3)
    .map(([loopId, counts]) => ({
      loopId,
      ...counts,
      cyclesRemaining: policy && loopId !== "(unbound)" ? cycleStatus(ledger, policy, loopId).remaining : null,
    }));
  const hint = unresolvedP0 > 0
    ? "Undecided P0 proposal(s): review impulse_wake_queue and decide with impulse_director_decide before other work."
    : pendingDirectorTasks > 0
      ? "Director-approved tasks are pending; continue their goal_loop (they appear in pending/nextActions)."
      : "Undecided advisory proposals exist; review impulse_wake_queue when convenient.";
  return { pendingDirectorTasks, unresolvedP0, openProposals, loops, hint };
}
