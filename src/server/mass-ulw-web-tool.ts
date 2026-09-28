import { MassUlwWebWorkflow, type WebMassInput } from "../orchestration/mass-ulw-web.js";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { TaskWorkspaceStore, isTaskWorkspaceId } from "../workspace/task-workspaces.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { createMassUlwExecutionIdentity } from "./mass-ulw-identity.js";
import { DomainError, ErrorCode, makeResult, type ToolContext, type ToolResult } from "../types.js";

export async function executeWebMassStep(ctx: ToolContext, input: WebMassInput, approvedLoop: () => Promise<boolean>): Promise<ToolResult<Record<string, unknown>>> {
  if (!isTaskWorkspaceId(input.projectId)) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Create/select a task_workspace before planning MASS ULW. Use its projectId for goal_loop and mass_ulw_step.");
  const tasks = new TaskWorkspaceStore(ctx.stateDir);
  return tasks.locked(input.projectId, async () => {
    const task = await tasks.load(input.projectId);
    if (task.workSessionId !== input.workSessionId) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Task workSessionId mismatch");
    const workflow = new MassUlwWebWorkflow(ctx.stateDir, input.projectId, {
      write: async () => { await requireProjectLease(ctx, input.projectId, "write"); },
      verify: async () => { await requireProjectLease(ctx, input.projectId, "write"); await requireProjectLease(ctx, input.projectId, "verify"); },
    });
    const readOnly = ["next", "context", "status"].includes(input.action);
    if (!readOnly) await requireProjectLease(ctx, input.projectId, "write");
    let doc;
    if (input.action === "start") {
      if (!(await approvedLoop())) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Plan a goal_loop for this task and workSessionId before starting MASS ULW");
      const identity = await createMassUlwExecutionIdentity({ projectId: input.projectId, repositoryRoot: tasks.root(input.projectId), externalLoopId: input.loopId });
      const approved = await new MassUlwStore(ctx.stateDir).load(identity.executionId);
      if (approved.plan.planFingerprint !== input.planFingerprint) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Stale approved plan fingerprint");
      doc = await workflow.start(input, approved.plan);
    } else doc = await workflow.load();
    workflow.checkIdentity(doc, input);
    if (!readOnly && input.action !== "start") {
      const identity = await createMassUlwExecutionIdentity({ projectId: input.projectId, repositoryRoot: tasks.root(input.projectId), externalLoopId: input.loopId });
      const approved = await new MassUlwStore(ctx.stateDir).load(identity.executionId);
      if (approved.plan.planFingerprint !== doc.plan.planFingerprint) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "The approved goal_loop plan changed; this workflow cannot execute its old plan");
    }
    await workflow.recoverInterrupted(doc);
    if (input.action === "submit") await workflow.submit(doc, input);
    if (input.action === "review") await workflow.review(doc, input);
    if (input.action === "revise") await workflow.revise(doc, input);
    if (input.action === "integrate") await workflow.integrate(doc, input.timeoutSec);
    if (input.action === "finish") await workflow.finish(doc, input.timeoutSec);
    const result = await workflow.view(doc);
    const base = { projectId: doc.projectId, loopId: doc.loopId, workSessionId: doc.workSessionId, planFingerprint: doc.plan.planFingerprint };
    const next = result.nextCall as { tool?: string; input?: { action?: string; laneId?: string } } | null;
    if (input.action === "context" && !input.laneId) result.context = await workflow.context(doc, input);
    const laneId = input.action === "context" ? input.laneId : next?.input?.action === "context" ? next.input.laneId : undefined;
    if (laneId && input.action !== "status") {
      result.context = await workflow.context(doc, { ...input, laneId });
      const lane = doc.lanes[laneId]!;
      // Inspection of an exhausted lane must not turn blocked guidance into an impossible submit.
      const eligible = (result.readyLaneIds as string[]).includes(laneId);
      if (lane.status === "review" || eligible) {
        result.nextCall = lane.status === "review" ? { tool: "mass_ulw_step", input: { ...base, action: "review", laneId, token: lane.proof!.token }, needs: ["verdict=approve|reject", "summary=ChatGPT review findings"] }
          : { tool: "mass_ulw_step", input: { ...base, action: "submit" }, needs: [{ submissions: [{ laneId, contextToken: workflow.contextToken(doc, laneId), submissionId: "a new unique id", patch: "complete Codex-style patch against context.baselineCommit", ...(lane.status === "failed" ? { hypothesis: "evidence-backed repair hypothesis; patch must differ from the failed submission" } : {}) }] }] };
        if (input.contextView === "submitted" && lane.status === "failed") result.nextCall = { tool: "mass_ulw_step", input: { ...base, action: "context", laneId, contextView: "baseline" } };
      }
    }
    await ctx.ledger.append({ type: `mass-ulw.web.${input.action}`, projectId: doc.projectId, workSessionId: doc.workSessionId, loopId: doc.loopId, revision: doc.revision, role: result.role });
    return makeResult(result, `MASS ULW: ${result.role}. ${result.terminal ? "Verified, reviewed changes are published." : "Continue in this ChatGPT web session using context and nextCall; no external model is running."}`);
  });
}
