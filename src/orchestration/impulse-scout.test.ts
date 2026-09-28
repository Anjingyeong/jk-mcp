import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBridgeStore, type ImpulseEventInput } from "../state/agent-bridge-store.js";
import { ProjectMemoryStore } from "../state/project-memory.js";
import { PHASE_WAKE_BUDGET, runImpulseScout, type ScoutContextProvider } from "./impulse-scout.js";

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const NO_CONTEXT: ScoutContextProvider = { sources: [] };
const PROJECT = "scout-project";

async function setup() {
  const stateDir = await tempDir("jk-scout-state-");
  const store = new AgentBridgeStore(stateDir, PROJECT);
  const record = (input: Omit<ImpulseEventInput, "source"> & { source?: ImpulseEventInput["source"] }) =>
    store.recordEvent({ source: "tool", loopId: "loop_a", ...input });
  const scout = (context: ScoutContextProvider = NO_CONTEXT) => runImpulseScout({ stateDir, projectId: PROJECT, context });
  return { stateDir, store, record, scout };
}

describe("Impulse Scout V1", () => {
  it("creates an evidence-backed P1 proposal when a phase completes without QA", async () => {
    const { record, scout, store } = await setup();
    const { event } = await record({ type: "phase_completed", phaseId: "arena", summary: "Second Arena implemented" });
    const run = await scout();
    expect(run.evaluatedEvents).toBe(1);
    expect(run.proposals).toHaveLength(1);
    const [proposal] = run.proposals;
    expect(proposal).toMatchObject({
      wake: true,
      priority: "P1",
      category: "quality-gap",
      ruleId: "phase-completed-without-qa",
      interruptNow: false,
      writeScopes: [],
      allowedDecisions: ["NEXT_PHASE", "BACKLOG", "REJECT"],
      triggerEventId: event.eventId,
      phaseId: "arena",
      loopId: "loop_a",
      backend: "native",
    });
    expect(proposal!.evidence.length).toBeGreaterThan(0);
    expect(proposal!.evidence[0]).toContain(event.eventId);
    expect((await store.listWakeQueue()).total).toBe(1);
  });

  it("stays quiet when the phase already passed QA, and ignores non-trigger events", async () => {
    const { record, scout } = await setup();
    await record({ type: "goal_started", summary: "goal" });
    await record({ type: "phase_started", phaseId: "arena", summary: "start" });
    await record({ type: "user_feedback_received", summary: "UI too big", evidence: { feedbackKey: "ui-too-big" } });
    await record({ type: "qa_passed", phaseId: "arena", summary: "Studio Play passed" });
    await record({ type: "phase_completed", phaseId: "arena", summary: "Arena done" });
    const run = await scout();
    expect(run.evaluatedEvents).toBe(2);
    expect(run.proposals).toEqual([]);
  });

  it("never repeats the same proposal (fingerprint dedupe across runs and events)", async () => {
    const { record, scout, store } = await setup();
    await record({ type: "phase_completed", phaseId: "arena", summary: "Arena done", evidence: { completed: ["Arena"] } });
    const first = await scout();
    expect(first.proposals).toHaveLength(1);

    // Same omission reported again by a later checkpoint in the same scope.
    await record({ type: "phase_completed", phaseId: "arena", summary: "Arena done (again)", evidence: { completed: ["Arena"] } });
    const second = await scout();
    expect(second.proposals).toEqual([]);
    expect(second.suppressed).toEqual([
      expect.objectContaining({ reason: "duplicate", existingProposalId: first.proposals[0]!.proposalId }),
    ]);

    // Running again with nothing new does not re-evaluate processed events.
    const third = await scout();
    expect(third.evaluatedEvents).toBe(0);
    expect((await store.readProposals())).toHaveLength(1);
    expect((await store.readScoutState()).suppressed[first.proposals[0]!.fingerprint]).toMatchObject({ reason: "duplicate", count: 1 });
  });

  it("does not duplicate proposals after a restart or a crash that lost the cursor", async () => {
    const { stateDir, record, scout } = await setup();
    await record({ type: "phase_completed", phaseId: "arena", summary: "Arena done" });
    await record({ type: "large_diff_detected", phaseId: "arena", summary: "900 lines changed", evidence: { changedScopes: ["src/arena"] } });
    const first = await scout();
    expect(first.proposals).toHaveLength(2);

    // Restart: fresh store instances and a fresh run see everything as processed.
    const restarted = await runImpulseScout({ stateDir, projectId: PROJECT, context: NO_CONTEXT });
    expect(restarted.evaluatedEvents).toBe(0);

    // Crash between appending proposals and writing scout_state.json.
    await unlink(path.join(new AgentBridgeStore(stateDir, PROJECT).dir, "scout_state.json"));
    const recovered = await runImpulseScout({ stateDir, projectId: PROJECT, context: NO_CONTEXT });
    expect(recovered.evaluatedEvents).toBe(2);
    expect(recovered.proposals).toEqual([]);
    expect(recovered.suppressed.map((s) => s.reason)).toEqual(["duplicate", "duplicate"]);
    expect(await new AgentBridgeStore(stateDir, PROJECT).readProposals()).toHaveLength(2);
  });

  it("concurrent Scout runs never double-queue a proposal", async () => {
    const { stateDir, record } = await setup();
    await record({ type: "phase_completed", phaseId: "arena", summary: "Arena done" });
    const runs = await Promise.all(Array.from({ length: 5 }, () => runImpulseScout({ stateDir, projectId: PROJECT, context: NO_CONTEXT })));
    expect(runs.reduce((sum, run) => sum + run.proposals.length, 0)).toBe(1);
    expect(await new AgentBridgeStore(stateDir, PROJECT).readProposals()).toHaveLength(1);
  });

  it(`caps wakes at ${PHASE_WAKE_BUDGET} per phase but lets P0 through`, async () => {
    const { record, scout } = await setup();
    await record({ type: "phase_completed", phaseId: "arena", summary: "A done", evidence: { completed: ["A"] } });
    await record({ type: "large_diff_detected", phaseId: "arena", summary: "big diff", evidence: { changedScopes: ["src/a"] } });
    await record({ type: "scope_changed", phaseId: "arena", summary: "pending dropped", evidence: { droppedPending: ["Write docs"] } });
    await record({ type: "regression_detected", phaseId: "arena", summary: "Login broke", evidence: { severity: "major", tests: ["login.e2e"] } });
    const run = await scout();
    const nonP0 = run.proposals.filter((p) => p.priority !== "P0");
    expect(nonP0).toHaveLength(PHASE_WAKE_BUDGET);
    expect(run.suppressed.some((s) => s.reason === "phase-budget" && s.ruleId === "dropped-pending")).toBe(true);
    const p0 = run.proposals.find((p) => p.priority === "P0");
    expect(p0).toMatchObject({ category: "regression", interruptNow: true, allowedDecisions: ["INTERRUPT_P0", "NEXT_PHASE", "BACKLOG", "REJECT"] });
  });

  it("flags repeated verification failures and minor regressions as P1 without interrupt", async () => {
    const { record, scout } = await setup();
    await record({ type: "qa_failed", phaseId: "verify", summary: "unit tests failed" });
    const once = await scout();
    expect(once.proposals).toEqual([]);
    await record({ type: "qa_failed", phaseId: "verify", summary: "unit tests failed again", evidence: { failureCount: 2 } });
    await record({ type: "regression_detected", phaseId: "other", summary: "tooltip misaligned", evidence: { severity: "minor" } });
    const run = await scout();
    expect(run.proposals.map((p) => [p.ruleId, p.priority, p.interruptNow])).toEqual([
      ["repeated-verification-failure", "P1", false],
      ["regression-detected", "P1", false],
    ]);
    expect(run.proposals[0]!.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("P2 proposals only allow BACKLOG/REJECT", async () => {
    const { record, scout } = await setup();
    await record({ type: "scope_changed", summary: "dropped", evidence: { droppedPending: ["Add tests for parser"] } });
    const run = await scout();
    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]).toMatchObject({ priority: "P2", category: "scope-gap", allowedDecisions: ["BACKLOG", "REJECT"] });
    expect(run.proposals[0]!.evidence.some((e) => e.includes("Add tests for parser"))).toBe(true);
  });

  it("matches project known fixes read-only from project memory", async () => {
    const { stateDir, record } = await setup();
    const memory = new ProjectMemoryStore(stateDir);
    const fix = await memory.addKnownFix(PROJECT, {
      title: "EBUSY rename on Windows",
      symptom: "EBUSY rename failed while writing sessions.json",
      solution: "Use renameWithRetry",
      tags: ["windows", "rename"],
    });
    const memoryBefore = await readFile(path.join(stateDir, "project-memory.json"), "utf8");
    await record({ type: "qa_failed", phaseId: "verify", summary: "EBUSY rename failed on Windows" });
    const run = await runImpulseScout({ stateDir, projectId: PROJECT });
    const proposal = run.proposals.find((p) => p.ruleId === "known-fix-match");
    expect(proposal).toMatchObject({ category: "known-fix", priority: "P1" });
    expect(proposal!.evidence.some((e) => e.includes(fix.id))).toBe(true);
    expect(await readFile(path.join(stateDir, "project-memory.json"), "utf8")).toBe(memoryBefore);
  });

  it("uses only repeated, project-scoped feedback as preference evidence", async () => {
    const { record, scout } = await setup();
    await record({ type: "user_feedback_received", summary: "UI is too big", evidence: { feedbackKey: "UI too big" } });
    await record({ type: "phase_completed", phaseId: "hud", summary: "HUD done", evidence: { verificationStatus: "pass" } });
    expect((await scout()).proposals).toEqual([]);

    await record({ type: "user_feedback_received", summary: "UI still too big", evidence: { feedbackKey: "ui too big" } });
    await record({ type: "phase_completed", phaseId: "hud2", summary: "HUD v2 done", evidence: { verificationStatus: "pass" } });
    const run = await scout();
    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]).toMatchObject({ category: "preference-recurrence", priority: "P2" });
    expect(run.proposals[0]!.evidence.filter((e) => e.includes("user_feedback_received"))).toHaveLength(2);
  });

  it("suppresses candidates below the confidence threshold", async () => {
    const { stateDir, record } = await setup();
    await record({ type: "large_diff_detected", summary: "big diff" });
    const run = await runImpulseScout({ stateDir, projectId: PROJECT, context: NO_CONTEXT, confidenceThreshold: 0.95 });
    expect(run.proposals).toEqual([]);
    expect(run.suppressed).toEqual([expect.objectContaining({ reason: "low-confidence", ruleId: "large-diff-review" })]);
  });

  it("writes an audit record and touches nothing outside its agent-bridge directory", async () => {
    const { stateDir, record, scout, store } = await setup();
    const projectRoot = await tempDir("jk-scout-project-");
    await record({ type: "phase_completed", phaseId: "arena", summary: "done" });
    await scout();
    expect(await readdir(projectRoot)).toEqual([]);
    expect(await readdir(stateDir)).toEqual(["agent-bridge"]);
    expect((await readdir(store.dir)).sort()).toEqual(["events.jsonl", "scout_runs.jsonl", "scout_state.json", "wake_queue.jsonl"]);
    const [run] = await store.readRuns();
    expect(run).toMatchObject({ backend: "native", proposalIds: [expect.stringMatching(/^wake_/)], contextSources: ["agent-bridge.events", "agent-bridge.wake_queue"] });
  });
});
