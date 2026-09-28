import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import {
  AgentBridgeStore,
  SEMANTIC_WAKE_CATEGORIES,
  WakeProposalSchema,
  impulseScopeKey,
  type ImpulseEvent,
  type SemanticWakeCategory,
  type WakeProposal,
} from "../state/agent-bridge-store.js";
import { ProjectMemoryStore } from "../state/project-memory.js";
import { impulseScoutEnabled } from "./impulse-checkpoint.js";
import { allowedDecisionsFor, proposalFingerprint } from "./impulse-scout.js";
import { annotateProposals, readDirectorSnapshot, shortText } from "./impulse-director.js";
import { markProposalsDelivered } from "./impulse-delivery.js";

/**
 * Semantic Scout (V2.1).
 *
 * JK has no model of its own and cannot start a reasoning turn. The reasoning
 * host (Web ChatGPT) is already mid-turn whenever it calls goal_loop. At a few
 * meaningful checkpoints JK therefore asks that same turn for one short
 * semantic look ("did the result miss something important that deterministic
 * rules cannot see?"), attaching a compact, pre-selected evidence pack.
 *
 *   goal_loop checkpoint ─► deterministic Scout (V1)
 *                        └► planSemanticReview: maybe one compact review request
 *   host reasons in the same turn
 *     no gap  → does nothing (no call, no state, no tokens)
 *     gap     → impulse_semantic_review(reviewId, observations)
 *                 → validate + dedupe → wake_queue (backend "semantic")
 *                 → existing Director (V2) decides; nothing becomes a task before that
 *
 * State: agent-bridge/<projectKey>/semantic_reviews.json (atomic). It is the
 * dedupe authority for requests, so a corrupt file fails closed: no new
 * requests and no submissions until repaired.
 */

export const SEMANTIC_REVIEWS_FILE = "semantic_reviews.json";
export const MAX_SEMANTIC_REVIEWS_PER_LOOP = 4;
export const MAX_OBSERVATIONS_PER_SUBMISSION = 3;
export const MAX_ACCEPTED_PER_REVIEW = 2;
export const SEMANTIC_MIN_CONFIDENCE = 0.6;
/** Skip new review requests while the loop already has this many undecided proposals. */
export const MAX_OPEN_PROPOSALS_FOR_REVIEW = 3;
const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REVIEW_RECORDS = 300;
/** Semantic review is about finished work: only newly completed items trigger it. */
const SEMANTIC_TRIGGERS = new Set<ImpulseEvent["type"]>(["phase_completed"]);

export function semanticScoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!impulseScoutEnabled(env)) return false;
  const raw = env.JK_SEMANTIC_SCOUT?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

const ReviewRecordSchema = z.object({
  reviewId: z.string().regex(/^srv_[A-Za-z0-9_-]+$/),
  loopId: z.string().min(1).max(200),
  goalId: z.string().max(200).nullable(),
  workSessionId: z.string().max(120).nullable(),
  phaseKey: z.string().min(1).max(80),
  phaseId: z.string().max(80).nullable(),
  triggerEventId: z.string().regex(/^evt_[A-Za-z0-9_-]+$/),
  reason: z.string().min(1).max(200),
  status: z.enum(["open", "answered", "superseded"]),
  createdAt: z.string().datetime({ offset: true }),
  answeredAt: z.string().datetime({ offset: true }).nullable(),
  proposalIds: z.array(z.string()).max(MAX_OBSERVATIONS_PER_SUBMISSION),
});
type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

const ReviewsFileSchema = z.object({
  schemaVersion: z.literal(1),
  reviews: z.array(ReviewRecordSchema).max(MAX_REVIEW_RECORDS),
});
type ReviewsFile = z.infer<typeof ReviewsFileSchema>;

