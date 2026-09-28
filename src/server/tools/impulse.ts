// MCP tool registrations (Impulse Scout V1). See docs/JK_IMPULSE_SCOUT_DIRECTOR_ROADMAP.ko.md.
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../../types.js";
import {
  AgentBridgeStore,
  DIRECTOR_DECISIONS,
  IMPULSE_EVENT_TYPES,
  ImpulseEvidenceSchema,
  SCOUT_TRIGGER_EVENT_TYPES,
  WAKE_PRIORITIES,
} from "../../state/agent-bridge-store.js";
import { runImpulseScout } from "../../orchestration/impulse-scout.js";
import {
  HARD_MAX_CYCLES_PER_LOOP,
  PROPOSAL_STATUSES,
  annotateProposals,
  compactProposal,
  decideProposal,
  proposalStatus,
  readDirectorLoopView,
  readDirectorPolicy,
  readDirectorSnapshot,
  resetDirectorCycles,
  updateDirectorPolicy,
  type ProposalStatus,
} from "../../orchestration/impulse-director.js";
import { WorkSessionIdSchema, resolveOrThrow, READ_ONLY_ANNOTATIONS, LOCAL_STATE_ANNOTATIONS, chatGptToolMeta, withErrorMapping } from "./shared.js";
import { MAX_OBSERVATIONS_PER_SUBMISSION, SemanticObservationSchema, submitSemanticReview } from "../../orchestration/impulse-semantic.js";
import { ProjectMemoryStore } from "../../state/project-memory.js";
import { redact } from "../../policy/secrets.js";
import type { RegisterTool } from "./register.js";

const ADVISORY_NOTE =
  "Impulse Scout is read-only and advisory: proposals never start, stop, or re-scope work. Only a Director decision (impulse_director_decide) can turn a proposal into a task.";
const DIRECTOR_NOTE =
  "The Director (the user with ChatGPT) decides. JK enforces allowedDecisions, protected scopes, and the per-loop cycle budget; approved tasks appear in goal_loop pending/nextActions.";
const DEFAULT_QUEUE_LIMIT = 5;
/** Actionable statuses first so the compact default page shows what still needs a decision or work. */
const STATUS_ORDER: Record<ProposalStatus, number> = { open: 0, backlog: 1, approved: 2, completed: 3, cancelled: 4, rejected: 5 };

