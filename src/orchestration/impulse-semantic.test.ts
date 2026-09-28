import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBridgeStore } from "../state/agent-bridge-store.js";
import { ProjectMemoryStore } from "../state/project-memory.js";
import { createImpulseHarness, IMPULSE_PROJECT_ID as PROJECT } from "./impulse-test-fixture.js";
import { SEMANTIC_REVIEWS_FILE, submitSemanticReview } from "./impulse-semantic.js";

type Harness = Awaited<ReturnType<typeof createImpulseHarness>>;
const harnesses: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await createImpulseHarness();
  harnesses.push(h);
  return h;
}

// Impulse is on by default only in internal builds; pin it so the public export still verifies the hidden feature.
beforeEach(() => {
  vi.stubEnv("JK_DISTRIBUTION", "internal");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of harnesses.splice(0)) await h.close();
});

async function startLoop(h: Harness, goal = "Polish the progression UI") {
  const intake = await h.call("goal_intake", { goal, projectId: PROJECT, mode: "research" });
  const ids = { loopId: intake.loopId as string, workSessionId: intake.workSessionId as string, projectId: PROJECT };
  const turn = (args: Record<string, unknown> = {}, on: Harness = h) => on.call("goal_loop", { ...ids, ...args });
  return { ...ids, turn };
}

type Review = { reviewId: string; reason: string; phase: string | null; question: string; evidence: Record<string, unknown>; submit: string };

const OBSERVATION = {
  category: "preference-mismatch",
  priority: "P1",
  confidence: 0.8,
  reason: "Verification passed, but the repeated feedback 'UI too bright' likely still applies to the new inventory grid.",
  evidence: ["inventory grid uses saturated accent colors", "feedback 'UI too bright' given 2x"],
  suggestedNext: "Lower saturation of the inventory grid accents and re-check against the feedback.",
  subject: "inventory grid too bright",
  scope: ["src/ui/inventory"],
};

const TERMINAL = {
  phase: "release", verificationStatus: "pass", reviewVerdict: "approve", pending: [],
  completionEvidence: { kind: "contract-result", artifacts: ["ui audit"] },
};

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("Semantic Scout request planning", () => {
  it("asks for one compact review at a meaningful checkpoint and stays silent otherwise", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const plain = await loop.turn({ lastResult: "read files" });
    expect(plain.semanticReview).toBeUndefined();

    const done = await loop.turn({ phase: "patch", lastResult: "grid restyled", verificationStatus: "pass", completed: ["Inventory grid"], pending: ["Typography"] });
    const review = done.semanticReview as Review;
    expect(review).toMatchObject({ reason: "work completed + verification passed", phase: "patch", task: "Inventory grid" });
    expect(review.reviewId).toMatch(/^srv_/);
    expect(review.evidence).toMatchObject({ goal: "Polish the progression UI", completed: ["Inventory grid"], verification: "pass", pending: ["Typography"] });
    expect(bytes(review)).toBeLessThan(1_500);
    expect((done.nextActions as string[]).filter((line) => line.startsWith(`Impulse semantic review ${review.reviewId}`))).toHaveLength(1);

    // QA-only passes, re-sent completions, and plain turns do not ask again.
    const again = await loop.turn({ phase: "verify", lastResult: "tweak", verificationStatus: "pass", completed: ["Inventory grid"] });
    expect(again.semanticReview).toBeUndefined();
    expect(JSON.stringify(again.nextActions)).not.toContain("Impulse semantic review");
    expect((await loop.turn({ lastResult: "noop" })).semanticReview).toBeUndefined();

    // Newly completed work is a new checkpoint.
    const next = await loop.turn({ phase: "patch", lastResult: "type", verificationStatus: "pass", completed: ["Inventory grid", "Typography"] });
    expect((next.semanticReview as Review).task).toBe("Typography");
  });

  it("caps reviews per loop, skips while P0/many proposals are undecided, and never on terminal success", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const got: boolean[] = [];
    const done: string[] = [];
    for (const item of ["A", "B", "C", "D", "E"]) {
      done.push(item);
      got.push(Boolean((await loop.turn({ phase: "patch", verificationStatus: "pass", completed: [...done] })).semanticReview));
    }
    expect(got).toEqual([true, true, true, true, false]);

    const other = await startLoop(h, "Second goal for P0 skip");
    await h.call("impulse_event_record", { projectId: PROJECT, loopId: other.loopId, type: "regression_detected", summary: "Login broke", evidence: { severity: "major" } });
    expect((await other.turn({ phase: "patch", verificationStatus: "pass", completed: ["X"] })).semanticReview).toBeUndefined();

    const third = await startLoop(h, "Third goal terminal");
    expect((await third.turn(TERMINAL))).toMatchObject({ terminal: true });
    expect(await new AgentBridgeStore(h.stateDir, PROJECT).readText(SEMANTIC_REVIEWS_FILE)).not.toContain(third.loopId);
  });

  it("includes only recurring, relevant project feedback", async () => {
    const h = await harness();
    const memory = new ProjectMemoryStore(h.stateDir);
    await h.call("project_feedback_record", { projectId: PROJECT, text: "UI too bright", tags: ["ui", "color"] });
    await h.call("project_feedback_record", { projectId: PROJECT, text: "Map feels empty", key: "map empty" });
    await h.call("project_feedback_record", { projectId: PROJECT, text: "Map still feels empty", key: "map empty" });
    const loop = await startLoop(h, "Polish the progression UI colors");
    const once = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["Colors pass 1"] })).semanticReview as Review;
    // "UI too bright" was said once only; "map empty" recurs but is unrelated to this UI phase.
    expect(once.evidence.feedback).toBeUndefined();

    await h.call("project_feedback_record", { projectId: PROJECT, text: "UI is still too bright", key: "ui too bright", tags: ["ui"] });
    expect((await memory.listFeedback(PROJECT)).find((f) => f.key === "ui too bright")?.count).toBe(2);
    const twice = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["Colors pass 1", "Colors pass 2"] })).semanticReview as Review;
    expect(twice.evidence.feedback).toEqual([{ text: "UI is still too bright", count: 2 }]);
  });
});

