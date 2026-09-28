import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBridgeStore, type ImpulseEventInput, type WakeProposal } from "../state/agent-bridge-store.js";
import { runImpulseScout } from "./impulse-scout.js";
import {
  annotateProposals,
  decideProposal,
  directorNextActions,
  readDirectorLoopView,
  resetDirectorCycles,
  scopesOverlap,
  syncDirectorTasks,
  updateDirectorPolicy,
  type DecideInput,
} from "./impulse-director.js";

const PROJECT = "director-project";
const LOOP = "loop_dir";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "jk-director-"));
  dirs.push(stateDir);
  const store = new AgentBridgeStore(stateDir, PROJECT);
  const record = (input: Omit<ImpulseEventInput, "source">) => store.recordEvent({ source: "tool", loopId: LOOP, ...input });
  const scout = () => runImpulseScout({ stateDir, projectId: PROJECT, context: { sources: [] } });
  const decide = (input: Omit<DecideInput, "stateDir" | "projectId" | "caller"> & { caller?: DecideInput["caller"] }) =>
    decideProposal({ stateDir, projectId: PROJECT, caller: "remote", ...input });
  /** One P1 (phase-completed-without-qa) proposal per phase. */
  const p1 = async (phaseId: string): Promise<WakeProposal> => {
    await record({ type: "phase_completed", phaseId, summary: `${phaseId} done` });
    const [proposal] = (await scout()).proposals;
    if (!proposal) throw new Error("expected proposal");
    return proposal;
  };
  const p2 = async (): Promise<WakeProposal> => {
    await record({ type: "scope_changed", phaseId: "p2", summary: "dropped", evidence: { droppedPending: ["Write parser tests"] } });
    return (await scout()).proposals[0]!;
  };
  const p0 = async (): Promise<WakeProposal> => {
    await record({ type: "regression_detected", phaseId: "p0", summary: "Login broke", evidence: { severity: "major" } });
    return (await scout()).proposals[0]!;
  };
  return { stateDir, store, record, scout, decide, p1, p2, p0 };
}

async function expectDenied(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: "PERMISSION_DENIED", message: expect.stringMatching(message) });
}