export function registerImpulseTools(registerTool: RegisterTool, ctx: ToolContext): void {
  registerTool(
    "impulse_event_record",
    {
      title: "Record Impulse Scout checkpoint",
      description:
        "Record a meaningful checkpoint event (phase_completed, qa_failed, regression_detected, commit_created, user_feedback_received, ...) in JK private state. Trigger events run the read-only Impulse Scout, which may queue evidence-backed wake proposals. Never modifies the project.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Recording checkpoint...", "Checkpoint recorded"),
      inputSchema: {
        projectId: z.string(),
        type: z.enum(IMPULSE_EVENT_TYPES),
        summary: z.string().min(1).max(1000),
        workSessionId: WorkSessionIdSchema.optional(),
        goalId: z.string().min(1).max(200).optional(),
        loopId: z.string().min(1).max(200).optional(),
        phaseId: z.string().min(1).max(80).optional(),
        evidence: ImpulseEvidenceSchema.optional(),
        dedupeKey: z.string().min(1).max(300).optional(),
        runScout: z.boolean().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "impulse_event_record", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const store = new AgentBridgeStore(ctx.stateDir, input.projectId);
        const { event, duplicate } = await store.recordEvent({
          workSessionId: input.workSessionId,
          goalId: input.goalId,
          loopId: input.loopId,
          phaseId: input.phaseId,
          type: input.type,
          summary: input.summary,
          evidence: input.evidence,
          dedupeKey: input.dedupeKey,
          source: "tool",
        });
        const trigger = SCOUT_TRIGGER_EVENT_TYPES.has(event.type);
        const run = trigger && input.runScout !== false
          ? await runImpulseScout({ stateDir: ctx.stateDir, projectId: input.projectId })
          : null;
        return makeResult(
          {
            event,
            duplicate,
            scoutTrigger: trigger,
            scoutRun: run ? { runId: run.runId, evaluatedEvents: run.evaluatedEvents, suppressed: run.suppressed.length } : null,
            proposals: run?.proposals ?? [],
            note: ADVISORY_NOTE,
          },
          duplicate
            ? `Event ${event.eventId} already recorded (dedupeKey).`
            : `Event ${event.eventId} recorded${run ? `; Scout queued ${run.proposals.length} proposal(s)` : ""}.`,
        );
      });
    },
  );

  registerTool(
    "impulse_scout_run",
    {
      title: "Run Impulse Scout",
      description:
        "Run the read-only Impulse Scout over unprocessed checkpoint events. It only looks for costly omissions (unverified phases, repeated failures, regressions, matching known fixes, dropped pending items, recurring project feedback) and queues deduplicated, evidence-backed wake proposals.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Running Impulse Scout...", "Impulse Scout finished"),
      inputSchema: {
        projectId: z.string(),
        maxEvents: z.number().int().min(1).max(100).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "impulse_scout_run", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const run = await runImpulseScout({ stateDir: ctx.stateDir, projectId: input.projectId, maxEvents: input.maxEvents });
        return makeResult(
          { ...run, note: ADVISORY_NOTE },
          `Scout evaluated ${run.evaluatedEvents} event(s); ${run.proposals.length} new proposal(s), ${run.suppressed.length} suppressed.`,
        );
      });
    },
  );

  registerTool(
    "impulse_wake_queue",
    {
      title: "Show Impulse Scout wake queue",
      description:
        "Compact list of Impulse Scout wake proposals: actionable first (open, backlog, approved), then by priority and recency; default 5 items with proposalId, priority, status, short reason, and recommendedDecision. Pass proposalId for one proposal's full evidence, Director Policy checks, and decision history. Read-only.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Loading wake queue...", "Wake queue loaded"),
      inputSchema: {
        projectId: z.string(),
        proposalId: z.string().regex(/^wake_[A-Za-z0-9_-]+$/).optional(),
        goalId: z.string().min(1).max(200).optional(),
        loopId: z.string().min(1).max(200).optional(),
        workSessionId: WorkSessionIdSchema.optional(),
        priority: z.enum(WAKE_PRIORITIES).optional(),
        status: z.enum(PROPOSAL_STATUSES).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => {
      return withErrorMapping<Record<string, unknown>>(ctx, "impulse_wake_queue", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const snapshot = await readDirectorSnapshot(ctx.stateDir, input.projectId);
        if (input.proposalId) {
          const proposal = snapshot.proposals.get(input.proposalId);
          if (!proposal) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Wake proposal ${input.proposalId} not found`, { proposalId: input.proposalId });
          const [detail] = await annotateProposals(ctx.stateDir, input.projectId, [proposal], snapshot);
          const history = snapshot.ledger.decisions
            .filter((decision) => decision.proposalId === input.proposalId)
            .map(({ decisionId, decision, reason, approvedScope, constraints, task, caller, decidedAt }) =>
              ({ decisionId, decision, reason, approvedScope, constraints, taskId: task?.taskId ?? null, caller, decidedAt }));
          const task = detail!.taskId ? snapshot.ledger.tasks.get(detail!.taskId) ?? null : null;
          return makeResult(
            { proposal: detail, decisions: history, task, note: DIRECTOR_NOTE },
            `Proposal ${input.proposalId}: ${detail!.priority} ${detail!.status}${detail!.recommendation ? `, recommended ${detail!.recommendation.decision}` : ""}.`,
          );
        }
        const store = new AgentBridgeStore(ctx.stateDir, input.projectId);
        const queue = await store.listWakeQueue({
          goalId: input.goalId,
          loopId: input.loopId,
          workSessionId: input.workSessionId,
          priority: input.priority,
          limit: 100_000,
        });
        const statusCounts = Object.fromEntries(PROPOSAL_STATUSES.map((status) => [status, 0])) as Record<(typeof PROPOSAL_STATUSES)[number], number>;
        const withStatus = queue.proposals.map((proposal, recency) => {
          const status = proposalStatus(snapshot.ledger, proposal.proposalId);
          statusCounts[status] += 1;
          return { proposal, status, recency };
        });
        const selected = withStatus
          .filter((item) => !input.status || item.status === input.status)
          .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
            || a.proposal.priority.localeCompare(b.proposal.priority) || a.recency - b.recency);
        const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_QUEUE_LIMIT, 50));
        const page = selected.slice(0, limit);
        const annotated = await annotateProposals(ctx.stateDir, input.projectId, page.map((item) => item.proposal), snapshot);
        return makeResult(
          {
            proposals: annotated.map(compactProposal),
            returned: annotated.length,
            matching: selected.length,
            total: queue.total,
            counts: queue.counts,
            statusCounts,
            pendingTriggerEvents: queue.pendingTriggerEvents,
            detailHint: "Pass proposalId for full evidence, policy checks, and decision history.",
          },
          `${queue.total} wake proposal(s): P0=${queue.counts.P0} P1=${queue.counts.P1} P2=${queue.counts.P2}; open=${statusCounts.open}; showing ${annotated.length}.`,
        );
      });
    },
  );

  registerTool(
    "impulse_director_decide",
    {
      title: "Record Director decision on a wake proposal",
      description:
        "Director-only: decide an Impulse Scout proposal with REJECT, BACKLOG, NEXT_PHASE, or INTERRUPT_P0. Only NEXT_PHASE/INTERRUPT_P0 create a Director task, which goal_loop then adds to pending/nextActions. JK enforces the proposal's allowedDecisions (P2 can only be backlogged/rejected), protected scopes, and the per-loop cycle budget. Confirm with the user before approving new scope.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Recording Director decision...", "Director decision recorded"),
      inputSchema: {
        projectId: z.string(),
        proposalId: z.string().regex(/^wake_[A-Za-z0-9_-]+$/),
        decision: z.enum(DIRECTOR_DECISIONS),
        reason: z.string().min(1).max(1000),
        approvedScope: z.array(z.string().min(1).max(300)).max(20).optional(),
        constraints: z.array(z.string().min(1).max(500)).max(20).optional(),
        loopId: z.string().min(1).max(200).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "impulse_director_decide", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await decideProposal({
          stateDir: ctx.stateDir,
          projectId: input.projectId,
          proposalId: input.proposalId,
          decision: input.decision,
          reason: input.reason,
          approvedScope: input.approvedScope,
          constraints: input.constraints,
          loopId: input.loopId,
          caller: ctx.remote ? "remote" : "local",
        });
        if (!result.duplicate) {
          await ctx.ledger.append({ type: "impulse.director.decision", projectId: input.projectId, proposalId: input.proposalId,
            decision: input.decision, decisionId: result.decision.decisionId, taskId: result.task?.taskId ?? null });
        }
        return makeResult(
          {
            duplicate: result.duplicate,
            decision: { decisionId: result.decision.decisionId, proposalId: result.decision.proposalId, decision: result.decision.decision,
              recommendedDecision: result.decision.recommendation.decision },
            task: result.task
              ? { taskId: result.task.taskId, label: result.task.label, decision: result.task.decision, loopId: result.task.loopId,
                  approvedScope: result.task.approvedScope, constraints: result.task.constraints, cycle: result.task.cycle, status: result.task.status }
              : null,
            cycles: result.cycles,
            proposalStatus: result.proposalStatus,
          },
          result.duplicate
            ? `Proposal ${input.proposalId} already decided as ${result.decision.decision}.`
            : result.task
              ? `Approved ${input.decision}: task ${result.task.taskId} will be added to loop ${result.task.loopId} on its next goal_loop turn.`
              : `Recorded ${input.decision} for ${input.proposalId}; no task created.`,
        );
      });
    },
  );

  registerTool(
    "impulse_director_policy",
    {
      title: "Show or update Director Policy",
      description:
        "Read or update the per-project Director Policy: protected scopes (never approvable; releasing one requires a local JK caller) and the autonomous improvement cycle budget per goal loop. reset_cycles restores a loop's budget and must only be used after the user agreed to continue.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Loading Director Policy...", "Director Policy ready"),
      inputSchema: {
        projectId: z.string(),
        action: z.enum(["get", "update", "reset_cycles"]).default("get"),
        addProtectedScopes: z.array(z.string().min(1).max(300)).max(50).optional(),
        removeProtectedScopes: z.array(z.string().min(1).max(300)).max(50).optional(),
        maxCyclesPerLoop: z.number().int().min(0).max(HARD_MAX_CYCLES_PER_LOOP).optional(),
        loopId: z.string().min(1).max(200).optional(),
        reason: z.string().min(1).max(1000).optional(),
      },
    },
    async (input) => {
      return withErrorMapping<Record<string, unknown>>(ctx, "impulse_director_policy", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const caller = ctx.remote ? "remote" : "local";
        if (input.action === "reset_cycles") {
          if (!input.loopId || !input.reason) {
            throw new DomainError(ErrorCode.PERMISSION_DENIED, "reset_cycles requires loopId and reason");
          }
          const cycles = await resetDirectorCycles({ stateDir: ctx.stateDir, projectId: input.projectId, loopId: input.loopId, reason: input.reason, caller });
          await ctx.ledger.append({ type: "impulse.director.cycle_reset", projectId: input.projectId, loopId: input.loopId, caller });
          return makeResult({ cycles, note: DIRECTOR_NOTE }, `Cycle budget for ${input.loopId} reset (${cycles.used}/${cycles.max}).`);
        }
        if (input.action === "update") {
          const { policy, changed } = await updateDirectorPolicy({
            stateDir: ctx.stateDir,
            projectId: input.projectId,
            caller,
            addProtectedScopes: input.addProtectedScopes,
            removeProtectedScopes: input.removeProtectedScopes,
            maxCyclesPerLoop: input.maxCyclesPerLoop,
          });
          if (changed) await ctx.ledger.append({ type: "impulse.director.policy_updated", projectId: input.projectId, caller });
          return makeResult({ policy, changed, note: DIRECTOR_NOTE }, changed ? "Director Policy updated." : "Director Policy unchanged.");
        }
        const policy = await readDirectorPolicy(ctx.stateDir, input.projectId);
        const cycles = input.loopId ? (await readDirectorLoopView(ctx.stateDir, input.projectId, input.loopId)).cycles : null;
        return makeResult({ policy, cycles, note: DIRECTOR_NOTE }, `Director Policy: ${policy.protectedScopes.length} protected scope(s), ${policy.maxCyclesPerLoop} cycle(s) per loop.`);
      });
    },
  );

  registerTool(
    "impulse_semantic_review",
    {
      title: "Submit Semantic Scout observations",
      description:
        "Answer a goal_loop semanticReview request only when you found an important quality gap the deterministic checks cannot see (product polish, real usage flow, goal fit, repeated project feedback). Observations become wake proposals (backend=semantic) for a Director decision; they never start work. If there is no important gap, do not call this.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Recording semantic review...", "Semantic review recorded"),
      inputSchema: {
        projectId: z.string(),
        reviewId: z.string().regex(/^srv_[A-Za-z0-9_-]+$/),
        observations: z.array(SemanticObservationSchema).min(1).max(MAX_OBSERVATIONS_PER_SUBMISSION),
      },
    },
    async (input) => {
      return withErrorMapping<Record<string, unknown>>(ctx, "impulse_semantic_review", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await submitSemanticReview({ stateDir: ctx.stateDir, projectId: input.projectId, reviewId: input.reviewId, observations: input.observations });
        if (!result.duplicate && result.accepted.length) {
          await ctx.ledger.append({ type: "impulse.semantic.submitted", projectId: input.projectId, reviewId: input.reviewId,
            proposalIds: result.accepted.map((proposal) => proposal.proposalId) });
        }
        return makeResult(
          { ...result, next: result.accepted.length ? "Decide with impulse_director_decide (confirm new scope with the user), or leave them queued." : null },
          result.duplicate
            ? `Semantic review ${input.reviewId} was already answered.`
            : `Semantic review ${input.reviewId}: ${result.accepted.length} proposal(s) queued for a Director decision, ${result.suppressed.length} suppressed.`,
        );
      });
    },
  );

  registerTool(
    "project_feedback_record",
    {
      title: "Remember project feedback",
      description:
        "Remember one piece of the user's feedback about THIS project (e.g. 'UI too bright', 'no PASS before Play QA'). Repeating the same key increments its count; Semantic Scout only surfaces feedback given at least twice and relevant to the current phase. Do not record personal or unrelated preferences.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Remembering feedback...", "Feedback remembered"),
      inputSchema: {
        projectId: z.string(),
        text: z.string().trim().min(3).max(300),
        key: z.string().trim().min(2).max(200).optional(),
        tags: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "project_feedback_record", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const feedback = await new ProjectMemoryStore(ctx.stateDir).recordFeedback(input.projectId, {
          text: redact(input.text), key: input.key ? redact(input.key) : undefined, tags: input.tags?.map((tag) => redact(tag)),
        });
        return makeResult({ feedback: { id: feedback.id, key: feedback.key, count: feedback.count } },
          `Feedback "${feedback.key}" recorded (${feedback.count}×).`);
      });
    },
  );
}
