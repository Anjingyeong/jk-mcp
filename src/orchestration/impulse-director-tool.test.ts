import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImpulseHarness, IMPULSE_PROJECT_ID as PROJECT } from "./impulse-test-fixture.js";

type Harness = Awaited<ReturnType<typeof createImpulseHarness>>;
const harnesses: Harness[] = [];
async function harness(options?: { remote?: boolean }): Promise<Harness> {
  const h = await createImpulseHarness(options);
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

/** goal_intake in research mode so contract-result evidence can terminate the loop. */
async function startLoop(h: Harness, goal = "Audit the arena selection flow") {
  const intake = await h.call("goal_intake", { goal, projectId: PROJECT, mode: "research" });
  const ids = { loopId: intake.loopId as string, workSessionId: intake.workSessionId as string, projectId: PROJECT };
  const turn = (args: Record<string, unknown> = {}, on: Harness = h) => on.call("goal_loop", { ...ids, ...args });
  return { ...ids, turn };
}

async function openProposal(h: Harness, loopId: string) {
  const queue = await h.call("impulse_wake_queue", { projectId: PROJECT, loopId, status: "open" });
  const [proposal] = queue.proposals as Array<{ proposalId: string; priority: string; recommendedDecision: string | null }>;
  if (!proposal) throw new Error("expected an open proposal");
  return proposal;
}

async function recordEvent(h: Harness, loopId: string, args: Record<string, unknown>) {
  return h.call("impulse_event_record", { projectId: PROJECT, loopId, ...args });
}

const TERMINAL = {
  phase: "release", verificationStatus: "pass", reviewVerdict: "approve", pending: [],
  completionEvidence: { kind: "contract-result", artifacts: ["audit report"] },
};

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("Impulse Director ↔ goal_loop (V2)", () => {
  it("an undecided proposal never changes pending, nextActions, or terminal completion", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const first = await loop.turn({ phase: "patch", lastResult: "flow mapped", completed: ["Map flow"], pending: ["Write report"] });
    expect(first.impulse).toMatchObject({ newProposals: [expect.objectContaining({ priority: "P1" })] });

    const second = await loop.turn({ lastResult: "report drafted", pending: ["Write report"] });
    expect(second.impulse).toBeUndefined();
    expect((second.taskState as { pending: string[] }).pending).toEqual(["Write report"]);
    expect(JSON.stringify(second.nextActions)).not.toMatch(/Director-approved|impulse_director_decide/);

    const done = await loop.turn(TERMINAL);
    expect(done).toMatchObject({ terminal: true, terminalStatus: "succeeded" });
  });

  it("an approved NEXT_PHASE task is injected into pending/nextActions, blocks terminal, and completes by label", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    await loop.turn({ phase: "patch", lastResult: "flow mapped", completed: ["Map flow"], pending: [] });
    const proposal = await openProposal(h, loop.loopId);
    expect(proposal.recommendedDecision).toBe("NEXT_PHASE");

    const decided = await h.call("impulse_director_decide", {
      projectId: PROJECT, proposalId: proposal.proposalId, decision: "NEXT_PHASE",
      reason: "Unverified phase blocks the audit goal", approvedScope: ["src/arena"], constraints: ["No backend redesign"],
    });
    const task = decided.task as { taskId: string; label: string };
    expect(task.label).toContain(task.taskId);
    expect(h.ledger.some((e) => e.type === "impulse.director.decision" && e.taskId === task.taskId)).toBe(true);

    // Caller tries to finish without doing the approved work.
    const blocked = await loop.turn(TERMINAL);
    expect(blocked).toMatchObject({ terminal: false, terminalBlockedByDirector: true });
    expect(blocked.impulse).toMatchObject({
      decisions: [{ proposalId: proposal.proposalId, decision: "NEXT_PHASE", taskId: task.taskId }],
      cycles: { used: 1, max: 3, remaining: 2 },
      open: { tasks: 1 },
    });
    expect((blocked.taskState as { pending: string[] }).pending).toContain(task.label);
    expect((blocked.nextActions as string[])[0]).toMatch(new RegExp(`^Director-approved next phase ${task.taskId} \\(cycle 1/3\\).*No backend redesign`));

    // Dropping the label from pending does not drop the task; the task line persists, the delta does not.
    const dropped = await loop.turn({ lastResult: "moving on", pending: ["Other"] });
    expect((dropped.taskState as { pending: string[] }).pending).toEqual(["Other", task.label]);
    expect((dropped.nextActions as string[])[0]).toMatch(/^Director-approved next phase/);
    expect(dropped.impulse).toBeUndefined();

    const completed = await loop.turn({ lastResult: "verified arena phase", verificationStatus: "pass", completed: [task.label], pending: ["Other"] });
    expect((completed.taskState as { pending: string[] }).pending).toEqual(["Other"]);
    expect(completed.impulse).toMatchObject({ tasksCompleted: [task.taskId], open: { tasks: 0 } });
    const detail = await h.call("impulse_wake_queue", { projectId: PROJECT, proposalId: proposal.proposalId });
    expect(detail).toMatchObject({ proposal: { status: "completed" }, task: { status: "completed" } });

    expect(await loop.turn(TERMINAL)).toMatchObject({ terminal: true, terminalStatus: "succeeded" });
  });

  it("surfaces P0 interrupts first and notices a new undecided P0 exactly once", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    await recordEvent(h, loop.loopId, { type: "regression_detected", phaseId: "patch", summary: "Checkout flow broke", evidence: { severity: "major" } });
    const undecided = await loop.turn({ lastResult: "noticed regression" });
    expect((undecided.nextActions as string[]).filter((a) => a.startsWith("Impulse Scout raised 1 new undecided P0"))).toHaveLength(1);
    expect(undecided.impulse).toMatchObject({ newProposals: [expect.objectContaining({ priority: "P0", recommendedDecision: "INTERRUPT_P0" })], open: { P0: 1 } });

    const repeat = await loop.turn({ lastResult: "still looking" });
    expect((repeat.nextActions as string[]).some((a) => a.startsWith("Impulse Scout raised"))).toBe(false);
    expect(repeat.impulse).toBeUndefined();

    const proposal = await openProposal(h, loop.loopId);
    await h.call("impulse_director_decide", {
      projectId: PROJECT, proposalId: proposal.proposalId, decision: "INTERRUPT_P0", reason: "regression", approvedScope: ["src/checkout"],
    });
    const next = await loop.turn({ lastResult: "ack" });
    const actions = next.nextActions as string[];
    expect(actions[0]).toMatch(/^Director-approved P0 interrupt dt_/);
    expect(actions.some((a) => a.startsWith("Impulse Scout raised"))).toBe(false);
  });

  it("dispatcher mode keeps Director actions in its compact nextActions", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    await loop.turn({ phase: "patch", completed: ["Map flow"], pending: [] });
    const proposal = await openProposal(h, loop.loopId);
    await h.call("impulse_director_decide", { projectId: PROJECT, proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] });
    const turn = await loop.turn({ coordinationMode: "dispatcher", lastResult: "continue" });
    expect((turn.nextActions as string[]).some((a) => a.startsWith("Director-approved next phase"))).toBe(true);
  });

  it("remote callers cannot release protected scopes or approve P2 work; policy/decisions stay out of the repo", async () => {
    const h = await harness({ remote: true });
    const baseline = await h.gitStatus();
    const loop = await startLoop(h);
    await h.call("impulse_director_policy", { projectId: PROJECT, action: "update", addProtectedScopes: ["src/billing"] });
    const release = await h.callRaw("impulse_director_policy", { projectId: PROJECT, action: "update", removeProtectedScopes: ["src/billing"] });
    expect(release.isError).toBe(true);
    expect(JSON.stringify(release.structuredContent)).toContain("PERMISSION_DENIED");

    await recordEvent(h, loop.loopId, { type: "scope_changed", summary: "dropped", evidence: { droppedPending: ["Write tests"] } });
    const p2 = await openProposal(h, loop.loopId);
    expect(p2.priority).toBe("P2");
    const denied = await h.callRaw("impulse_director_decide", {
      projectId: PROJECT, proposalId: p2.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"],
    });
    expect(denied.isError).toBe(true);

    const policy = await h.call("impulse_director_policy", { projectId: PROJECT, action: "get", loopId: loop.loopId });
    expect(policy).toMatchObject({ policy: { protectedScopes: ["src/billing"], maxCyclesPerLoop: 3 }, cycles: { used: 0, max: 3 } });
    const reset = await h.callRaw("impulse_director_policy", { projectId: PROJECT, action: "reset_cycles", loopId: loop.loopId });
    expect(reset.isError).toBe(true);
    expect(await h.gitStatus()).toBe(baseline);
  });
});

