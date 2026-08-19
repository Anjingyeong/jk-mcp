import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTaskExecutionView, type TaskExecutionSnapshot } from "./execution.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jk-execution-"));
  tempDirs.push(dir);
  await mkdir(path.join(dir, "goals"), { recursive: true });
  return dir;
}

function snapshot(overrides: Partial<TaskExecutionSnapshot> = {}): TaskExecutionSnapshot {
  return {
    projectId: "p1",
    projectName: "example-service",
    goalId: "goal-1",
    loopId: "loop-1",
    currentGoal: "기능을 구현한다",
    currentTask: "재생 버튼 기능 구현",
    lastProgressSummary: null,
    completed: [],
    pending: ["구현", "테스트"],
    updatedAt: 100,
    lastMutation: null,
    lastVerification: null,
    ...overrides,
  };
}

async function writeJson(dir: string, fileName: string, value: unknown): Promise<void> {
  await writeFile(path.join(dir, "goals", fileName), JSON.stringify(value), "utf8");
}

describe("readTaskExecutionView", () => {
  it("returns an idle workflow when there is no task state", async () => {
    const dir = await stateDir();
    const view = await readTaskExecutionView(dir, null);
    expect(view).toMatchObject({
      mode: null,
      modeSource: "idle",
      phase: null,
      primaryStage: null,
      supportingStages: [],
      recoveryNeeded: false,
    });
  });

  it("uses the latest goal_loop orchestration as the canonical workflow state", async () => {
    const dir = await stateDir();
    await writeJson(dir, "loop-1.loop.json", {
      mode: "implement",
      turns: [
        { orchestration: { phase: "discover", primaryStage: "explorer", supportingStages: ["reviewer"] } },
        {
          orchestration: {
            phase: "patch",
            primaryStage: "implementer",
            supportingStages: ["explorer", "verifier"],
            verificationStatus: "unknown",
            failureCount: 0,
          },
        },
      ],
    });

    const view = await readTaskExecutionView(dir, snapshot());
    expect(view).toMatchObject({
      mode: "implement",
      modeSource: "loop",
      phase: "patch",
      primaryStage: "implementer",
      supportingStages: ["explorer", "verifier"],
      verificationStatus: "unknown",
      failureCount: 0,
      recoveryNeeded: false,
    });
  });

  it("reads legacy primaryRole fields so existing loop files keep working", async () => {
    const dir = await stateDir();
    await writeJson(dir, "loop-1.loop.json", {
      mode: "debug",
      turns: [
        {
          orchestration: {
            phase: "verify",
            primaryRole: "verifier",
            supportingRoles: ["reviewer", "explorer"],
            verificationStatus: "fail",
            failureCount: 1,
          },
        },
      ],
    });

    const view = await readTaskExecutionView(dir, snapshot());
    expect(view.primaryStage).toBe("verifier");
    expect(view.supportingStages).toEqual(["reviewer", "explorer"]);
    expect(view.verificationStatus).toBe("fail");
    expect(view.recoveryNeeded).toBe(false);
  });

  it("routes to Recovery only from canonical recovery/blocker state", async () => {
    const dir = await stateDir();
    await writeJson(dir, "loop-1.loop.json", {
      mode: "debug",
      turns: [
        {
          orchestration: {
            phase: "recovery",
            primaryStage: "recovery",
            supportingStages: ["oracle", "reviewer", "explorer"],
            verificationStatus: "blocked",
            failureCount: 3,
          },
        },
      ],
    });

    const view = await readTaskExecutionView(dir, snapshot({ lastVerification: { success: false, at: 250, tool: "command_run" } }));
    expect(view.recoveryNeeded).toBe(true);
    expect(view.primaryStage).toBe("recovery");
    expect(view.lastVerificationFailed).toBe(true);
  });

  it("falls back to an explicit goal mode without text heuristics", async () => {
    const dir = await stateDir();
    await writeJson(dir, "goal-1.json", { mode: "plan" });

    const view = await readTaskExecutionView(dir, snapshot({ loopId: null, currentTask: "에러 버그 문제를 조사해줘" }));
    expect(view.mode).toBe("plan");
    expect(view.modeSource).toBe("goal");
    expect(view.phase).toBe("plan");
    expect(view.primaryStage).toBe("oracle");
  });

  it("does not invent a workflow mode from task wording", async () => {
    const dir = await stateDir();
    const view = await readTaskExecutionView(
      dir,
      snapshot({ loopId: null, goalId: null, currentTask: "플레이 눌러도 노래가 안돼. 버그 고쳐줘" }),
    );
    expect(view.mode).toBeNull();
    expect(view.modeSource).toBe("idle");
    expect(view.phase).toBeNull();
    expect(view.primaryStage).toBeNull();
  });

  it("preserves progress counters separately from workflow stage", async () => {
    const dir = await stateDir();
    await writeJson(dir, "loop-1.loop.json", {
      mode: "review",
      turns: [{ orchestration: { phase: "review", primaryStage: "reviewer", supportingStages: ["verifier"] } }],
    });
    const view = await readTaskExecutionView(
      dir,
      snapshot({ completed: ["구현", "테스트"], pending: ["리뷰"], lastProgressSummary: "검증 완료" }),
    );
    expect(view.completedCount).toBe(2);
    expect(view.pendingCount).toBe(1);
    expect(view.lastProgressSummary).toBe("검증 완료");
    expect(view.primaryStage).toBe("reviewer");
  });
});
