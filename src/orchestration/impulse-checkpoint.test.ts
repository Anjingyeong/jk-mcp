import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBridgeStore } from "../state/agent-bridge-store.js";
import { goalLoopCheckpointEvents, impulseScoutEnabled, recordImpulseCheckpoint } from "./impulse-checkpoint.js";
import { createImpulseHarness } from "./impulse-test-fixture.js";

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// Impulse is on by default only in internal builds; pin it so the public export still verifies the hidden feature.
beforeEach(() => {
  vi.stubEnv("JK_DISTRIBUTION", "internal");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const base = { loopId: "loop_x", goalId: "goal_x", workSessionId: "ws_x", previousCompleted: [], previousPending: [] };

describe("goalLoopCheckpointEvents", () => {
  it("maps verification, completion, phase change, and dropped pending into events", () => {
    const events = goalLoopCheckpointEvents({
      ...base,
      revision: 3,
      phase: "verify",
      previousPhase: "patch",
      verificationStatus: "fail",
      failureCount: 2,
      lastResult: "npm test failed",
      completed: ["A"],
      previousCompleted: [],
      pending: ["C"],
      previousPending: ["A", "B", "C", "Operational drift: x"],
    });
    expect(events.map((e) => e.type)).toEqual(["phase_started", "qa_failed", "phase_completed", "scope_changed"]);
    expect(events.every((e) => e.source === "goal_loop" && e.loopId === "loop_x" && e.phaseId === "verify")).toBe(true);
    expect(events.find((e) => e.type === "scope_changed")?.evidence?.droppedPending).toEqual(["B"]);
    expect(events.find((e) => e.type === "qa_failed")?.dedupeKey).toBe("goal_loop:loop_x:r3:qa_failed");
  });

  it("emits nothing for an unchanged turn and builder_blocked for blocked", () => {
    expect(goalLoopCheckpointEvents({ ...base, revision: 2 })).toEqual([]);
    expect(goalLoopCheckpointEvents({ ...base, revision: 2, verificationStatus: "blocked" }).map((e) => e.type)).toEqual(["builder_blocked"]);
  });
});

describe("recordImpulseCheckpoint", () => {
  it("is idempotent for a replayed loop revision", async () => {
    const stateDir = await tempDir("jk-impulse-hook-");
    const events = goalLoopCheckpointEvents({ ...base, revision: 1, phase: "patch", completed: ["A"] });
    const first = await recordImpulseCheckpoint({ stateDir, projectId: "p", events, context: { sources: [] } });
    const replay = await recordImpulseCheckpoint({ stateDir, projectId: "p", events, context: { sources: [] } });
    expect(first?.newProposals).toBe(1);
    expect(replay).toBeNull();
    const store = new AgentBridgeStore(stateDir, "p");
    expect(await store.readEvents()).toHaveLength(1);
    expect(await store.readProposals()).toHaveLength(1);
  });

  it("is disabled by JK_IMPULSE_SCOUT=0", async () => {
    vi.stubEnv("JK_IMPULSE_SCOUT", "0");
    const stateDir = await tempDir("jk-impulse-hook-off-");
    const events = goalLoopCheckpointEvents({ ...base, revision: 1, completed: ["A"] });
    expect(await recordImpulseCheckpoint({ stateDir, projectId: "p", events })).toBeNull();
    expect(await readdir(stateDir)).toEqual([]);
  });

  it("defaults to off in public builds; JK_IMPULSE_SCOUT=1 opts back in", () => {
    expect(impulseScoutEnabled({ JK_DISTRIBUTION: "internal" })).toBe(true);
    expect(impulseScoutEnabled({ JK_DISTRIBUTION: "public" })).toBe(false);
    expect(impulseScoutEnabled({ JK_DISTRIBUTION: "public", JK_IMPULSE_SCOUT: "1" })).toBe(true);
    expect(impulseScoutEnabled({ JK_DISTRIBUTION: "public", JK_IMPULSE_SCOUT: "on" })).toBe(true);
    expect(impulseScoutEnabled({ JK_IMPULSE_SCOUT: "off" })).toBe(false);
  });
});

async function harness() {
  return createImpulseHarness();
}

describe("Impulse Scout MCP surface", () => {
  it("goal_loop checkpoints queue one advisory proposal without touching the project or the loop contract", async () => {
    const h = await harness();
    try {
      const intake = await h.call("goal_intake", { goal: "Implement arena selection", projectId: "impulse-project" });
      const loopId = intake.loopId as string;
      const workSessionId = intake.workSessionId as string;
      const baseline = await h.gitStatus();

      const turn = await h.call("goal_loop", {
        loopId, projectId: "impulse-project", workSessionId, phase: "patch",
        lastResult: "Arena selection implemented", completed: ["Arena selection"], pending: ["Polish"],
      });
      expect(turn.impulse).toMatchObject({
        newProposals: [expect.objectContaining({ priority: "P1", status: "open", recommendedDecision: "NEXT_PHASE" })],
        open: { tasks: 0, P0: 0, P1: 1, P2: 0 },
      });
      expect(turn.lifecycle).toBe("reasoning-needed");
      expect(JSON.stringify(turn.nextActions)).not.toContain("wake_");

      // Replaying the same state on the next turn must not re-propose or re-send.
      const again = await h.call("goal_loop", {
        loopId, projectId: "impulse-project", workSessionId, phase: "patch",
        lastResult: "Still the same", completed: ["Arena selection"], pending: ["Polish"],
      });
      expect(again.impulse).toBeUndefined();

      const queue = await h.call("impulse_wake_queue", { projectId: "impulse-project", loopId });
      expect(queue).toMatchObject({ total: 1, counts: { P0: 0, P1: 1, P2: 0 } });
      const [compact] = queue.proposals as Array<Record<string, unknown>>;
      expect(Object.keys(compact!).sort()).toEqual(["priority", "proposalId", "reason", "recommendedDecision", "status"]);
      const detail = await h.call("impulse_wake_queue", { projectId: "impulse-project", proposalId: compact!.proposalId });
      const proposal = detail.proposal as Record<string, unknown>;
      expect(proposal).toMatchObject({ loopId, workSessionId, writeScopes: [], interruptNow: false });
      expect((proposal.evidence as string[]).some((e) => e.includes("Arena selection"))).toBe(true);

      const events = await new AgentBridgeStore(h.stateDir, "impulse-project").readEvents();
      expect(events.map((e) => e.type)).toEqual(["goal_started", "phase_completed"]);
      expect(await h.gitStatus()).toBe(baseline);
    } finally {
      await h.close();
    }
  });

  it("impulse_event_record runs the Scout, dedupes by key, and impulse_scout_run is a no-op afterwards", async () => {
    const h = await harness();
    try {
      const args = {
        projectId: "impulse-project", type: "regression_detected", summary: "Checkout flow broke",
        phaseId: "checkout", evidence: { severity: "major", tests: ["checkout.e2e"] }, dedupeKey: "reg-1",
      };
      const first = await h.call("impulse_event_record", args);
      expect(first).toMatchObject({ duplicate: false, scoutTrigger: true });
      expect(first.proposals).toEqual([expect.objectContaining({ priority: "P0", interruptNow: true, category: "regression" })]);

      const replay = await h.call("impulse_event_record", args);
      expect(replay).toMatchObject({ duplicate: true, proposals: [] });

      const run = await h.call("impulse_scout_run", { projectId: "impulse-project" });
      expect(run).toMatchObject({ evaluatedEvents: 0, proposals: [] });
      expect(await readdir(h.root)).not.toContain(".jk");
    } finally {
      await h.close();
    }
  });

  it("rejects unknown projects", async () => {
    const h = await harness();
    try {
      const result = await h.client.callTool({ name: "impulse_wake_queue", arguments: { projectId: "nope" } });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });
});
