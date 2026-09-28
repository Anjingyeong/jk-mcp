import { createHash, randomUUID } from "node:crypto";
import {
  AgentBridgeStore,
  MAX_PROCESSED_EVENT_IDS,
  SCOUT_TRIGGER_EVENT_TYPES,
  WakeProposalSchema,
  impulseScopeKey,
  trimSuppressed,
  type DirectorDecision,
  type ImpulseEvent,
  type ScoutRun,
  type SuppressionReason,
  type WakeCategory,
  type WakePriority,
  type WakeProposal,
} from "../state/agent-bridge-store.js";
import { ProjectMemoryStore } from "../state/project-memory.js";

/**
 * Impulse Scout V1 (docs/JK_IMPULSE_SCOUT_DIRECTOR_ROADMAP.ko.md §3.2, §10, §13 V1).
 *
 * A deterministic, read-only "omission detector". It answers exactly one
 * question per checkpoint event: "is there an important gap that becomes
 * expensive if missed now?" It never edits files, runs commands, touches git,
 * or schedules work. Its only side effect is appending to its own JK-private
 * agent-bridge state (wake queue, run audit, cursor).
 *
 * V1 guardrails implemented here:
 *  - only meaningful checkpoint events wake it (SCOUT_TRIGGER_EVENT_TYPES)
 *  - every proposal carries concrete evidence (event ids + summaries)
 *  - fingerprint dedupe against the full durable wake queue
 *  - at most PHASE_WAKE_BUDGET proposals per scope+phase (P0 exempt)
 *  - at most EVENT_PROPOSAL_CAP proposals per event
 *  - confidence threshold
 *  - writeScopes is always [] and only P0 may set interruptNow
 * Director decisions (REJECT/BACKLOG/NEXT_PHASE/INTERRUPT_P0) are V2; proposals
 * only advertise which decisions a Director would be allowed to take.
 */

export const PHASE_WAKE_BUDGET = 2;
export const EVENT_PROPOSAL_CAP = 3;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
export const DEFAULT_MAX_EVENTS_PER_RUN = 20;
const KNOWN_FIX_MIN_SCORE = 9;

/** Read-only context the Scout may consult. Implementations must not mutate anything. */
export interface ScoutContextProvider {
  readonly sources: readonly string[];
  searchKnownFixes?(query: string): Promise<Array<{ id: string; title: string; score: number }>>;
}

export function projectMemoryScoutContext(stateDir: string, projectId: string): ScoutContextProvider {
  const memory = new ProjectMemoryStore(stateDir);
  return {
    sources: ["project-memory.knownFixes"],
    searchKnownFixes: async (query) => {
      if (!query.trim()) return [];
      const fixes = await memory.searchKnownFixes(projectId, query, 3);
      return fixes.map((fix) => ({ id: fix.id, title: fix.title, score: fix.score }));
    },
  };
}

interface Candidate {
  ruleId: string;
  subject: string;
  priority: WakePriority;
  confidence: number;
  category: WakeCategory;
  reason: string;
  evidence: string[];
  suggestedNext: string;
  readScopes: string[];
}

interface RuleInput {
  event: ImpulseEvent;
  /** Events strictly before `event` in the same scope, oldest first. */
  history: ImpulseEvent[];
  /** Events strictly before `event` in the whole project, oldest first. */
  projectHistory: ImpulseEvent[];
  context: ScoutContextProvider;
}

type Rule = (input: RuleInput) => Promise<Candidate | null> | Candidate | null;

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function eventEvidence(event: ImpulseEvent): string {
  return clip(`event ${event.eventId} ${event.type}${event.phaseId ? `@${event.phaseId}` : ""}: ${event.summary}`, 1000);
}

function normalizeSubject(value: string): string {
  return value.toLowerCase().replace(/[0-9a-f]{7,}/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 300);
}

function samePhase(a: ImpulseEvent, b: ImpulseEvent): boolean {
  return (a.phaseId ?? null) === (b.phaseId ?? null);
}

function eventReadScopes(event: ImpulseEvent, extra: string[] = []): string[] {
  return Array.from(new Set([...(event.evidence.changedScopes ?? []), ...extra])).slice(0, 20);
}