describe("Impulse Director V2", () => {
  it("the Scout alone never creates Director tasks or decisions", async () => {
    const { stateDir, store, p1, p0 } = await setup();
    await p1("arena");
    await p0();
    const view = await readDirectorLoopView(stateDir, PROJECT, LOOP);
    expect(view.openTasks).toEqual([]);
    expect(view.openProposals).toEqual({ P0: 1, P1: 1, P2: 0 });
    expect(await readdir(store.dir)).not.toContain("decisions.jsonl");
  });

  it("creates a task only for NEXT_PHASE / INTERRUPT_P0 approvals", async () => {
    const { stateDir, decide, p1, p0 } = await setup();
    const backlog = await decide({ proposalId: (await p1("a")).proposalId, decision: "BACKLOG", reason: "later" });
    expect(backlog.task).toBeNull();
    expect(backlog.proposalStatus).toBe("backlog");

    const approved = await decide({ proposalId: (await p1("b")).proposalId, decision: "NEXT_PHASE", reason: "goal-critical", approvedScope: ["src/arena"] });
    expect(approved.task).toMatchObject({ decision: "NEXT_PHASE", status: "approved", loopId: LOOP, cycle: 1, approvedScope: ["src/arena"] });
    expect(approved.task!.label).toMatch(/^\[director:dt_[A-Za-z0-9_-]+\] /);

    const interrupt = await decide({ proposalId: (await p0()).proposalId, decision: "INTERRUPT_P0", reason: "regression", approvedScope: ["src/auth"] });
    expect(interrupt.task).toMatchObject({ decision: "INTERRUPT_P0", cycle: null });

    const view = await readDirectorLoopView(stateDir, PROJECT, LOOP);
    expect(view.openTasks.map((t) => t.decision)).toEqual(["INTERRUPT_P0", "NEXT_PHASE"]);
    const actions = directorNextActions(view);
    expect(actions[0]).toMatch(/^Director-approved P0 interrupt dt_/);
    expect(actions[1]).toMatch(/^Director-approved next phase dt_.*\(cycle 1\/3\)/);
  });

  it("P2 can never be approved for execution and INTERRUPT_P0 is P0-only", async () => {
    const { decide, p1, p2 } = await setup();
    const low = await p2();
    expect(low.priority).toBe("P2");
    await expectDenied(decide({ proposalId: low.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] }), /not allowed for a P2/);
    await expectDenied(decide({ proposalId: low.proposalId, decision: "INTERRUPT_P0", reason: "x", approvedScope: ["src"] }), /not allowed for a P2/);
    expect((await decide({ proposalId: low.proposalId, decision: "BACKLOG", reason: "nice to have" })).task).toBeNull();
    // Promotion from backlog still honors allowedDecisions.
    await expectDenied(decide({ proposalId: low.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] }), /not allowed for a P2/);
    const mid = await p1("a");
    await expectDenied(decide({ proposalId: mid.proposalId, decision: "INTERRUPT_P0", reason: "x", approvedScope: ["src"] }), /not allowed for a P1/);
  });

  it("keeps protected scopes: approvals overlapping them are refused and removal is local-only", async () => {
    const { stateDir, decide, p1 } = await setup();
    await updateDirectorPolicy({ stateDir, projectId: PROJECT, caller: "remote", addProtectedScopes: ["src/billing", "Arena2"] });
    const proposal = await p1("a");
    for (const scope of ["src/billing", "src/billing/api.ts", "src", "arena2", "src\\billing\\"]) {
      await expectDenied(decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: [scope] }), /protected scope/);
    }
    await expectDenied(decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: [] }), /approvedScope is required/);
    const ok = await decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src/billing-ui"] });
    expect(ok.task!.constraints).toContain("Protected scopes (do not modify): src/billing, Arena2");

    await expectDenied(updateDirectorPolicy({ stateDir, projectId: PROJECT, caller: "remote", removeProtectedScopes: ["src/billing"] }), /local JK caller/);
    const released = await updateDirectorPolicy({ stateDir, projectId: PROJECT, caller: "local", removeProtectedScopes: ["SRC/billing"] });
    expect(released.policy.protectedScopes).toEqual(["Arena2"]);
  });

  it("fails closed when the policy file is corrupt", async () => {
    const { stateDir, store, decide, p1 } = await setup();
    const proposal = await p1("a");
    await writeFile(path.join(store.dir, "director_policy.json"), "{broken", "utf8");
    await expect(decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] }))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_READY" });
    await expect(updateDirectorPolicy({ stateDir, projectId: PROJECT, caller: "local", addProtectedScopes: ["x"] }))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_READY" });
  });

  it("enforces the per-loop cycle budget, exempts P0, and resets only with a reason", async () => {
    const { stateDir, decide, p1, p0 } = await setup();
    await updateDirectorPolicy({ stateDir, projectId: PROJECT, caller: "remote", maxCyclesPerLoop: 2 });
    const approve = async (phase: string) => decide({ proposalId: (await p1(phase)).proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] });
    expect((await approve("a")).cycles).toMatchObject({ used: 1, max: 2, remaining: 1 });
    expect((await approve("b")).cycles).toMatchObject({ used: 2, exhausted: true });
    const third = await p1("c");
    await expectDenied(decide({ proposalId: third.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] }), /cycle budget exhausted/);
    expect((await decide({ proposalId: third.proposalId, decision: "BACKLOG", reason: "budget" })).task).toBeNull();
    expect((await decide({ proposalId: (await p0()).proposalId, decision: "INTERRUPT_P0", reason: "regression", approvedScope: ["src/auth"] })).task).not.toBeNull();

    await expectDenied(resetDirectorCycles({ stateDir, projectId: PROJECT, loopId: LOOP, reason: "   ", caller: "remote" }), /reason is required/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reset = await resetDirectorCycles({ stateDir, projectId: PROJECT, loopId: LOOP, reason: "user approved 2 more cycles", caller: "remote" });
    expect(reset).toMatchObject({ used: 0, remaining: 2, resets: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await decide({ proposalId: third.proposalId, decision: "NEXT_PHASE", reason: "promoted", approvedScope: ["src"] })).task).toMatchObject({ cycle: 1 });
  });

  it("allows one live decision per proposal: idempotent repeats, backlog promotion, cancel-only after approval", async () => {
    const { stateDir, decide, p1 } = await setup();
    const proposal = await p1("a");
    const first = await decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] });
    const repeat = await decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "again", approvedScope: ["src"] });
    expect(repeat.duplicate).toBe(true);
    expect(repeat.task?.taskId).toBe(first.task!.taskId);
    await expectDenied(decide({ proposalId: proposal.proposalId, decision: "BACKLOG", reason: "x" }), /already decided as NEXT_PHASE/);

    const cancel = await decide({ proposalId: proposal.proposalId, decision: "REJECT", reason: "user descoped" });
    expect(cancel.proposalStatus).toBe("cancelled");
    expect((await readDirectorLoopView(stateDir, PROJECT, LOOP)).openTasks).toEqual([]);
    await expectDenied(decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] }), /already decided as REJECT/);
    // Cancellation does not refund the consumed cycle.
    expect((await readDirectorLoopView(stateDir, PROJECT, LOOP)).cycles.used).toBe(1);

    const other = await p1("b");
    await decide({ proposalId: other.proposalId, decision: "BACKLOG", reason: "later" });
    expect((await decide({ proposalId: other.proposalId, decision: "REJECT", reason: "no longer needed" })).proposalStatus).toBe("rejected");
  });

  it("serializes concurrent conflicting decisions", async () => {
    const { stateDir, decide, p1 } = await setup();
    const proposal = await p1("a");
    const results = await Promise.allSettled([
      decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src/a"] }),
      decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "y", approvedScope: ["src/b"] }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect((await readDirectorLoopView(stateDir, PROJECT, LOOP)).openTasks).toHaveLength(1);
  });

  it("refuses approvals for loops that already succeeded or proposals without a loop", async () => {
    const { stateDir, store, decide, p1, scout } = await setup();
    const proposal = await p1("a");
    await mkdir(path.join(stateDir, "goals"), { recursive: true });
    await writeFile(path.join(stateDir, "goals", `${LOOP}.loop.json`), JSON.stringify({ lifecycle: "succeeded" }), "utf8");
    await expectDenied(decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] }), /already succeeded/);

    await store.recordEvent({ source: "tool", type: "phase_completed", phaseId: "free", summary: "unbound" });
    const unbound = (await scout()).proposals[0]!;
    expect(unbound.loopId).toBeNull();
    await expectDenied(decide({ proposalId: unbound.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] }), /needs a target goal loop/);
    expect((await decide({ proposalId: unbound.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"], loopId: "loop_other" })).task)
      .toMatchObject({ loopId: "loop_other" });
  });

  it("task status moves approved → injected → completed and terminal states are final", async () => {
    const { stateDir, decide, p1 } = await setup();
    const proposal = await p1("a");
    const { task } = await decide({ proposalId: proposal.proposalId, decision: "NEXT_PHASE", reason: "x", approvedScope: ["src"] });
    await syncDirectorTasks({ stateDir, projectId: PROJECT, loopRevision: 2, injectedTaskIds: [task!.taskId], completedTaskIds: [] });
    expect((await readDirectorLoopView(stateDir, PROJECT, LOOP)).openTasks[0]?.status).toBe("injected");
    await syncDirectorTasks({ stateDir, projectId: PROJECT, loopRevision: 3, injectedTaskIds: [], completedTaskIds: [task!.taskId] });
    await syncDirectorTasks({ stateDir, projectId: PROJECT, loopRevision: 4, injectedTaskIds: [task!.taskId], completedTaskIds: [] });
    expect((await readDirectorLoopView(stateDir, PROJECT, LOOP)).openTasks).toEqual([]);
    const [annotated] = await annotateProposals(stateDir, PROJECT, [proposal]);
    expect(annotated).toMatchObject({ status: "completed", taskId: task!.taskId, recommendation: null });
    await expectDenied(decide({ proposalId: proposal.proposalId, decision: "REJECT", reason: "x" }), /already decided/);
  });

  it("recommends per Director Policy without deciding", async () => {
    const { stateDir, p1, p2, p0, store } = await setup();
    const proposals = [await p1("a"), await p2(), await p0()];
    const annotated = await annotateProposals(stateDir, PROJECT, proposals);
    expect(annotated.map((p) => [p.priority, p.status, p.recommendation?.decision])).toEqual([
      ["P1", "open", "NEXT_PHASE"],
      ["P2", "open", "BACKLOG"],
      ["P0", "open", "INTERRUPT_P0"],
    ]);
    expect(annotated[0]!.recommendation!.checks.map((c) => c.id)).toEqual([
      "goal-linked", "evidence", "not-already-planned", "protected-scope", "urgency", "value", "not-recently-rejected", "cycle-budget",
    ]);
    await updateDirectorPolicy({ stateDir, projectId: PROJECT, caller: "remote", maxCyclesPerLoop: 0 });
    const [exhausted] = await annotateProposals(stateDir, PROJECT, [proposals[0]!]);
    expect(exhausted!.recommendation!.decision).toBe("BACKLOG");
    expect(await readdir(store.dir)).not.toContain("decisions.jsonl");
  });

  it("matches scope overlap by path prefix in both directions", () => {
    expect(scopesOverlap("src/billing", "src/billing/x")).toBe(true);
    expect(scopesOverlap("src", "src/billing")).toBe(true);
    expect(scopesOverlap("src/billing-ui", "src/billing")).toBe(false);
    expect(scopesOverlap("./SRC/Billing/", "src\\billing")).toBe(true);
  });
});