describe("V2 compactness and resume QA", () => {
  it("repeated no-change goal_loop turns do not re-send Impulse information", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const first = await loop.turn({ phase: "patch", completed: ["Map flow"], pending: ["Write report"] });
    expect(first.impulse).toBeDefined();
    for (let i = 0; i < 5; i += 1) {
      const turn = await loop.turn({ lastResult: `no-op ${i}` });
      expect(turn.impulse).toBeUndefined();
      expect(JSON.stringify(turn)).not.toContain("wake_");
    }
    // A real change (budget update) is delivered once, then quiet again.
    await h.call("impulse_director_policy", { projectId: PROJECT, action: "update", maxCyclesPerLoop: 5 });
    expect((await loop.turn({ lastResult: "after policy" })).impulse).toMatchObject({ cycles: { used: 0, max: 5, remaining: 5 } });
    expect((await loop.turn({ lastResult: "quiet" })).impulse).toBeUndefined();
  });

  it("wake_queue defaults to a compact 5-item page; full evidence only via proposalId", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    for (let i = 0; i < 12; i += 1) {
      await recordEvent(h, loop.loopId, { type: "phase_completed", phaseId: `phase-${i}`, summary: `Phase ${i} implemented: arena selection, HUD layout and result screen polish` });
    }
    await recordEvent(h, loop.loopId, { type: "regression_detected", phaseId: "reg", summary: "Login broke", evidence: { severity: "major" } });
    const queue = await h.call("impulse_wake_queue", { projectId: PROJECT });
    const proposals = queue.proposals as Array<Record<string, unknown>>;
    expect(queue).toMatchObject({ total: 13, returned: 5, matching: 13, statusCounts: { open: 13 } });
    expect(proposals[0]).toMatchObject({ priority: "P0", recommendedDecision: "INTERRUPT_P0" });
    for (const proposal of proposals) {
      expect(Object.keys(proposal).sort()).toEqual(["priority", "proposalId", "reason", "recommendedDecision", "status"]);
      expect((proposal.reason as string).length).toBeLessThanOrEqual(140);
    }
    const serialized = JSON.stringify(queue);
    for (const detailOnly of ["evidence", "suggestedNext", "checks", "fingerprint", "allowedDecisions", "readScopes"]) {
      expect(serialized).not.toContain(`"${detailOnly}"`);
    }
    expect(bytes(queue)).toBeLessThan(2_000);

    const detail = await h.call("impulse_wake_queue", { projectId: PROJECT, proposalId: proposals[1]!.proposalId });
    expect(detail.proposal).toMatchObject({ evidence: expect.any(Array), suggestedNext: expect.any(String), recommendation: { checks: expect.any(Array) } });
    expect(detail.decisions).toEqual([]);
    const missing = await h.callRaw("impulse_wake_queue", { projectId: PROJECT, proposalId: "wake_missing" });
    expect(missing.isError).toBe(true);
  });

  it("a new chat sees pending Director tasks and undecided P0 on project_select / session_resume", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    const quiet = await h.call("project_select", { projectId: PROJECT, reason: "before any proposal" });
    expect(quiet.impulse).toBeUndefined();

    await loop.turn({ phase: "patch", completed: ["Map flow"], pending: [] });
    const p1 = await openProposal(h, loop.loopId);
    await h.call("impulse_director_decide", { projectId: PROJECT, proposalId: p1.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src/arena"] });
    await recordEvent(h, loop.loopId, { type: "regression_detected", phaseId: "reg", summary: "Login broke", evidence: { severity: "major" } });

    // New chat: no loopId/proposal known yet; the first calls must reveal the unresolved state.
    const selected = await h.client.callTool({ name: "project_select", arguments: { projectId: PROJECT, reason: "new chat", workSessionId: loop.workSessionId } });
    const impulse = (selected.structuredContent as Record<string, unknown>).impulse as Record<string, unknown>;
    expect(impulse).toMatchObject({
      pendingDirectorTasks: 1, unresolvedP0: 1, openProposals: 1,
      loops: [{ loopId: loop.loopId, pendingTasks: 1, unresolvedP0: 1, cyclesRemaining: 2 }],
      hint: expect.stringContaining("impulse_director_decide"),
    });
    expect(bytes(impulse)).toBeLessThan(500);
    expect(JSON.stringify(impulse)).not.toMatch(/"evidence"|"wake_|suggestedNext/);
    expect(JSON.stringify(selected.content)).toContain("1 pending Director task(s), 1 undecided P0");

    const resumed = await h.call("session_resume", { projectId: PROJECT, workSessionId: loop.workSessionId });
    expect(resumed.impulse).toMatchObject({ pendingDirectorTasks: 1, unresolvedP0: 1 });
  });

  it("decision, task, cycle, and delivery state survive a JK restart", async () => {
    const h = await harness();
    const loop = await startLoop(h);
    await loop.turn({ phase: "patch", completed: ["Map flow"], pending: [] });
    const proposal = await openProposal(h, loop.loopId);
    const decided = await h.call("impulse_director_decide", { projectId: PROJECT, proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] });
    const task = decided.task as { taskId: string; label: string };
    expect((await loop.turn({ lastResult: "delivered" })).impulse).toBeDefined();

    const restarted = await h.restart();
    harnesses.push(restarted);
    const after = await loop.turn({ lastResult: "after restart" }, restarted);
    expect(after.impulse).toBeUndefined();
    expect((after.taskState as { pending: string[] }).pending).toContain(task.label);
    expect((after.nextActions as string[])[0]).toMatch(new RegExp(`^Director-approved next phase ${task.taskId} \\(cycle 1/3\\)`));
    const policy = await restarted.call("impulse_director_policy", { projectId: PROJECT, action: "get", loopId: loop.loopId });
    expect(policy.cycles).toMatchObject({ used: 1, remaining: 2 });
    const repeat = await restarted.call("impulse_director_decide", { projectId: PROJECT, proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "again", approvedScope: ["src"] });
    expect(repeat).toMatchObject({ duplicate: true, task: { taskId: task.taskId } });

    const done = await loop.turn({ lastResult: "done", completed: [task.label], pending: [] }, restarted);
    expect(done.impulse).toMatchObject({ tasksCompleted: [task.taskId] });
    expect(await loop.turn(TERMINAL, restarted)).toMatchObject({ terminal: true, terminalStatus: "succeeded" });
  });

  it("JK_IMPULSE_SCOUT=0 keeps goal_loop identical to the pre-Impulse contract", async () => {
    // Same scripted loop with Impulse on and off; strip only Impulse fields and volatile ids.
    const script = async (h: Harness) => {
      const loop = await startLoop(h, "Audit on/off parity");
      const turns = [
        await loop.turn({ phase: "patch", completed: ["Map flow"], pending: ["Write report"] }),
        await loop.turn({ lastResult: "draft", verificationStatus: "fail" }),
        await loop.turn({ lastResult: "fixed", verificationStatus: "pass", pending: ["Write report"] }),
        await loop.turn(TERMINAL),
      ];
      const selected = await h.call("project_select", { projectId: PROJECT, reason: "parity" });
      return { turns, selected, loop };
    };
    const normalize = (value: unknown, loop: { loopId: string; workSessionId: string }) =>
      JSON.parse(JSON.stringify(value, (key, v) => (key === "impulse" ? undefined : v))
        .replaceAll(loop.loopId, "<loop>").replaceAll(loop.workSessionId, "<ws>")
        .replace(/"(at|updatedAt|expiresAt|issuedAt|lastActivityAt|leaseId|createdAt)":("[^"]*"|\d+)/g, '"$1":"<t>"')
        .replace(/goal_[A-Za-z0-9_-]+/g, "<goal>").replace(/lease_[A-Za-z0-9_-]+/g, "<lease>"));

    const on = await harness();
    const withImpulse = await script(on);
    expect(withImpulse.turns[0]!.impulse).toBeDefined();

    vi.stubEnv("JK_IMPULSE_SCOUT", "0");
    const off = await harness();
    const without = await script(off);
    expect(without.turns.every((turn) => turn.impulse === undefined)).toBe(true);
    expect(without.selected.impulse).toBeUndefined();
    expect(without.turns.map((t) => [t.lifecycle, t.terminal, t.terminalStatus, (t.taskState as { pending?: string[] } | undefined)?.pending]))
      .toEqual(withImpulse.turns.map((t) => [t.lifecycle, t.terminal, t.terminalStatus, (t.taskState as { pending?: string[] } | undefined)?.pending]));
    // Only Impulse-owned one-shot lines may differ; every other nextAction line must be identical.
    const coreActions = (actions: unknown) => (actions as string[]).filter((line) => !line.startsWith("Impulse semantic review "));
    expect(withImpulse.turns[0]!.semanticReview).toBeDefined();
    expect(without.turns.every((turn) => turn.semanticReview === undefined)).toBe(true);
    expect(without.turns.map((t) => normalize(coreActions(t.nextActions), without.loop)))
      .toEqual(withImpulse.turns.map((t) => normalize(coreActions(t.nextActions), withImpulse.loop)));
    expect(without.turns[3]).toMatchObject({ terminal: true, terminalStatus: "succeeded" });
  });
});