/** qa_failed repeated in the same phase without an intervening qa_passed. */
const repeatedVerificationFailure: Rule = ({ event, history }) => {
  if (event.type !== "qa_failed") return null;
  const failures: ImpulseEvent[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const prior = history[i]!;
    if (!samePhase(prior, event)) continue;
    if (prior.type === "qa_passed") break;
    if (prior.type === "qa_failed") failures.push(prior);
  }
  const count = Math.max(failures.length + 1, event.evidence.failureCount ?? 0);
  if (count < 2) return null;
  return {
    ruleId: "repeated-verification-failure",
    subject: event.phaseId ?? "no-phase",
    priority: "P1",
    confidence: Math.min(0.95, 0.6 + 0.1 * count),
    category: "verification-loop",
    reason: `Verification failed ${count} times in phase ${event.phaseId ?? "(unspecified)"} without a pass; repeating the same approach is likely wasted work.`,
    evidence: [eventEvidence(event), ...failures.slice(0, 4).map(eventEvidence), `failure count: ${count}`],
    suggestedNext: "Stop patching; re-inspect the failing output and diff, form a new evidence-backed hypothesis (recovery phase) before the next patch.",
    readScopes: eventReadScopes(event, ["verification-output", "working-diff"]),
  };
};

/** Regression reported: major → P0 interrupt candidate, otherwise P1. */
const regressionDetected: Rule = ({ event }) => {
  if (event.type !== "regression_detected") return null;
  const major = event.evidence.severity === "major";
  return {
    ruleId: "regression-detected",
    subject: normalizeSubject(`${event.phaseId ?? ""} ${(event.evidence.tests ?? []).join(",")} ${event.summary}`),
    priority: major ? "P0" : "P1",
    confidence: major ? 0.9 : 0.75,
    category: "regression",
    reason: major
      ? "A major regression was reported; continuing the current phase risks building on a broken baseline."
      : "A regression was reported in previously working behavior.",
    evidence: [eventEvidence(event), ...(event.evidence.tests ?? []).slice(0, 5).map((test) => `failing check: ${test}`)],
    suggestedNext: "Reproduce the regression, bisect against the last passing checkpoint/commit, and restore the passing behavior before continuing.",
    readScopes: eventReadScopes(event, ["verification-output", "git-history"]),
  };
};

function latestQa(history: ImpulseEvent[], event: ImpulseEvent): ImpulseEvent | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const prior = history[i]!;
    if ((prior.type === "qa_passed" || prior.type === "qa_failed") && samePhase(prior, event)) return prior;
  }
  return null;
}

/** phase_completed without passing verification evidence. */
const phaseCompletedWithoutQa: Rule = ({ event, history }) => {
  if (event.type !== "phase_completed") return null;
  if (event.evidence.verificationStatus === "pass") return null;
  const qa = latestQa(history, event);
  if (qa?.type === "qa_passed") return null;
  const evidence = [eventEvidence(event)];
  if (qa) evidence.push(`latest QA in phase: ${eventEvidence(qa)}`);
  else evidence.push(`no qa_passed/qa_failed event recorded for phase ${event.phaseId ?? "(unspecified)"}`);
  if (event.evidence.verificationStatus) evidence.push(`reported verificationStatus: ${event.evidence.verificationStatus}`);
  return {
    ruleId: "phase-completed-without-qa",
    subject: `${event.phaseId ?? "no-phase"}|${(event.evidence.completed ?? []).map(normalizeSubject).sort().join("|")}`,
    priority: "P1",
    confidence: qa?.type === "qa_failed" ? 0.85 : 0.7,
    category: "quality-gap",
    reason: qa?.type === "qa_failed"
      ? "The phase was marked complete while its latest verification failed."
      : "The phase was marked complete without any recorded passing verification.",
    evidence,
    suggestedNext: "Run the closest relevant test/build/E2E check for this phase and record the result before building on it.",
    readScopes: eventReadScopes(event, ["verification-output"]),
  };
};

/** commit_created whose latest QA in the phase is a failure (or missing and not reported as pass). */
const commitWithoutPassingQa: Rule = ({ event, history }) => {
  if (event.type !== "commit_created") return null;
  if (event.evidence.verificationStatus === "pass") return null;
  const qa = latestQa(history, event);
  if (qa?.type === "qa_passed") return null;
  return {
    ruleId: "commit-without-passing-qa",
    subject: event.evidence.gitCommit ?? normalizeSubject(event.summary),
    priority: "P1",
    confidence: qa?.type === "qa_failed" ? 0.85 : 0.6,
    category: "quality-gap",
    reason: qa?.type === "qa_failed"
      ? "A commit was created while the latest verification for this phase failed."
      : "A commit was created without recorded passing verification.",
    evidence: [eventEvidence(event), qa ? `latest QA in phase: ${eventEvidence(qa)}` : "no QA event recorded before the commit"],
    suggestedNext: "Verify the committed state (tests/build) before pushing or starting the next phase.",
    readScopes: eventReadScopes(event, ["git-history", "verification-output"]),
  };
};

