import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBridgeStore, WakeProposalSchema, agentBridgeProjectKey, impulseScopeKey } from "./agent-bridge-store.js";

const dirs: string[] = [];
async function tempState(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jk-agent-bridge-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function validProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    proposalId: "wake_test",
    fingerprint: "a".repeat(64),
    wake: true,
    priority: "P1",
    confidence: 0.8,
    category: "quality-gap",
    ruleId: "phase-completed-without-qa",
    reason: "reason",
    evidence: ["event evt_1 phase_completed: done"],
    suggestedNext: "verify",
    interruptNow: false,
    allowedDecisions: ["NEXT_PHASE", "BACKLOG", "REJECT"],
    readScopes: [],
    writeScopes: [],
    projectId: "p",
    workSessionId: null,
    goalId: null,
    loopId: null,
    phaseId: null,
    scopeKey: "project",
    triggerEventId: "evt_1",
    backend: "native",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("AgentBridgeStore", () => {
  it("stores events under JK stateDir/agent-bridge and survives a restart", async () => {
    const stateDir = await tempState();
    const first = new AgentBridgeStore(stateDir, "demo-project");
    const { event } = await first.recordEvent({
      type: "phase_completed",
      summary: "Second Arena implemented",
      phaseId: "second-arena",
      loopId: "loop_1",
      source: "tool",
      evidence: { gitCommit: "abc1234", tests: ["Studio Play"], changedScopes: ["Arena2"] },
    });
    expect(first.dir).toBe(path.join(stateDir, "agent-bridge", agentBridgeProjectKey("demo-project")));
    expect((await stat(path.join(first.dir, "events.jsonl"))).isFile()).toBe(true);

    const restarted = new AgentBridgeStore(stateDir, "demo-project");
    const events = await restarted.readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: event.eventId, type: "phase_completed", phaseId: "second-arena", evidence: { gitCommit: "abc1234" } });
    expect(impulseScopeKey(events[0]!)).toBe("loop:loop_1");
  });

  it("is idempotent per dedupeKey across instances", async () => {
    const stateDir = await tempState();
    const a = await new AgentBridgeStore(stateDir, "p").recordEvent({ type: "qa_failed", summary: "tests failed", source: "tool", dedupeKey: "k1" });
    const b = await new AgentBridgeStore(stateDir, "p").recordEvent({ type: "qa_failed", summary: "tests failed again", source: "tool", dedupeKey: "k1" });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.event.eventId).toBe(a.event.eventId);
    expect(await new AgentBridgeStore(stateDir, "p").readEvents()).toHaveLength(1);
  });

  it("serializes concurrent appends without losing events", async () => {
    const stateDir = await tempState();
    const store = new AgentBridgeStore(stateDir, "p");
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      new AgentBridgeStore(stateDir, "p").recordEvent({ type: "builder_idle", summary: `idle ${i}`, source: "tool", dedupeKey: `idle-${i}` })));
    const events = await store.readEvents();
    expect(events).toHaveLength(20);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(20);
  });

  it("redacts secret-looking text in summaries and evidence", async () => {
    const stateDir = await tempState();
    const secret = "ghp_" + "A".repeat(36);
    const { event } = await new AgentBridgeStore(stateDir, "p").recordEvent({
      type: "qa_failed", summary: `token ${secret} leaked`, source: "tool", evidence: { notes: [`note ${secret}`] },
    });
    const raw = await readFile(path.join(new AgentBridgeStore(stateDir, "p").dir, "events.jsonl"), "utf8");
    expect(raw).not.toContain(secret);
    expect(event.summary).not.toContain(secret);
  });

  it("skips torn/corrupt lines and repairs the trailing newline on the next append", async () => {
    const stateDir = await tempState();
    const store = new AgentBridgeStore(stateDir, "p");
    await store.recordEvent({ type: "qa_passed", summary: "ok", source: "tool" });
    const file = path.join(store.dir, "events.jsonl");
    await writeFile(file, `${await readFile(file, "utf8")}{"schemaVersion":1,"eventId":"evt_torn`, "utf8");
    expect(await store.readEvents()).toHaveLength(1);
    await store.recordEvent({ type: "qa_failed", summary: "after crash", source: "tool" });
    const events = await store.readEvents();
    expect(events.map((e) => e.summary)).toEqual(["ok", "after crash"]);
  });

  it("resets a corrupt scout_state cursor instead of failing", async () => {
    const stateDir = await tempState();
    const store = new AgentBridgeStore(stateDir, "p");
    await store.recordEvent({ type: "qa_passed", summary: "ok", source: "tool" });
    await writeFile(path.join(store.dir, "scout_state.json"), "{not json", "utf8");
    expect(await store.readScoutState()).toMatchObject({ schemaVersion: 1, processedEventIds: [], runs: 0 });
  });

  it("listWakeQueue is read-only and does not create state", async () => {
    const stateDir = await tempState();
    const queue = await new AgentBridgeStore(stateDir, "p").listWakeQueue();
    expect(queue).toMatchObject({ total: 0, proposals: [], counts: { P0: 0, P1: 0, P2: 0 } });
    expect(await readdir(stateDir)).toEqual([]);
  });

  it("hashes unsafe project ids into a contained directory name", () => {
    expect(agentBridgeProjectKey("../../etc")).toMatch(/^h_[a-f0-9]{32}$/);
    expect(agentBridgeProjectKey("task_abc-1")).toBe("p_task_abc-1");
  });

  it("proposal schema forbids write scopes and non-P0 interrupts", () => {
    expect(WakeProposalSchema.safeParse(validProposal()).success).toBe(true);
    expect(WakeProposalSchema.safeParse(validProposal({ writeScopes: ["src"] })).success).toBe(false);
    expect(WakeProposalSchema.safeParse(validProposal({ interruptNow: true })).success).toBe(false);
    expect(WakeProposalSchema.safeParse(validProposal({ allowedDecisions: ["INTERRUPT_P0"] })).success).toBe(false);
    expect(WakeProposalSchema.safeParse(validProposal({ evidence: [] })).success).toBe(false);
    expect(WakeProposalSchema.safeParse(validProposal({ priority: "P0", interruptNow: true, allowedDecisions: ["INTERRUPT_P0"] })).success).toBe(true);
    // Pre-V2.1 records have no reviewId; semantic proposals carry backend=semantic.
    expect(WakeProposalSchema.parse(validProposal()).reviewId).toBeNull();
    expect(WakeProposalSchema.safeParse(validProposal({ backend: "semantic", reviewId: "srv_1", category: "product-quality" })).success).toBe(true);
    expect(WakeProposalSchema.safeParse(validProposal({ backend: "llm" })).success).toBe(false);
  });
});