function parseReviewsStrict(raw: string): ReviewsFile {
  if (!raw.trim()) return { schemaVersion: 1, reviews: [] };
  try {
    return ReviewsFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Semantic review state is corrupt; repair semantic_reviews.json before continuing", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function clean(value: string, max: number): string {
  return shortText(redact(value), max);
}

function subjectKey(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[0-9]+/g, "#").replace(/[^\p{L}\p{N}#]+/gu, " ").trim().split(" ").slice(0, 8).join("-").slice(0, 80);
}

/**
 * Dedupe key for "the same unit of work". goal_loop phases are a fixed
 * workflow enum, so the product-level checkpoint is the set of newly
 * completed items; a QA-only pass is keyed by the current task.
 */
export function semanticCheckpointKey(triggers: ImpulseEvent[], currentTask: string | null): string {
  // Unlike observation subjects, digits are significant here ("pass 1" vs "pass 2").
  const exact = (value: string) => value.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  const completed = triggers.flatMap((event) => event.evidence.completed ?? []).map(exact).filter(Boolean).sort();
  const basis = completed.length ? `done:${completed.join("|")}` : `qa:${exact(currentTask ?? "") || (triggers[0]?.phaseId ?? "none")}`;
  return basis.length <= 80 ? basis : `${basis.slice(0, 3)}${createHash("sha256").update(basis).digest("hex").slice(0, 40)}`;
}

export interface SemanticReviewInput {
  stateDir: string;
  projectId: string;
  loopId: string;
  goal: string | null;
  /** goal_loop currentTask for this turn (the product-level unit of work). */
  currentTask?: string | null;
  /** Events newly recorded this turn (duplicates excluded). */
  events: ImpulseEvent[];
  verificationStatus: string | null;
  pending: string[];
  /** Lazy: only called when a review is actually issued. */
  loadWorkEvidence: () => Promise<{ changed: string[]; verificationCommand: string | null }>;
  now?: () => Date;
}

export interface SemanticReviewRequest {
  reviewId: string;
  reason: string;
  /** goal_loop workflow stage (discover…release). */
  phase: string | null;
  /** Product-level unit of work under review (current task or completed items). */
  task: string | null;
  question: string;
  evidence: {
    goal?: string;
    completed?: string[];
    verification?: string;
    changed?: string[];
    pending?: string[];
    feedback?: Array<{ text: string; count: number }>;
    alreadyRaised?: Array<{ priority: string; category: string; reason: string }>;
  };
  submit: string;
}

export const SEMANTIC_QUESTION =
  "Against the goal and the listed project feedback, is there an important quality gap in this result that the deterministic checks cannot see (product polish, real usage flow, goal fit, repeated user feedback)? If not, do nothing.";

/**
 * Decide whether this goal_loop turn warrants one semantic review and, if so,
 * persist the request and return a compact payload. Returns null on every turn
 * that does not need one (the common case), costing zero response bytes.
 */
export async function planSemanticReview(input: SemanticReviewInput): Promise<SemanticReviewRequest | null> {
  if (!semanticScoutEnabled()) return null;
  const triggers = input.events.filter((event) => SEMANTIC_TRIGGERS.has(event.type) && event.loopId === input.loopId);
  const trigger = triggers[0];
  if (!trigger) return null;
  const store = new AgentBridgeStore(input.stateDir, input.projectId);
  const phaseKey = semanticCheckpointKey(triggers, input.currentTask ?? null);

  // Cheap lock-free pre-checks before building any evidence.
  const existing = parseReviewsStrict(await store.readText(SEMANTIC_REVIEWS_FILE));
  const loopReviews = existing.reviews.filter((review) => review.loopId === input.loopId);
  if (loopReviews.some((review) => review.phaseKey === phaseKey) || loopReviews.length >= MAX_SEMANTIC_REVIEWS_PER_LOOP) return null;
  const snapshot = await readDirectorSnapshot(input.stateDir, input.projectId);
  const undecided = [...snapshot.proposals.values()]
    .filter((proposal) => proposal.loopId === input.loopId && !snapshot.ledger.latestByProposal.has(proposal.proposalId));
  if (undecided.some((proposal) => proposal.priority === "P0") || undecided.length >= MAX_OPEN_PROPOSALS_FOR_REVIEW) return null;

  const completed = triggers.flatMap((event) => event.evidence.completed ?? []).slice(0, 5).map((item) => clean(item, 120));
  const reason = input.verificationStatus === "pass" ? "work completed + verification passed"
    : input.verificationStatus === "fail" ? "work completed while verification failed" : "work completed (verification not reported)";
  const work = await input.loadWorkEvidence().catch(() => ({ changed: [] as string[], verificationCommand: null }));
  const changed = work.changed.slice(0, 8).map((file) => clean(file, 120));
  const feedbackQuery = [input.goal ?? "", trigger.phaseId ?? "", ...completed, ...changed].join(" ");
  const feedback = (await new ProjectMemoryStore(input.stateDir).selectRelevantFeedback(input.projectId, feedbackQuery, { max: 3 }).catch(() => []))
    .map((item) => ({ text: clean(item.text, 120), count: item.count }));
  const alreadyRaised = undecided.slice(-3).map((proposal) => ({ priority: proposal.priority, category: proposal.category, reason: clean(proposal.reason, 90) }));
  const verification = input.verificationStatus
    ? `${input.verificationStatus}${work.verificationCommand ? ` (${clean(work.verificationCommand, 80)})` : ""}`
    : null;

  const now = (input.now ?? (() => new Date()))();
  const reviewId = `srv_${now.getTime().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const created = await store.transaction(async (tx) => {
    const doc = parseReviewsStrict(await tx.readText(SEMANTIC_REVIEWS_FILE));
    const current = doc.reviews.filter((review) => review.loopId === input.loopId);
    if (current.some((review) => review.phaseKey === phaseKey) || current.length >= MAX_SEMANTIC_REVIEWS_PER_LOOP) return false;
    const reviews = doc.reviews.map((review) => review.loopId === input.loopId && review.status === "open" ? { ...review, status: "superseded" as const } : review);
    reviews.push(ReviewRecordSchema.parse({
      reviewId, loopId: input.loopId, goalId: trigger.goalId, workSessionId: trigger.workSessionId, phaseKey, phaseId: trigger.phaseId,
      triggerEventId: trigger.eventId, reason, status: "open", createdAt: now.toISOString(), answeredAt: null, proposalIds: [],
    }));
    await tx.writeText(SEMANTIC_REVIEWS_FILE, JSON.stringify({ schemaVersion: 1, reviews: reviews.slice(-MAX_REVIEW_RECORDS) }));
    return true;
  });
  if (!created) return null;

  const evidence: SemanticReviewRequest["evidence"] = {};
  if (input.goal) evidence.goal = clean(input.goal, 160);
  if (completed.length) evidence.completed = completed;
  if (verification) evidence.verification = verification;
  if (changed.length) evidence.changed = changed;
  const pending = input.pending.filter((item) => !item.startsWith("[director:")).slice(0, 4).map((item) => clean(item, 80));
  if (pending.length) evidence.pending = pending;
  if (feedback.length) evidence.feedback = feedback;
  if (alreadyRaised.length) evidence.alreadyRaised = alreadyRaised;
  return {
    reviewId,
    reason,
    phase: trigger.phaseId,
    task: input.currentTask ? clean(input.currentTask, 120) : completed[0] ?? null,
    question: SEMANTIC_QUESTION,
    evidence,
    submit: `Only if you find an important gap: impulse_semantic_review reviewId=${reviewId} with up to ${MAX_OBSERVATIONS_PER_SUBMISSION} observations (category, priority P1|P2, confidence, reason, concrete evidence, suggestedNext, short stable subject). They enter the wake queue for a Director decision; nothing becomes work automatically.`,
  };
}

export function semanticReviewNextAction(review: SemanticReviewRequest): string {
  return `Impulse semantic review ${review.reviewId} (${review.reason}${review.task ? ` for "${review.task}"` : ""}): before moving on, answer semanticReview.question using semanticReview.evidence. If there is no important gap, continue without any extra call.`;
}

export const SemanticObservationSchema = z.object({
  category: z.enum(SEMANTIC_WAKE_CATEGORIES),
  priority: z.enum(["P1", "P2"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(10).max(300),
  evidence: z.array(z.string().trim().min(3).max(200)).min(1).max(5),
  suggestedNext: z.string().trim().min(5).max(300),
  subject: z.string().trim().min(2).max(80).optional(),
  scope: z.array(z.string().trim().min(1).max(300)).max(5).optional(),
}).strict();
export type SemanticObservation = z.infer<typeof SemanticObservationSchema>;

export interface SemanticSubmissionResult {
  reviewId: string;
  duplicate: boolean;
  accepted: Array<{ proposalId: string; priority: string; category: string; recommendedDecision: string | null }>;
  suppressed: Array<{ index: number; reason: "duplicate" | "low-confidence" | "review-cap"; existingProposalId: string | null }>;
}

export async function submitSemanticReview(input: {
  stateDir: string;
  projectId: string;
  reviewId: string;
  observations: SemanticObservation[];
  now?: () => Date;
}): Promise<SemanticSubmissionResult> {
  const store = new AgentBridgeStore(input.stateDir, input.projectId);
  const now = (input.now ?? (() => new Date()))();
  const observations = input.observations.slice(0, MAX_OBSERVATIONS_PER_SUBMISSION).map((observation) => SemanticObservationSchema.parse(observation));
  const outcome = await store.transaction(async (tx) => {
    const doc = parseReviewsStrict(await tx.readText(SEMANTIC_REVIEWS_FILE));
    const review = doc.reviews.find((candidate) => candidate.reviewId === input.reviewId);
    if (!review) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Semantic review ${input.reviewId} not found for this project`, { reviewId: input.reviewId });
    if (review.status === "answered") {
      return { review, duplicate: true, created: [] as WakeProposal[], suppressed: [] as SemanticSubmissionResult["suppressed"] };
    }
    if (review.status === "superseded" || now.getTime() - Date.parse(review.createdAt) > REVIEW_TTL_MS) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, `Semantic review ${input.reviewId} is no longer open (superseded or expired); answer the latest review instead`, { reviewId: input.reviewId, status: review.status });
    }
    const existing = new Map((await tx.readProposals()).map((proposal) => [proposal.fingerprint, proposal]));
    const scopeKey = impulseScopeKey({ loopId: review.loopId, goalId: review.goalId, workSessionId: review.workSessionId });
    const created: WakeProposal[] = [];
    const suppressed: SemanticSubmissionResult["suppressed"] = [];
    const ordered = observations
      .map((observation, index) => ({ observation, index }))
      .sort((a, b) => a.observation.priority.localeCompare(b.observation.priority) || b.observation.confidence - a.observation.confidence);
    for (const { observation, index } of ordered) {
      const category: SemanticWakeCategory = observation.category;
      const subject = subjectKey(observation.subject ?? observation.reason);
      const fingerprint = proposalFingerprint(input.projectId, scopeKey, `semantic:${category}`, category, subject);
      const duplicate = existing.get(fingerprint);
      if (duplicate) { suppressed.push({ index, reason: "duplicate", existingProposalId: duplicate.proposalId }); continue; }
      if (observation.confidence < SEMANTIC_MIN_CONFIDENCE) { suppressed.push({ index, reason: "low-confidence", existingProposalId: null }); continue; }
      if (created.length >= MAX_ACCEPTED_PER_REVIEW) { suppressed.push({ index, reason: "review-cap", existingProposalId: null }); continue; }
      const proposal = WakeProposalSchema.parse({
        schemaVersion: 1,
        proposalId: `wake_${now.getTime().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        fingerprint,
        wake: true,
        priority: observation.priority,
        confidence: Math.round(observation.confidence * 100) / 100,
        category,
        ruleId: `semantic:${category}`,
        reason: clean(observation.reason, 1000),
        evidence: [
          `semantic review ${review.reviewId} of event ${review.triggerEventId} (${review.reason}${review.phaseId ? `, phase ${review.phaseId}` : ""})`,
          ...observation.evidence.map((item) => clean(item, 200)),
        ].slice(0, 12),
        suggestedNext: clean(observation.suggestedNext, 500),
        interruptNow: false,
        allowedDecisions: allowedDecisionsFor(observation.priority),
        readScopes: (observation.scope ?? []).map((scope) => clean(scope, 300)),
        writeScopes: [],
        projectId: input.projectId,
        workSessionId: review.workSessionId,
        goalId: review.goalId,
        loopId: review.loopId,
        phaseId: review.phaseId,
        scopeKey,
        triggerEventId: review.triggerEventId,
        backend: "semantic",
        reviewId: review.reviewId,
        createdAt: now.toISOString(),
      });
      created.push(proposal);
      existing.set(fingerprint, proposal);
    }
    // Proposals first (dedupe authority), then the review status. A crash in
    // between only makes a retried submission resolve as duplicates.
    await tx.appendProposals(created);
    const answered: ReviewRecord = { ...review, status: "answered", answeredAt: now.toISOString(), proposalIds: created.map((p) => p.proposalId) };
    await tx.writeText(SEMANTIC_REVIEWS_FILE, JSON.stringify({ ...doc, reviews: doc.reviews.map((r) => (r.reviewId === review.reviewId ? answered : r)) }));
    return { review: answered, duplicate: false, created, suppressed };
  });

  const proposals = outcome.duplicate
    ? (await store.readProposals()).filter((proposal) => outcome.review.proposalIds.includes(proposal.proposalId))
    : outcome.created;
  // The host just authored these; do not echo them back as a goal_loop delta.
  if (proposals.length) await markProposalsDelivered(input.stateDir, input.projectId, outcome.review.loopId, proposals.map((p) => p.proposalId)).catch(() => undefined);
  const annotated = await annotateProposals(input.stateDir, input.projectId, proposals);
  return {
    reviewId: input.reviewId,
    duplicate: outcome.duplicate,
    accepted: annotated.map((proposal) => ({
      proposalId: proposal.proposalId, priority: proposal.priority, category: proposal.category,
      recommendedDecision: proposal.recommendation?.decision ?? null,
    })),
    suppressed: outcome.suppressed,
  };
}