/** Large diff that has not been followed by any QA in its phase. */
const largeDiffUnreviewed: Rule = ({ event }) => {
  if (event.type !== "large_diff_detected") return null;
  const scopes = event.evidence.changedScopes ?? [];
  return {
    ruleId: "large-diff-review",
    subject: scopes.map(normalizeSubject).sort().join("|") || normalizeSubject(event.summary),
    priority: "P2",
    confidence: 0.6,
    category: "review-gap",
    reason: "A large diff was detected; broad changes are where silent scope creep and regressions hide.",
    evidence: [eventEvidence(event), ...(scopes.length ? [`changed scopes: ${scopes.slice(0, 10).join(", ")}`] : [])],
    suggestedNext: "Run a focused reviewer pass on the diff (goal-fit, regressions, unrelated edits) before the next phase.",
    readScopes: eventReadScopes(event, ["working-diff"]),
  };
};

/** qa_failed / builder_blocked that matches a remembered project known-fix. */
const knownFixMatch: Rule = async ({ event, context }) => {
  if (event.type !== "qa_failed" && event.type !== "builder_blocked") return null;
  if (!context.searchKnownFixes) return null;
  const query = [event.summary, ...(event.evidence.notes ?? [])].join(" ").slice(0, 500);
  const [best] = (await context.searchKnownFixes(query)).filter((fix) => fix.score >= KNOWN_FIX_MIN_SCORE);
  if (!best) return null;
  return {
    ruleId: "known-fix-match",
    subject: best.id,
    priority: "P1",
    confidence: Math.min(0.9, 0.55 + best.score / 60),
    category: "known-fix",
    reason: `This failure resembles a previously solved project issue: "${clip(best.title, 200)}".`,
    evidence: [eventEvidence(event), `project-memory known fix ${best.id}: ${clip(best.title, 200)} (match score ${best.score})`],
    suggestedNext: `Check known fix ${best.id} (known_fix_search) before spending another debugging pass.`,
    readScopes: eventReadScopes(event, ["project-memory"]),
  };
};

/** scope_changed that dropped pending items without completing them. */
const droppedPending: Rule = ({ event }) => {
  if (event.type !== "scope_changed") return null;
  const dropped = event.evidence.droppedPending ?? [];
  if (dropped.length === 0) return null;
  return {
    ruleId: "dropped-pending",
    subject: dropped.map(normalizeSubject).sort().join("|"),
    priority: "P2",
    confidence: 0.65,
    category: "scope-gap",
    reason: `${dropped.length} pending item(s) disappeared from the plan without being marked completed.`,
    evidence: [eventEvidence(event), ...dropped.slice(0, 8).map((item) => `dropped pending: ${clip(item, 300)}`)],
    suggestedNext: "Confirm each dropped item was intentionally descoped; otherwise restore it to pending.",
    readScopes: ["task-state"],
  };
};

/**
 * Project-scoped recurring user feedback (§2.4): only when the same feedbackKey
 * was recorded at least twice, and only as a "check it did not recur" prompt.
 */
const recurringFeedback: Rule = ({ event, projectHistory }) => {
  if (event.type !== "phase_completed" && event.type !== "qa_passed") return null;
  const byKey = new Map<string, ImpulseEvent[]>();
  for (const prior of projectHistory) {
    const key = prior.type === "user_feedback_received" ? prior.evidence.feedbackKey : undefined;
    if (!key) continue;
    const normalized = normalizeSubject(key);
    byKey.set(normalized, [...(byKey.get(normalized) ?? []), prior]);
  }
  const recurring = [...byKey.entries()].filter(([, items]) => items.length >= 2).sort((a, b) => b[1].length - a[1].length);
  const [top] = recurring;
  if (!top) return null;
  const [key, items] = top;
  return {
    ruleId: "recurring-feedback",
    subject: key,
    priority: "P2",
    confidence: Math.min(0.8, 0.5 + 0.1 * items.length),
    category: "preference-recurrence",
    reason: `The user gave the same project feedback "${clip(key, 120)}" ${items.length} times; check this phase did not reintroduce it.`,
    evidence: [eventEvidence(event), ...items.slice(-4).map(eventEvidence)],
    suggestedNext: `Check the completed phase against the recurring feedback "${clip(key, 120)}" before moving on.`,
    readScopes: eventReadScopes(event, ["user-feedback-events"]),
  };
};

