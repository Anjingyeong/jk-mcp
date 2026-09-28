import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { renameWithRetry } from "../util/fs-retry.js";
import { acquireMassUlwLock } from "../orchestration/mass-ulw-lock.js";
import { redact } from "../policy/secrets.js";

/**
 * Impulse Scout V1 durable state (docs/JK_IMPULSE_SCOUT_DIRECTOR_ROADMAP.ko.md §5).
 *
 * Layout (always under JK stateDir, never inside a project checkout):
 *   <stateDir>/agent-bridge/<projectKey>/
 *     events.jsonl       append-only checkpoint events
 *     wake_queue.jsonl   append-only Scout wake proposals (source of truth for dedupe)
 *     scout_runs.jsonl   append-only Scout audit log (what woke it, what it read, what it did)
 *     scout_state.json   processed-event cursor + suppression counters (atomic rewrite)
 *     .lock              cross-process owner lock (PID liveness, see mass-ulw-lock)
 *
 * V1 intentionally has no decisions / director policy / cycle state files;
 * those belong to V2 (Director) and V3 (night mode).
 *
 * Crash safety:
 *  - JSONL appends are fsync'd; a torn trailing line is skipped on read and a
 *    missing trailing newline is repaired before the next append.
 *  - Dedupe fingerprints and per-phase wake counts are derived from
 *    wake_queue.jsonl itself, so a crash between appending proposals and
 *    saving scout_state.json can only cause a re-evaluation that is fully
 *    suppressed as duplicate, never a double proposal.
 */

export const IMPULSE_EVENT_TYPES = [
  "goal_started",
  "phase_started",
  "phase_completed",
  "qa_failed",
  "qa_passed",
  "regression_detected",
  "large_diff_detected",
  "scope_changed",
  "commit_created",
  "builder_blocked",
  "builder_idle",
  "user_feedback_received",
] as const;
export type ImpulseEventType = (typeof IMPULSE_EVENT_TYPES)[number];

/** Only meaningful state changes wake the Scout (§4: never per tool call). */
export const SCOUT_TRIGGER_EVENT_TYPES: ReadonlySet<ImpulseEventType> = new Set<ImpulseEventType>([
  "phase_completed",
  "qa_failed",
  "qa_passed",
  "regression_detected",
  "large_diff_detected",
  "scope_changed",
  "commit_created",
  "builder_blocked",
]);

export const WAKE_PRIORITIES = ["P0", "P1", "P2"] as const;
export type WakePriority = (typeof WAKE_PRIORITIES)[number];
export const WAKE_CATEGORIES = [
  "quality-gap",
  "regression",
  "verification-loop",
  "known-fix",
  "scope-gap",
  "review-gap",
  "preference-recurrence",
  // Semantic (host-reasoned) categories — only produced by impulse_semantic_review.
  "product-quality",
  "ux-flow",
  "preference-mismatch",
  "goal-fit",
] as const;
export type WakeCategory = (typeof WAKE_CATEGORIES)[number];
export const SEMANTIC_WAKE_CATEGORIES = ["product-quality", "ux-flow", "preference-mismatch", "goal-fit", "quality-gap", "scope-gap"] as const;
export type SemanticWakeCategory = (typeof SEMANTIC_WAKE_CATEGORIES)[number];
/** Who produced a proposal: deterministic rules (V1) or the connected reasoning host (V2.1 Semantic Scout). */
export const PROPOSAL_BACKENDS = ["native", "semantic"] as const;
export type ProposalBackend = (typeof PROPOSAL_BACKENDS)[number];
/** Decision vocabulary reserved for the V2 Director; V1 only annotates what is allowed. */
export const DIRECTOR_DECISIONS = ["REJECT", "BACKLOG", "NEXT_PHASE", "INTERRUPT_P0"] as const;
export type DirectorDecision = (typeof DIRECTOR_DECISIONS)[number];

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const EVENTS_FILE = "events.jsonl";
const QUEUE_FILE = "wake_queue.jsonl";
const RUNS_FILE = "scout_runs.jsonl";
const STATE_FILE = "scout_state.json";
const LOCK_FILE = ".lock";

const MAX_EVENTS = 2000;
const KEEP_EVENTS = 1500;
const MAX_PROPOSALS = 1000;
const KEEP_PROPOSALS = 750;
const MAX_RUNS = 500;
const KEEP_RUNS = 375;
export const MAX_PROCESSED_EVENT_IDS = 2000;
const MAX_SUPPRESSED_ENTRIES = 200;

