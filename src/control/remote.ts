import { dispatchExecutorJob } from "../executors/broker.js";
import { ExecutionTargetSchema } from "../executors/target-protocol.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import type { ControlActionRecord } from "./queue.js";

export interface RemoteComputerScreenshotResult {
  path: string;
  bytes: number;
  imageBase64: string;
  mimeType: "image/png";
  frontmostProcess: string;
}

export interface RemoteComputerActionResult {
  ok: true;
  frontmostProcess: string;
  point?: { x: number; y: number };
}

export async function resolveRemoteControlProject(
  ctx: ToolContext,
  projectId: string,
): Promise<(ProjectRegistryEntry & { executorId: string }) | null> {
  const entries = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
  const entry = entries.find((candidate) => candidate.projectId === projectId);
  if (!entry || entry.executorKind !== "remote" || typeof entry.executorId !== "string" || entry.executorId.length === 0) {
    return null;
  }
  ExecutionTargetSchema.parse(entry.executionTarget);
  return entry as ProjectRegistryEntry & { executorId: string };
}

function remotePayload(entry: ProjectRegistryEntry & { executorId: string }, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    sourceProjectId: entry.sourceProjectId ?? entry.projectId,
    executionTarget: ExecutionTargetSchema.parse(entry.executionTarget),
  };
}

export async function captureRemoteComputerScreenshot(
  ctx: ToolContext,
  entry: ProjectRegistryEntry & { executorId: string },
  input: { appName: string; label?: string; waitMs?: number },
): Promise<RemoteComputerScreenshotResult> {
  return await dispatchExecutorJob<RemoteComputerScreenshotResult>(
    ctx.stateDir,
    entry.executorId,
    "computer_screenshot",
    remotePayload(entry, input),
    45_000,
  );
}

export async function executeRemoteComputerAction(
  ctx: ToolContext,
  entry: ProjectRegistryEntry & { executorId: string },
  record: ControlActionRecord,
): Promise<RemoteComputerActionResult> {
  return await dispatchExecutorJob<RemoteComputerActionResult>(
    ctx.stateDir,
    entry.executorId,
    "computer_action",
    remotePayload(entry, {
      appName: record.appName,
      kind: record.kind,
      windowPoint: record.target.windowPoint,
      text: record.text,
      keyCode: record.keyCode,
      scrollDelta: record.scrollDelta,
    }),
    20_000,
  );
}