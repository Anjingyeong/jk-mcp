// MCP tool registrations (file). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { makeResult, type ToolContext } from "../../types.js";
import { applyPatch, createFile } from "../../code/patch.js";
import { createCheckpoint } from "../../state/checkpoints.js";
import { dispatchExecutorJob } from "../../executors/broker.js";
import { type RecentWorkFile, type MutationFileSummary, hashProjectFile, WorkSessionIdSchema, recordRecentWork, recordLastMutation, requireProjectLease, resolveOrThrow, localExecutionRoot, isRemoteProject, remotePayload, LOCAL_WRITE_ANNOTATIONS, chatGptToolMeta, withErrorMapping } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerFileTools(registerTool: RegisterTool, ctx: ToolContext): void {
  // -------------------------------------------------------------------
  // 8.4 Edit tools
  // -------------------------------------------------------------------

  registerTool(
    "file_apply_patch",
    {
      title: "Apply file patch",
      description: "Apply a Codex-style patch envelope with hash-precondition and transactional write.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Applying file patch...", "File patch applied"),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        patch: z.string(),
        preconditionHashes: z.record(z.string(), z.string()).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "file_apply_patch", input, async () => {
        await requireProjectLease(ctx, input.projectId, "write");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        let result: Awaited<ReturnType<typeof applyPatch>>;
        let checkpointId: string;
        let remoteFileHashes: Record<string, string | null> | null = null;
        if (isRemoteProject(entry)) {
          const remoteResult = await dispatchExecutorJob<Awaited<ReturnType<typeof applyPatch>> & {
            checkpointId: string;
            fileHashes: Record<string, string | null>;
          }>(
            ctx.stateDir,
            entry.executorId,
            "file_apply_patch",
            remotePayload(entry, { patch: input.patch, preconditionHashes: input.preconditionHashes }),
          );
          result = remoteResult;
          checkpointId = remoteResult.checkpointId;
          remoteFileHashes = remoteResult.fileHashes;
        } else {
          result = await applyPatch(await localExecutionRoot(ctx, entry), input.patch, input.preconditionHashes);
          checkpointId = (await createCheckpoint(entry.root, input.projectId, "patch")).checkpointId;
        }
        for (const applied of result.applied) {
          const fileHash = remoteFileHashes
            ? (remoteFileHashes[applied.path] ?? null)
            : applied.action === "delete" || applied.action === "move"
              ? null
              : await hashProjectFile(entry.root, applied.path);
          const lastAction: RecentWorkFile["lastAction"] =
            applied.action === "add"
              ? "create"
              : applied.action === "update"
                ? "edit"
                : applied.action === "move"
                  ? "move"
                  : "delete";
          await recordRecentWork(ctx, {
            projectId: input.projectId,
            workSessionId: input.workSessionId,
            path: applied.path,
            fileHash,
            lastAction,
            checkpointId,
          });
        }
        await recordLastMutation(ctx, input.projectId, input.workSessionId, {
          checkpointId,
          tool: "file_apply_patch",
          files: result.applied.map((applied) => ({
            path: applied.path,
            action: applied.action as MutationFileSummary["action"],
            added: applied.added,
            removed: applied.removed,
          })),
        });
        await ctx.ledger.append({
          type: "fs.mutation.staged",
          projectId: input.projectId,
          checkpointId,
          applied: result.applied,
        });
        return makeResult(
          {
            applied: result.applied.map((a) => ({
              path: a.path,
              action: a.action,
              "+lines": a.added,
              "-lines": a.removed,
            })),
            checkpointId,
          },
          `Applied patch: ${result.applied.length} file operation(s).`,
        );
      });
    },
  );

  registerTool(
    "file_create",
    {
      title: "Create project file",
      description: "Create a new file in the project (fails if it exists unless overwrite=true).",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Creating project file...", "Project file created"),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        path: z.string(),
        content: z.string(),
        overwrite: z.boolean().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "file_create", input, async () => {
        await requireProjectLease(ctx, input.projectId, "write");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        let result: Awaited<ReturnType<typeof createFile>>;
        let checkpointId: string;
        let fileHash: string | null;
        if (isRemoteProject(entry)) {
          const remoteResult = await dispatchExecutorJob<Awaited<ReturnType<typeof createFile>> & {
            checkpointId: string;
            fileHash: string;
          }>(
            ctx.stateDir,
            entry.executorId,
            "file_create",
            remotePayload(entry, { path: input.path, content: input.content, overwrite: input.overwrite }),
          );
          result = remoteResult;
          checkpointId = remoteResult.checkpointId;
          fileHash = remoteResult.fileHash;
        } else {
          result = await createFile(await localExecutionRoot(ctx, entry), input.path, input.content, input.overwrite);
          checkpointId = (await createCheckpoint(entry.root, input.projectId, "create")).checkpointId;
          fileHash = await hashProjectFile(entry.root, result.path);
        }
        await recordRecentWork(ctx, {
          projectId: input.projectId,
          workSessionId: input.workSessionId,
          path: result.path,
          fileHash,
          lastAction: "create",
          checkpointId,
        });
        await recordLastMutation(ctx, input.projectId, input.workSessionId, {
          checkpointId,
          tool: "file_create",
          files: [{ path: result.path, action: "create" }],
        });
        await ctx.ledger.append({
          type: "fs.mutation.staged",
          projectId: input.projectId,
          checkpointId,
          created: result.path,
        });
        return makeResult(
          { path: result.path, bytes: result.bytes, checkpointId },
          `Created ${result.path} (${result.bytes} bytes).`,
        );
      });
    },
  );
}