const Text = (max: number) => z.string().min(1).max(max);
const IsoTime = z.string().datetime({ offset: true });

export const ImpulseEvidenceSchema = z.object({
  gitCommit: Text(80).optional(),
  tests: z.array(Text(300)).max(30).optional(),
  changedScopes: z.array(Text(300)).max(50).optional(),
  verificationStatus: z.enum(["unknown", "pass", "fail", "blocked"]).optional(),
  failureCount: z.number().int().min(0).max(100).optional(),
  severity: z.enum(["minor", "major"]).optional(),
  nextPhase: Text(80).optional(),
  pending: z.array(Text(500)).max(50).optional(),
  completed: z.array(Text(500)).max(50).optional(),
  droppedPending: z.array(Text(500)).max(50).optional(),
  feedbackKey: Text(200).optional(),
  notes: z.array(Text(1000)).max(20).optional(),
});
export type ImpulseEvidence = z.infer<typeof ImpulseEvidenceSchema>;

export const ImpulseEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().regex(/^evt_[A-Za-z0-9_-]+$/),
  projectId: Text(200),
  workSessionId: z.string().max(120).nullable(),
  goalId: z.string().max(200).nullable(),
  loopId: z.string().max(200).nullable(),
  phaseId: z.string().max(80).nullable(),
  type: z.enum(IMPULSE_EVENT_TYPES),
  at: IsoTime,
  summary: Text(1000),
  evidence: ImpulseEvidenceSchema.default({}),
  source: z.enum(["goal_intake", "goal_loop", "tool"]),
  dedupeKey: z.string().max(300).nullable().default(null),
});
export type ImpulseEvent = z.infer<typeof ImpulseEventSchema>;

export interface ImpulseEventInput {
  workSessionId?: string | null;
  goalId?: string | null;
  loopId?: string | null;
  phaseId?: string | null;
  type: ImpulseEventType;
  summary: string;
  evidence?: ImpulseEvidence;
  source: ImpulseEvent["source"];
  /** Idempotency key: re-recording the same key returns the existing event. */
  dedupeKey?: string | null;
  at?: string;
}

export const WakeProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().regex(/^wake_[A-Za-z0-9_-]+$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    wake: z.literal(true),
    priority: z.enum(WAKE_PRIORITIES),
    confidence: z.number().min(0).max(1),
    category: z.enum(WAKE_CATEGORIES),
    ruleId: Text(80),
    reason: Text(1000),
    evidence: z.array(Text(1000)).min(1).max(12),
    suggestedNext: Text(500),
    interruptNow: z.boolean(),
    allowedDecisions: z.array(z.enum(DIRECTOR_DECISIONS)).min(1).max(4),
    readScopes: z.array(Text(300)).max(20),
    // Scout is read-only: a proposal can never declare write scopes.
    writeScopes: z.array(z.string()).max(0),
    projectId: Text(200),
    workSessionId: z.string().max(120).nullable(),
    goalId: z.string().max(200).nullable(),
    loopId: z.string().max(200).nullable(),
    phaseId: z.string().max(80).nullable(),
    scopeKey: Text(300),
    triggerEventId: z.string().regex(/^evt_[A-Za-z0-9_-]+$/),
    backend: z.enum(PROPOSAL_BACKENDS),
    /** Semantic proposals only: the review request that solicited it. */
    reviewId: z.string().regex(/^srv_[A-Za-z0-9_-]+$/).nullable().default(null),
    createdAt: IsoTime,
  })
  .superRefine((proposal, issue) => {
    if (proposal.interruptNow && proposal.priority !== "P0") {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "Only P0 proposals may request interruptNow" });
    }
    if (proposal.allowedDecisions.includes("INTERRUPT_P0") && proposal.priority !== "P0") {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "INTERRUPT_P0 is reserved for P0 proposals" });
    }
  });
export type WakeProposal = z.infer<typeof WakeProposalSchema>;