describe("Semantic Scout submissions", () => {
  it("queues semantic proposals for the Director; nothing becomes work before a decision", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const review = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["Inventory grid"], pending: [] })).semanticReview as Review;

    const submitted = await h.call("impulse_semantic_review", { projectId: PROJECT, reviewId: review.reviewId, observations: [OBSERVATION] });
    expect(submitted).toMatchObject({ duplicate: false, suppressed: [], accepted: [{ priority: "P1", category: "preference-mismatch", recommendedDecision: "NEXT_PHASE" }] });
    const proposalId = (submitted.accepted as Array<{ proposalId: string }>)[0]!.proposalId;

    const detail = await h.call("impulse_wake_queue", { projectId: PROJECT, proposalId });
    expect(detail.proposal).toMatchObject({ backend: "semantic", reviewId: review.reviewId, status: "open", writeScopes: [], interruptNow: false,
      allowedDecisions: ["NEXT_PHASE", "BACKLOG", "REJECT"], readScopes: ["src/ui/inventory"] });
    expect((detail.proposal as { evidence: string[] }).evidence[0]).toMatch(/^semantic review srv_.* of event evt_/);

    // Not a task yet, and the host's own submission is not echoed back as a delta.
    const before = await loop.turn({ lastResult: "submitted review" });
    expect((before.taskState as { pending: string[] }).pending).toEqual([]);
    expect(JSON.stringify(before.nextActions)).not.toContain("Director-approved");
    expect(JSON.stringify(before.impulse ?? {})).not.toContain(proposalId);
    expect(await loop.turn(TERMINAL)).toMatchObject({ terminal: true, terminalStatus: "succeeded" });
  });

  it("only a Director approval turns a semantic proposal into a loop task", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const review = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["Inventory grid"], pending: [] })).semanticReview as Review;
    const { accepted } = await h.call("impulse_semantic_review", { projectId: PROJECT, reviewId: review.reviewId, observations: [OBSERVATION] }) as { accepted: Array<{ proposalId: string }> };
    const decided = await h.call("impulse_director_decide", { projectId: PROJECT, proposalId: accepted[0]!.proposalId, decision: "NEXT_PHASE", reason: "user agreed", approvedScope: ["src/ui/inventory"] });
    const label = (decided.task as { label: string }).label;
    const after = await loop.turn({ lastResult: "approved" });
    expect((after.taskState as { pending: string[] }).pending).toContain(label);
    expect((after.nextActions as string[])[0]).toMatch(/^Director-approved next phase/);
    expect(await loop.turn(TERMINAL)).toMatchObject({ terminal: false, terminalBlockedByDirector: true });
  });

  it("dedupes submissions and observations, filters low confidence, caps accepted, rejects P0 and stale reviews", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const first = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["A"] })).semanticReview as Review;
    const low = { ...OBSERVATION, subject: "low", confidence: 0.3 };
    const extra1 = { ...OBSERVATION, category: "ux-flow", subject: "flow one", priority: "P2" };
    const extra2 = { ...OBSERVATION, category: "goal-fit", subject: "fit two", priority: "P2" };
    const result = await h.call("impulse_semantic_review", { projectId: PROJECT, reviewId: first.reviewId, observations: [OBSERVATION, low, extra1] });
    expect((result.accepted as unknown[])).toHaveLength(2);
    expect(result.suppressed).toEqual([expect.objectContaining({ index: 1, reason: "low-confidence" })]);

    const replay = await h.call("impulse_semantic_review", { projectId: PROJECT, reviewId: first.reviewId, observations: [extra2] });
    expect(replay).toMatchObject({ duplicate: true });
    expect((replay.accepted as unknown[])).toHaveLength(2);

    const second = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["A", "B"] })).semanticReview as Review;
    const again = await h.call("impulse_semantic_review", { projectId: PROJECT, reviewId: second.reviewId, observations: [{ ...OBSERVATION, reason: "Same issue restated in other words for phase b." }, extra2, { ...extra2, subject: "fit three" }] });
    // Same subject restated in another review is a duplicate of the queued proposal.
    expect(again.suppressed).toEqual([expect.objectContaining({ index: 0, reason: "duplicate" })]);
    expect((again.accepted as unknown[])).toHaveLength(2);

    const p0 = await h.callRaw("impulse_semantic_review", { projectId: PROJECT, reviewId: second.reviewId, observations: [{ ...OBSERVATION, priority: "P0" }] });
    expect(p0.isError).toBe(true);
    // Backpressure: with >=3 undecided proposals on the loop, no new review is requested.
    expect((await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["A", "B", "X"] })).semanticReview).toBeUndefined();
    const open = (await h.call("impulse_wake_queue", { projectId: PROJECT, loopId: loop.loopId, status: "open", limit: 50 })).proposals as Array<{ proposalId: string }>;
    for (const { proposalId } of open) await h.call("impulse_director_decide", { projectId: PROJECT, proposalId, decision: "BACKLOG", reason: "later" });
    const third = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["A", "B", "C"] })).semanticReview as Review;
    expect(third).toBeDefined();
    // Review "b" was answered; an unanswered older review is superseded by a newer one.
    const fourth = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["A", "B", "C", "D"] })).semanticReview as Review;
    const stale = await h.callRaw("impulse_semantic_review", { projectId: PROJECT, reviewId: third.reviewId, observations: [{ ...OBSERVATION, subject: "late" }] });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.structuredContent)).toContain("no longer open");
    const capped = await h.call("impulse_semantic_review", { projectId: PROJECT, reviewId: fourth.reviewId,
      observations: [{ ...OBSERVATION, subject: "fresh one" }, { ...OBSERVATION, subject: "fresh two" }, { ...OBSERVATION, subject: "fresh three", confidence: 0.7 }] });
    expect(capped.accepted).toHaveLength(2);
    expect(capped.suppressed).toEqual([expect.objectContaining({ index: 2, reason: "review-cap" })]);
    const missing = await h.callRaw("impulse_semantic_review", { projectId: PROJECT, reviewId: "srv_missing", observations: [OBSERVATION] });
    expect(missing.isError).toBe(true);
  });

  it("semantic proposals do not consume the deterministic phase budget", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const review = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["A"] })).semanticReview as Review;
    await h.call("impulse_semantic_review", { projectId: PROJECT, reviewId: review.reviewId, observations: [OBSERVATION, { ...OBSERVATION, category: "ux-flow", subject: "flow" }] });
    await h.call("impulse_event_record", { projectId: PROJECT, loopId: loop.loopId, phaseId: "patch", type: "large_diff_detected", summary: "900 lines changed" });
    const queue = await new AgentBridgeStore(h.stateDir, PROJECT).readProposals();
    expect(queue.map((p) => [p.backend, p.ruleId])).toEqual(expect.arrayContaining([["native", "large-diff-review"]]));
  });
});

