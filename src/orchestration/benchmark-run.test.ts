import { describe, expect, it } from "vitest";
import { benchmarkRunFromGoalLoop } from "./benchmark-run.js";

describe("benchmarkRunFromGoalLoop", () => {
  it("maps a succeeded MASS ULW goal_loop checkpoint to the common run schema", () => {
    const run = benchmarkRunFromGoalLoop({
      loopId: "loop_a",
      projectId: "p",
      workSessionId: "ws_a",
      lifecycle: "succeeded",
      totalTurns: 3,
      turns: [
        { at: "2026-09-26T00:00:00.000Z", verificationStatus: "unknown" },
        { at: "2026-09-26T00:01:00.000Z", verificationStatus: "fail", orchestration: { massUlw: { state: "fanout", recommended: true } } },
        { at: "2026-09-26T00:05:00.000Z", verificationStatus: "pass" },
      ],
    });

    expect(run).toMatchObject({
      runId: "goal_loop:loop_a", provider: "chatgpt-web", mode: "mass-ulw", projectId: "p", workSessionId: "ws_a",
      startedAt: "2026-09-26T00:00:00.000Z", completedAt: "2026-09-26T00:05:00.000Z", durationMs: 300_000,
      completionStatus: "succeeded", success: true, verificationStatus: "pass", turnCount: 3, retryCount: 1,
      inputTokens: null, toolCallCount: null,
    });
  });

  it("keeps unfinished loops incomplete and accepts an explicit mode label", () => {
    const run = benchmarkRunFromGoalLoop({ loopId: "loop_b", lifecycle: "reasoning-needed", turns: [{ at: "2026-09-26T00:00:00.000Z" }] }, { mode: "dispatcher" });

    expect(run).toMatchObject({ mode: "dispatcher", completionStatus: "incomplete", success: false, completedAt: null, verificationStatus: "unknown" });
  });
});