export const SUPPRESSION_REASONS = ["duplicate", "phase-budget", "low-confidence", "event-cap"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const ScoutRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^scout_[A-Za-z0-9_-]+$/),
  at: IsoTime,
  backend: z.literal("native"),
  triggerEventIds: z.array(z.string()).max(100),
  skippedEventIds: z.array(z.string()).max(100),
  contextSources: z.array(z.string().max(120)).max(30),
  proposalIds: z.array(z.string()).max(100),
  suppressed: z
    .array(z.object({
      eventId: z.string(),
      ruleId: z.string().max(80),
      fingerprint: z.string(),
      reason: z.enum(SUPPRESSION_REASONS),
      existingProposalId: z.string().nullable(),
    }))
    .max(200),
  durationMs: z.number().int().nonnegative(),
});
export type ScoutRun = z.infer<typeof ScoutRunSchema>;

const SuppressedEntrySchema = z.object({
  ruleId: z.string(),
  reason: z.enum(SUPPRESSION_REASONS),
  count: z.number().int().positive(),
  lastAt: IsoTime,
  existingProposalId: z.string().nullable(),
});

export const ScoutStateSchema = z.object({
  schemaVersion: z.literal(1),
  processedEventIds: z.array(z.string()).max(MAX_PROCESSED_EVENT_IDS).default([]),
  suppressed: z.record(z.string(), SuppressedEntrySchema).default({}),
  runs: z.number().int().nonnegative().default(0),
  lastRunAt: IsoTime.nullable().default(null),
  lastRunId: z.string().nullable().default(null),
});
export type ScoutState = z.infer<typeof ScoutStateSchema>;

export function emptyScoutState(): ScoutState {
  return { schemaVersion: 1, processedEventIds: [], suppressed: {}, runs: 0, lastRunAt: null, lastRunId: null };
}

export function trimSuppressed(entries: ScoutState["suppressed"]): ScoutState["suppressed"] {
  const sorted = Object.entries(entries).sort((a, b) => Date.parse(b[1].lastAt) - Date.parse(a[1].lastAt));
  return Object.fromEntries(sorted.slice(0, MAX_SUPPRESSED_ENTRIES));
}

/** Scope used for dedupe/budget: the loop when known, otherwise goal, work session, project. */
export function impulseScopeKey(event: Pick<ImpulseEvent, "loopId" | "goalId" | "workSessionId">): string {
  if (event.loopId) return `loop:${event.loopId}`;
  if (event.goalId) return `goal:${event.goalId}`;
  if (event.workSessionId) return `ws:${event.workSessionId}`;
  return "project";
}

