import { promises as fs } from "node:fs";
import path from "node:path";
import type { OrchestrationProvider } from "./provider.js";

// Common, provider-neutral run record used to compare orchestration modes.
// Raw usage only: cost is computed by a separate report layer from current
// pricing, never hardcoded here. Records must not contain secrets, full
// prompts, or source contents.

export type BenchmarkMode = "standard" | "dispatcher" | "mass-ulw" | "agents-api";

export type BenchmarkCompletionStatus = "succeeded" | "failed" | "blocked" | "cancelled" | "timeout" | "incomplete";

export interface BenchmarkRun {
  schemaVersion: 1;
  runId: string;
  provider: OrchestrationProvider;
  mode: BenchmarkMode;
  model: string | null;
  projectId: string | null;
  workSessionId: string | null;
  taskLabel: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  completionStatus: BenchmarkCompletionStatus;
  success: boolean;
  verificationStatus: "unknown" | "pass" | "fail" | "blocked";
  turnCount: number | null;
  toolCallCount: number | null;
  toolNames: string[];
  toolErrorCount: number | null;
  retryCount: number;
  humanInterventionCount: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  agentCount: number | null;
  sessionId: string | null;
  error: string | null;
  details?: Record<string, unknown>;
}

export function benchmarkRunsFile(stateDir: string): string {
  return path.join(stateDir, "experiments", "benchmark-runs.jsonl");
}

export async function appendBenchmarkRun(stateDir: string, run: BenchmarkRun): Promise<void> {
  const file = benchmarkRunsFile(stateDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(run)}\n`, "utf8");
}

export async function readBenchmarkRuns(stateDir: string): Promise<BenchmarkRun[]> {
  let text: string;
  try {
    text = await fs.readFile(benchmarkRunsFile(stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as BenchmarkRun);
}

type LoopTurn = {
  at?: unknown;
  verificationStatus?: unknown;
  orchestration?: { massUlw?: { state?: unknown; recommended?: unknown } };
};

/**
 * Adapter from a persisted goal_loop checkpoint (`<stateDir>/goals/<loopId>.loop.json`)
 * to a BenchmarkRun, so ChatGPT-web runs can sit next to Agents API runs.
 * ChatGPT web exposes no token usage or tool-call counts to JK, so those stay null.
 * goal_loop cannot tell a "dispatcher" run from "standard"; pass `mode` to label it.
 */
export function benchmarkRunFromGoalLoop(
  checkpoint: Record<string, unknown>,
  overrides: { mode?: BenchmarkMode; model?: string | null; taskLabel?: string | null } = {},
): BenchmarkRun {
  const turns = (Array.isArray(checkpoint.turns) ? checkpoint.turns : []) as LoopTurn[];
  const times = turns.map((turn) => (typeof turn.at === "string" ? Date.parse(turn.at) : Number.NaN)).filter(Number.isFinite);
  const startedMs = times.length ? Math.min(...times) : null;
  const endedMs = times.length ? Math.max(...times) : null;
  const lifecycle = typeof checkpoint.lifecycle === "string" ? checkpoint.lifecycle : "";
  const lastVerification = [...turns].reverse().map((turn) => turn.verificationStatus).find((value) => typeof value === "string");
  const usedMassUlw = turns.some((turn) => turn.orchestration?.massUlw?.state === "fanout" && turn.orchestration.massUlw.recommended === true);
  const completionStatus: BenchmarkCompletionStatus = lifecycle === "succeeded" ? "succeeded" : lifecycle === "blocked" ? "blocked" : "incomplete";
  return {
    schemaVersion: 1,
    runId: `goal_loop:${String(checkpoint.loopId ?? "unknown")}`,
    provider: "chatgpt-web",
    mode: overrides.mode ?? (usedMassUlw ? "mass-ulw" : "standard"),
    model: overrides.model ?? null,
    projectId: typeof checkpoint.projectId === "string" ? checkpoint.projectId : null,
    workSessionId: typeof checkpoint.workSessionId === "string" ? checkpoint.workSessionId : null,
    taskLabel: overrides.taskLabel ?? null,
    startedAt: startedMs !== null ? new Date(startedMs).toISOString() : new Date(0).toISOString(),
    completedAt: endedMs !== null && completionStatus !== "incomplete" ? new Date(endedMs).toISOString() : null,
    durationMs: startedMs !== null && endedMs !== null ? endedMs - startedMs : null,
    completionStatus,
    success: completionStatus === "succeeded",
    verificationStatus: lastVerification === "pass" || lastVerification === "fail" || lastVerification === "blocked" ? lastVerification : "unknown",
    turnCount: typeof checkpoint.totalTurns === "number" ? checkpoint.totalTurns : turns.length,
    toolCallCount: null,
    toolNames: [],
    toolErrorCount: null,
    retryCount: turns.filter((turn) => turn.verificationStatus === "fail" || turn.verificationStatus === "blocked").length,
    humanInterventionCount: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    agentCount: null,
    sessionId: null,
    error: null,
  };
}