export const SCOUT_RULES: ReadonlyArray<{ id: string; rule: Rule }> = [
  { id: "regression-detected", rule: regressionDetected },
  { id: "repeated-verification-failure", rule: repeatedVerificationFailure },
  { id: "phase-completed-without-qa", rule: phaseCompletedWithoutQa },
  { id: "commit-without-passing-qa", rule: commitWithoutPassingQa },
  { id: "known-fix-match", rule: knownFixMatch },
  { id: "large-diff-review", rule: largeDiffUnreviewed },
  { id: "dropped-pending", rule: droppedPending },
  { id: "recurring-feedback", rule: recurringFeedback },
];

const PRIORITY_ORDER: Record<WakePriority, number> = { P0: 0, P1: 1, P2: 2 };

export function allowedDecisionsFor(priority: WakePriority): DirectorDecision[] {
  if (priority === "P0") return ["INTERRUPT_P0", "NEXT_PHASE", "BACKLOG", "REJECT"];
  if (priority === "P1") return ["NEXT_PHASE", "BACKLOG", "REJECT"];
  // P2 is never auto-executed; a Director may only backlog or reject it.
  return ["BACKLOG", "REJECT"];
}

export function proposalFingerprint(projectId: string, scopeKey: string, ruleId: string, category: string, subject: string): string {
  return createHash("sha256").update(JSON.stringify([projectId, scopeKey, ruleId, category, subject])).digest("hex");
}

function budgetKey(scopeKey: string, phaseId: string | null): string {
  return `${scopeKey}|${phaseId ?? ""}`;
}

export interface ScoutRunOptions {
  stateDir: string;
  projectId: string;
  context?: ScoutContextProvider;
  maxEvents?: number;
  confidenceThreshold?: number;
  now?: () => Date;
}

export interface ScoutRunResult {
  runId: string;
  evaluatedEvents: number;
  deferredEvents: number;
  proposals: WakeProposal[];
  suppressed: ScoutRun["suppressed"];
}

