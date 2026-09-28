// MCP tool registrations (checkpoint). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { makeResult, type ToolContext } from "../../types.js";
import { listCheckpoints, readCheckpoint, restoreCheckpoint } from "../../state/checkpoints.js";
import { requireProjectLease, resolveOrThrow, localExecutionRoot, READ_ONLY_ANNOTATIONS, LOCAL_WRITE_ANNOTATIONS, chatGptToolMeta, withErrorMapping } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerCheckpointTools(registerTool: RegisterTool, ctx: ToolContext): void {

  registerTool(
    "checkpoint_list",
    {
      title: "List checkpoints",
      description: "List recent project checkpoints captured after file mutations.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Listing checkpoints...", "Checkpoints listed"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "checkpoint_list", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const checkpoints = await listCheckpoints(entry.root, input.projectId);
        return makeResult({ checkpoints }, `Found ${checkpoints.length} checkpoint(s).`);
      });
    },
  );

  registerTool(
    "checkpoint_show",
    {
      title: "Show checkpoint",
      description: "Show the redacted diff stored in a checkpoint.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Loading checkpoint...", "Checkpoint loaded"),
      inputSchema: { projectId: z.string(), checkpointId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "checkpoint_show", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const checkpoint = await readCheckpoint(entry.root, input.checkpointId);
        return makeResult({ checkpoint }, `Checkpoint ${input.checkpointId} loaded.`);
      });
    },
  );

  registerTool(
    "checkpoint_restore",
    {
      title: "Restore checkpoint",
      description: "Reverse-apply the stored checkpoint diff. Requires a write lease.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Restoring checkpoint...", "Checkpoint restored"),
      inputSchema: { projectId: z.string(), checkpointId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "checkpoint_restore", input, async () => {
        await requireProjectLease(ctx, input.projectId, "write");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await restoreCheckpoint(await localExecutionRoot(ctx, entry), input.checkpointId);
        await ctx.ledger.append({ type: "checkpoint.restored", projectId: input.projectId, checkpointId: input.checkpointId });
        return makeResult(result, result.restored ? `Restored ${input.checkpointId}.` : `Checkpoint ${input.checkpointId} had no diff.`);
      });
    },
  );
}