export function agentBridgeProjectKey(projectId: string): string {
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/.test(projectId)
    ? `p_${projectId}`
    : `h_${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

async function readTextOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
}

/** Tolerant JSONL parse: malformed or schema-invalid lines are counted and skipped. */
function parseJsonl<T>(raw: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): { records: T[]; corrupt: number } {
  const records: T[] = [];
  let corrupt = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(trimmed));
      if (parsed.success) records.push(parsed.data);
      else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  return { records, corrupt };
}

function cleanText(value: string, max: number): string {
  const cleaned = redact(value).replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function cleanList(values: string[] | undefined, maxItems: number, maxLength: number): string[] | undefined {
  if (!values) return undefined;
  const out = values.map((value) => cleanText(value, maxLength)).filter(Boolean);
  return Array.from(new Set(out)).slice(0, maxItems);
}

export function sanitizeEvidence(evidence: ImpulseEvidence | undefined): ImpulseEvidence {
  if (!evidence) return {};
  const out: ImpulseEvidence = {
    gitCommit: evidence.gitCommit ? cleanText(evidence.gitCommit, 80) : undefined,
    tests: cleanList(evidence.tests, 30, 300),
    changedScopes: cleanList(evidence.changedScopes, 50, 300),
    verificationStatus: evidence.verificationStatus,
    failureCount: evidence.failureCount,
    severity: evidence.severity,
    nextPhase: evidence.nextPhase ? cleanText(evidence.nextPhase, 80) : undefined,
    pending: cleanList(evidence.pending, 50, 500),
    completed: cleanList(evidence.completed, 50, 500),
    droppedPending: cleanList(evidence.droppedPending, 50, 500),
    feedbackKey: evidence.feedbackKey ? cleanText(evidence.feedbackKey, 200) : undefined,
    notes: cleanList(evidence.notes, 20, 1000),
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined && value !== "")) as ImpulseEvidence;
}

const inProcessQueues = new Map<string, Promise<void>>();

export interface AgentBridgeTx {
  readEvents(): Promise<ImpulseEvent[]>;
  readProposals(): Promise<WakeProposal[]>;
  readScoutState(): Promise<ScoutState>;
  appendProposals(proposals: WakeProposal[]): Promise<void>;
  appendRun(run: ScoutRun): Promise<void>;
  writeScoutState(state: ScoutState): Promise<void>;
  /** Generic helpers for other agent-bridge layers (V2 Director). Names must be plain file names. */
  readJsonl<T>(name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]>;
  appendJsonl(name: string, records: unknown[], max: number, keep: number): Promise<void>;
  readText(name: string): Promise<string>;
  writeText(name: string, contents: string): Promise<void>;
}

const PLAIN_FILE_NAME = /^[a-z][a-z0-9_]*\.(jsonl|json)$/;
function assertPlainName(name: string): string {
  if (!PLAIN_FILE_NAME.test(name)) throw new Error(`Invalid agent-bridge file name: ${name}`);
  return name;
}

export interface WakeQueueQuery {
  goalId?: string;
  loopId?: string;
  workSessionId?: string;
  priority?: WakePriority;
  limit?: number;
}

export class AgentBridgeStore {
  readonly dir: string;

  constructor(stateDir: string, readonly projectId: string) {
    Text(200).parse(projectId);
    this.dir = path.join(stateDir, "agent-bridge", agentBridgeProjectKey(projectId));
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  /**
   * Serialize read-modify-write work for this project: in-process promise
   * queue first, then the cross-process owner lock. The owner lock rejects
   * immediately when held by a live process, so short bounded retries are used.
   */
  async transaction<T>(action: (tx: AgentBridgeTx) => Promise<T>): Promise<T> {
    const previous = inProcessQueues.get(this.dir) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
      const lock = await this.acquireLock();
      try {
        return await action(this.tx());
      } finally {
        await lock.release();
      }
    });
    const tail = run.then(() => undefined, () => undefined);
    inProcessQueues.set(this.dir, tail);
    void tail.then(() => {
      if (inProcessQueues.get(this.dir) === tail) inProcessQueues.delete(this.dir);
    });
    return run;
  }

  private async acquireLock(): Promise<{ release(): Promise<void> }> {
    const attempts = 40;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await acquireMassUlwLock({
          path: this.file(LOCK_FILE),
          now: Date.now,
          lockedMessage: "Impulse Scout state is busy in another process",
        });
      } catch (error) {
        if (attempt >= attempts || !(error instanceof Error) || !error.message.includes("Impulse Scout state is busy")) throw error;
        await delay(Math.min(250, 10 * attempt));
      }
    }
  }

  private tx(): AgentBridgeTx {
    return {
      readEvents: () => this.readEvents(),
      readProposals: () => this.readProposals(),
      readScoutState: () => this.readScoutState(),
      appendProposals: (proposals) => this.appendRecords(QUEUE_FILE, proposals.map((p) => WakeProposalSchema.parse(p)), MAX_PROPOSALS, KEEP_PROPOSALS),
      appendRun: (run) => this.appendRecords(RUNS_FILE, [ScoutRunSchema.parse(run)], MAX_RUNS, KEEP_RUNS),
      writeScoutState: (state) => this.atomicWrite(STATE_FILE, JSON.stringify(ScoutStateSchema.parse(state), null, 2)),
      readJsonl: (name, schema) => this.readJsonl(name, schema),
      appendJsonl: (name, records, max, keep) => this.appendRecords(assertPlainName(name), records, max, keep),
      readText: (name) => this.readText(name),
      writeText: (name, contents) => this.atomicWrite(assertPlainName(name), contents),
    };
  }

  /** Lock-free tolerant JSONL read (torn/invalid lines skipped). */
  async readJsonl<T>(name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]> {
    return parseJsonl(await readTextOrEmpty(this.file(assertPlainName(name))), schema).records;
  }

  /** Lock-free raw read; "" when missing. */
  async readText(name: string): Promise<string> {
    return readTextOrEmpty(this.file(assertPlainName(name)));
  }

  async readEvents(): Promise<ImpulseEvent[]> {
    return parseJsonl(await readTextOrEmpty(this.file(EVENTS_FILE)), ImpulseEventSchema).records;
  }

  async readProposals(): Promise<WakeProposal[]> {
    return parseJsonl(await readTextOrEmpty(this.file(QUEUE_FILE)), WakeProposalSchema).records;
  }

  async readRuns(): Promise<ScoutRun[]> {
    return parseJsonl(await readTextOrEmpty(this.file(RUNS_FILE)), ScoutRunSchema).records;
  }

  async readScoutState(): Promise<ScoutState> {
    const raw = await readTextOrEmpty(this.file(STATE_FILE));
    if (!raw.trim()) return emptyScoutState();
    try {
      const parsed = ScoutStateSchema.safeParse(JSON.parse(raw));
      // A corrupt cursor is safe to reset: dedupe is derived from wake_queue.jsonl.
      return parsed.success ? parsed.data : emptyScoutState();
    } catch {
      return emptyScoutState();
    }
  }

  /** Record a checkpoint event. Idempotent when `dedupeKey` was already recorded. */
  async recordEvent(input: ImpulseEventInput): Promise<{ event: ImpulseEvent; duplicate: boolean }> {
    return this.transaction(async () => {
      const dedupeKey = input.dedupeKey ? cleanText(input.dedupeKey, 300) : null;
      if (dedupeKey) {
        const existing = (await this.readEvents()).find((event) => event.dedupeKey === dedupeKey);
        if (existing) return { event: existing, duplicate: true };
      }
      const event = ImpulseEventSchema.parse({
        schemaVersion: 1,
        eventId: `evt_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        projectId: this.projectId,
        workSessionId: input.workSessionId ?? null,
        goalId: input.goalId ?? null,
        loopId: input.loopId ?? null,
        phaseId: input.phaseId ? cleanText(input.phaseId, 80) : null,
        type: input.type,
        at: input.at ?? new Date().toISOString(),
        summary: cleanText(input.summary, 1000) || input.type,
        evidence: sanitizeEvidence(input.evidence),
        source: input.source,
        dedupeKey,
      });
      await this.appendRecords(EVENTS_FILE, [event], MAX_EVENTS, KEEP_EVENTS);
      return { event, duplicate: false };
    });
  }

  /** Read-only wake queue view (no lock, no directory creation). Newest first. */
  async listWakeQueue(query: WakeQueueQuery = {}): Promise<{
    proposals: WakeProposal[];
    total: number;
    counts: Record<WakePriority, number>;
    pendingTriggerEvents: number;
    lastRunAt: string | null;
  }> {
    const [all, events, state] = await Promise.all([this.readProposals(), this.readEvents(), this.readScoutState()]);
    const matching = all.filter((proposal) =>
      (!query.goalId || proposal.goalId === query.goalId) &&
      (!query.loopId || proposal.loopId === query.loopId) &&
      (!query.workSessionId || proposal.workSessionId === query.workSessionId) &&
      (!query.priority || proposal.priority === query.priority));
    const counts: Record<WakePriority, number> = { P0: 0, P1: 0, P2: 0 };
    for (const proposal of matching) counts[proposal.priority] += 1;
    const processed = new Set(state.processedEventIds);
    const limit = Math.max(1, Math.min(query.limit ?? 20, MAX_PROPOSALS));
    return {
      proposals: matching.slice().reverse().slice(0, limit),
      total: matching.length,
      counts,
      pendingTriggerEvents: events.filter((event) => SCOUT_TRIGGER_EVENT_TYPES.has(event.type) && !processed.has(event.eventId)).length,
      lastRunAt: state.lastRunAt,
    };
  }

  private async appendRecords(name: string, records: unknown[], max: number, keep: number): Promise<void> {
    if (records.length === 0) return;
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const target = this.file(name);
    const existing = await readTextOrEmpty(target);
    const lines = records.map((record) => JSON.stringify(record));
    const existingLines = existing.split("\n").filter((line) => line.trim());
    if (existingLines.length + lines.length > max) {
      // Compact: keep the newest `keep` lines atomically.
      const next = [...existingLines, ...lines].slice(-keep);
      await this.atomicWrite(name, `${next.join("\n")}\n`);
      return;
    }
    // Repair a torn trailing line so the new record starts on its own line.
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const handle = await open(target, "a", FILE_MODE);
    try {
      await handle.writeFile(`${prefix}${lines.join("\n")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async atomicWrite(name: string, contents: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const target = this.file(name);
    const tmp = this.file(`.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(tmp, "wx", FILE_MODE);
    try {
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(tmp, target);
    } finally {
      await unlink(tmp).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  }
}