export async function runImpulseScout(options: ScoutRunOptions): Promise<ScoutRunResult> {
  const store = new AgentBridgeStore(options.stateDir, options.projectId);
  const context = options.context ?? projectMemoryScoutContext(options.stateDir, options.projectId);
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxEvents = Math.max(1, Math.min(options.maxEvents ?? DEFAULT_MAX_EVENTS_PER_RUN, 100));
  const now = options.now ?? (() => new Date());
  const startedAt = Date.now();

  return store.transaction(async (tx) => {
    const [events, existing, state] = await Promise.all([tx.readEvents(), tx.readProposals(), tx.readScoutState()]);
    const processed = new Set(state.processedEventIds);
    const pending = events.filter((event) => SCOUT_TRIGGER_EVENT_TYPES.has(event.type) && !processed.has(event.eventId));
    const batch = pending.slice(0, maxEvents);
    const deferred = pending.slice(maxEvents);

    const byFingerprint = new Map(existing.map((proposal) => [proposal.fingerprint, proposal]));
    const budget = new Map<string, number>();
    for (const proposal of existing) {
      if (proposal.priority === "P0" || proposal.backend !== "native") continue;
      const key = budgetKey(proposal.scopeKey, proposal.phaseId);
      budget.set(key, (budget.get(key) ?? 0) + 1);
    }
    const index = new Map(events.map((event, i) => [event.eventId, i]));
    const created: WakeProposal[] = [];
    const suppressed: ScoutRun["suppressed"] = [];
    const suppress = (event: ImpulseEvent, candidate: Candidate, fingerprint: string, reason: SuppressionReason, existingProposalId: string | null) => {
      suppressed.push({ eventId: event.eventId, ruleId: candidate.ruleId, fingerprint, reason, existingProposalId });
      const prior = state.suppressed[fingerprint];
      state.suppressed[fingerprint] = {
        ruleId: candidate.ruleId,
        reason,
        count: (prior?.count ?? 0) + 1,
        lastAt: now().toISOString(),
        existingProposalId,
      };
    };

    for (const event of batch) {
      const scopeKey = impulseScopeKey(event);
      const before = events.slice(0, index.get(event.eventId) ?? 0);
      const history = before.filter((prior) => impulseScopeKey(prior) === scopeKey);
      const candidates: Candidate[] = [];
      for (const { rule } of SCOUT_RULES) {
        const candidate = await rule({ event, history, projectHistory: before, context });
        if (candidate && candidate.evidence.length > 0) candidates.push(candidate);
      }
      candidates.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.confidence - a.confidence);
      let emittedForEvent = 0;
      for (const candidate of candidates) {
        const fingerprint = proposalFingerprint(options.projectId, scopeKey, candidate.ruleId, candidate.category, candidate.subject);
        const duplicate = byFingerprint.get(fingerprint);
        if (duplicate) { suppress(event, candidate, fingerprint, "duplicate", duplicate.proposalId); continue; }
        if (candidate.confidence < threshold) { suppress(event, candidate, fingerprint, "low-confidence", null); continue; }
        if (emittedForEvent >= EVENT_PROPOSAL_CAP) { suppress(event, candidate, fingerprint, "event-cap", null); continue; }
        const key = budgetKey(scopeKey, event.phaseId);
        if (candidate.priority !== "P0" && (budget.get(key) ?? 0) >= PHASE_WAKE_BUDGET) {
          suppress(event, candidate, fingerprint, "phase-budget", null);
          continue;
        }
        const proposal = WakeProposalSchema.parse({
          schemaVersion: 1,
          proposalId: `wake_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          fingerprint,
          wake: true,
          priority: candidate.priority,
          confidence: Math.round(candidate.confidence * 100) / 100,
          category: candidate.category,
          ruleId: candidate.ruleId,
          reason: clip(candidate.reason, 1000),
          evidence: candidate.evidence.slice(0, 12).map((item) => clip(item, 1000)),
          suggestedNext: clip(candidate.suggestedNext, 500),
          interruptNow: candidate.priority === "P0",
          allowedDecisions: allowedDecisionsFor(candidate.priority),
          readScopes: candidate.readScopes,
          writeScopes: [],
          projectId: options.projectId,
          workSessionId: event.workSessionId,
          goalId: event.goalId,
          loopId: event.loopId,
          phaseId: event.phaseId,
          scopeKey,
          triggerEventId: event.eventId,
          backend: "native",
          createdAt: now().toISOString(),
        });
        created.push(proposal);
        byFingerprint.set(fingerprint, proposal);
        emittedForEvent += 1;
        if (candidate.priority !== "P0") budget.set(key, (budget.get(key) ?? 0) + 1);
      }
    }

    const runId = `scout_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    // Order matters for crash safety: proposals first (dedupe authority), then
    // the audit record, then the cursor. A crash before the cursor write only
    // causes a fully-deduplicated re-evaluation on the next run.
    await tx.appendProposals(created);
    await tx.appendRun({
      schemaVersion: 1,
      runId,
      at: now().toISOString(),
      backend: "native",
      triggerEventIds: batch.map((event) => event.eventId).slice(0, 100),
      skippedEventIds: deferred.map((event) => event.eventId).slice(0, 100),
      contextSources: ["agent-bridge.events", "agent-bridge.wake_queue", ...context.sources].slice(0, 30),
      proposalIds: created.map((proposal) => proposal.proposalId).slice(0, 100),
      suppressed: suppressed.slice(0, 200),
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    const processedIds = [...state.processedEventIds, ...batch.map((event) => event.eventId)];
    await tx.writeScoutState({
      ...state,
      processedEventIds: processedIds.slice(-MAX_PROCESSED_EVENT_IDS),
      suppressed: trimSuppressed(state.suppressed),
      runs: state.runs + 1,
      lastRunAt: now().toISOString(),
      lastRunId: runId,
    });
    return { runId, evaluatedEvents: batch.length, deferredEvents: deferred.length, proposals: created, suppressed };
  });
}

/** Compact, advisory-only view for embedding in other tool responses. */
export function summarizeProposals(proposals: WakeProposal[], max = 3): Array<Pick<WakeProposal, "proposalId" | "priority" | "confidence" | "category" | "reason" | "suggestedNext" | "interruptNow">> {
  return [...proposals]
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.confidence - a.confidence)
    .slice(0, max)
    .map(({ proposalId, priority, confidence, category, reason, suggestedNext, interruptNow }) => ({
      proposalId,
      priority,
      confidence,
      category,
      reason: clip(reason, 240),
      suggestedNext: clip(suggestedNext, 240),
      interruptNow,
    }));
}
