// MCP tool registrations (mass-ulw). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { executeWebMassStep } from "../mass-ulw-web-tool.js";
import { WebMassStrategyInputSchema } from "../../orchestration/mass-ulw-web.js";
import { MassUlwRepairStrategiesSchema } from "../../orchestration/mass-ulw-store-schema.js";
import { type ToolContext } from "../../types.js";
import { executeMassUlwTool } from "../mass-ulw-execution.js";
import type { MassUlwExecuteInput } from "../mass-ulw-processes.js";
import { loadSession, WorkSessionIdSchema, findLoopContextById, recordVerification, requireProjectLease, resolveOrThrow, COMMAND_RUN_ANNOTATIONS, chatGptToolMeta, withErrorMapping } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerMassUlwTools(registerTool: RegisterTool, ctx: ToolContext): void {

  registerTool(
    "mass_ulw_step",
    {
      title: "Continue ChatGPT-web MASS ULW",
      description: "Default interactive MASS ULW harness without a model API. First create/select task_workspace and plan with goal_loop fanoutCandidates. start pins discovered lane/final verifiers; next returns current role, dependency-aware context and nextCall. submit accepts one ready lane or independent ready lanes, verifies each once, and returns failures to ChatGPT for repair. review accepts/rejects exact proof tokens; dependencies open only after acceptance. revise invalidates that lane and descendants. integrate verifies the accepted result; review it, finish applies it to the task, then follow nextCall to publish to the source. status/next resume durable state after disconnect. Do not submit every lane up front or claim completion until terminal=true.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      inputSchema: {
        action: z.enum(["start", "next", "context", "submit", "review", "revise", "integrate", "finish", "status"]),
        projectId: z.string(), loopId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u),
        workSessionId: WorkSessionIdSchema, planFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        laneVerificationCommandIds: z.record(z.string().min(1).max(80), z.string().min(1).max(200)).optional(),
        finalVerificationCommandId: z.string().min(1).max(200).optional(),
        submissions: z.array(z.object({ laneId: z.string().min(1).max(80), contextToken: z.string().regex(/^[a-f0-9]{64}$/u), submissionId: z.string().min(1).max(120), patch: z.string().min(1).max(1024 * 1024), hypothesis: z.string().trim().min(1).max(4000).optional() })).min(1).max(4).optional(),
        laneId: z.string().min(1).max(80).optional(), repairLaneId: z.string().min(1).max(80).optional(), token: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
        verdict: z.enum(["approve", "reject"]).optional(), summary: z.string().trim().min(1).max(4000).optional(),
        strategy: WebMassStrategyInputSchema.optional(),
        paths: z.array(z.string().min(1).max(300)).max(8).optional(), startLine: z.number().int().min(1).max(1_000_000).optional(), contextView: z.enum(["baseline", "submitted"]).optional(),
        timeoutSec: z.number().int().min(1).max(300).optional(),
      },
    },
    async (input) => withErrorMapping(ctx, "mass_ulw_step", { ...input, submissions: input.submissions?.map(({ patch, ...item }) => ({ ...item, patchBytes: Buffer.byteLength(patch) })) },
      async () => {
        if (!["next", "context", "status"].includes(input.action)) await requireProjectLease(ctx, input.projectId, "write");
        return executeWebMassStep(ctx, input, async () => Boolean(findLoopContextById(await loadSession(ctx), input.projectId, input.loopId, input.workSessionId)));
      }),
  );

  registerTool(
    "mass_ulw_execute",
    {
      title: "Execute approved MASS ULW plan",
      description:
        "Execute the exact dependency-wave plan approved and persisted by goal_loop without OMO. The current ChatGPT session supplies one Codex-style patch per lane; JK applies each patch in a private checkout, verifies only through manifest-discovered verify commands, merges dependency waves, verifies the integrated result once, and atomically publishes it. No separate model/provider credential is required.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Executing approved MASS ULW waves...", "MASS ULW execution finished"),
      inputSchema: {
        projectId: z.string().min(1),
        loopId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u),
        planFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        workSessionId: WorkSessionIdSchema,
        lanePatches: z.record(z.string().min(1).max(80), z.string().min(1).max(10 * 1024 * 1024)),
        repairStrategies: MassUlwRepairStrategiesSchema.optional(),
        laneVerificationCommandIds: z.record(z.string().min(1).max(80), z.string().min(1).max(200)),
        finalVerificationCommandId: z.string().min(1).max(200),
        timeoutSec: z.number().int().positive().max(3600).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "mass_ulw_execute", input, async () => {
        await requireProjectLease(ctx, input.projectId, "write");
        return executeMassUlwTool(ctx, input, {
          resolveProject: async (projectId) => resolveOrThrow(ctx, { projectId }),
          isApprovedGoalLoop: async (candidate: MassUlwExecuteInput) => {
            const session = await loadSession(ctx);
            return findLoopContextById(session, candidate.projectId, candidate.loopId, candidate.workSessionId) !== null;
          },
          recordVerification: async (candidate, success) => recordVerification(ctx, candidate.projectId, candidate.workSessionId, {
            tool: "command_run",
            command: candidate.finalVerificationCommandId,
            success,
            exitCode: success ? 0 : 1,
            durationMs: null,
          }),
        });
      });
    },
  );
}