describe("Semantic Scout durability", () => {
  it("review state survives a restart: no re-request for the same phase, submission still works", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const review = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["Grid"] })).semanticReview as Review;
    // Simulate a crash before the loop checkpoint saw the completion: the same completion is replayed after restart.
    const restarted = await h.restart();
    harnesses.push(restarted);
    const semantic = await import("./impulse-semantic.js");
    const replayed = await semantic.planSemanticReview({ stateDir: h.stateDir, projectId: PROJECT, loopId: loop.loopId, goal: "g", events:
      (await new AgentBridgeStore(h.stateDir, PROJECT).readEvents()).filter((e) => e.type === "phase_completed"),
      verificationStatus: "pass", pending: [], loadWorkEvidence: async () => ({ changed: [], verificationCommand: null }) });
    expect(replayed).toBeNull();
    const submitted = await restarted.call("impulse_semantic_review", { projectId: PROJECT, reviewId: review.reviewId, observations: [OBSERVATION] });
    expect((submitted.accepted as unknown[])).toHaveLength(1);
  });

  it("corrupt review state fails closed without breaking goal_loop", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const review = (await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["A"] })).semanticReview as Review;
    await writeFile(path.join(new AgentBridgeStore(h.stateDir, PROJECT).dir, SEMANTIC_REVIEWS_FILE), "{broken", "utf8");
    const turn = await loop.turn({ phase: "patch", verificationStatus: "pass", completed: ["A", "B"] });
    expect(turn.semanticReview).toBeUndefined();
    expect(turn.lifecycle).toBe("reasoning-needed");
    await expect(submitSemanticReview({ stateDir: h.stateDir, projectId: PROJECT, reviewId: review.reviewId, observations: [OBSERVATION as never] }))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_READY" });
  });

  it("JK_SEMANTIC_SCOUT=0 disables semantic review only", async () => {
    vi.stubEnv("JK_SEMANTIC_SCOUT", "0");
    const h = await harness();
    const loop = await startLoop(h);
    const turn = await loop.turn({ phase: "patch", completed: ["X"] });
    expect(turn.semanticReview).toBeUndefined();
    expect(turn.impulse).toBeDefined();
  });
});
