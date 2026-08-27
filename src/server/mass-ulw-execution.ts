import { listCommands } from "../exec/command-runner.js";
import { executeMassUlw } from "../orchestration/mass-ulw-executor.js";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { DomainError, ErrorCode, makeResult, type ProjectRegistryEntry, type ToolContext, type ToolResult } from "../types.js";
import { createMassUlwExecutionIdentity } from "./mass-ulw-identity.js";
import { authorizeMassUlwProcessStart } from "./mass-ulw-lease.js";
import { createMassUlwProcesses, type MassUlwExecuteInput } from "./mass-ulw-processes.js";

type Dependencies = { readonly resolveProject: (projectId: string) => Promise<ProjectRegistryEntry>; readonly isApprovedGoalLoop: (input: MassUlwExecuteInput) => Promise<boolean>; readonly recordVerification: (input: MassUlwExecuteInput, success: boolean) => Promise<void> };

export async function executeMassUlwTool(ctx: ToolContext, input: MassUlwExecuteInput, dependencies: Dependencies): Promise<ToolResult<Record<string, unknown>>> {
  const entry = await dependencies.resolveProject(input.projectId);
  if (entry.executorKind === "remote") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "mass_ulw_execute requires a local routed checkout because private lane workspaces cannot be created over the remote executor bridge");
  const identity = await createMassUlwExecutionIdentity({ projectId: input.projectId, repositoryRoot: entry.root, externalLoopId: input.loopId });
  let document;
  try { document = await new MassUlwStore(ctx.stateDir).load(identity.executionId); }
  catch (error) { throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `MASS ULW plan is not executable: ${error instanceof Error ? error.message : String(error)}`); }
  const plan = document.plan;
  if (plan.planFingerprint !== input.planFingerprint) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "MASS ULW plan fingerprint is stale", { expectedPlanFingerprint: plan.planFingerprint, receivedPlanFingerprint: input.planFingerprint });
  if (!plan.recommended || plan.state !== "fanout" || plan.hardBlocks.length > 0) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "MASS ULW plan was not approved for executable fan-out");
  if (!(await dependencies.isApprovedGoalLoop(input))) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "MASS ULW call is stale: loopId, projectId, and workSessionId no longer identify the approved goal loop");
  const expectedLaneIds = plan.lanes.map((lane) => lane.id).sort((left, right) => left.localeCompare(right));
  const receivedPatchLaneIds = Object.keys(input.lanePatches).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(expectedLaneIds) !== JSON.stringify(receivedPatchLaneIds)) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "MASS ULW JK-native lane patches must exactly match the approved lanes", { expectedLaneIds, receivedPatchLaneIds });
  const receivedLaneIds = Object.keys(input.laneVerificationCommandIds).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(expectedLaneIds) !== JSON.stringify(receivedLaneIds)) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "MASS ULW per-lane verifier IDs must exactly match the approved lanes", { expectedLaneIds, receivedLaneIds });
  const commandById = new Map((await listCommands(entry.root)).map((command) => [command.commandId, command]));
  const verifierFingerprints = new Map<string, string>();
  for (const commandId of [...Object.values(input.laneVerificationCommandIds), input.finalVerificationCommandId]) {
    const command = commandById.get(commandId);
    if (!command || command.riskTier !== "verify") throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `MASS ULW verifier ${commandId} is not a safe manifest-discovered verify command ID`, { commandId, riskTier: command?.riskTier ?? null });
    verifierFingerprints.set(commandId, command.manifestFingerprint);
  }
  await authorizeMassUlwProcessStart(ctx, input.projectId);
  await ctx.ledger.append({ type: "mass-ulw.execution.started", projectId: input.projectId, loopId: input.loopId, executionId: identity.executionId, workSessionId: input.workSessionId, planFingerprint: input.planFingerprint, waves: plan.waves });
  const processes = createMassUlwProcesses({ ctx, input, identity, verifierFingerprints }); const authorize = async () => authorizeMassUlwProcessStart(ctx, input.projectId);
  const result = await executeMassUlw({ stateDir: ctx.stateDir, repositoryRoot: entry.root, loopId: identity.executionId, plan, authorizeLaneExecutionStart: authorize, authorizeLaneVerificationStart: authorize, authorizeIntegratedVerification: authorize, authorizePublish: authorize, laneEngine: processes.laneEngine, verificationEngine: processes.verificationEngine });
  if (result.status === "completed") await processes.artifacts.cleanup();
  await dependencies.recordVerification(input, result.status === "completed" && result.finalVerificationInvocationCount === 1);
  await ctx.ledger.append({ type: "mass-ulw.execution.finished", projectId: input.projectId, loopId: input.loopId, executionId: identity.executionId, workSessionId: input.workSessionId, planFingerprint: input.planFingerprint, status: result.status, completedLaneIds: result.completedLaneIds, failedLaneIds: result.failedLaneIds, blockedLaneIds: result.blockedLaneIds, finalVerificationInvocationCount: result.finalVerificationInvocationCount });
  return makeResult({ ...result, projectId: input.projectId, loopId: input.loopId, executionId: identity.executionId, workSessionId: input.workSessionId, planFingerprint: plan.planFingerprint, waves: plan.waves, planState: plan.state, engine: "jk-native", externalModelRequired: false, timeoutSec: input.timeoutSec ?? null }, `MASS ULW ${input.loopId} ${result.status}; ${result.completedLaneIds.length}/${plan.lanes.length} JK-native lanes completed and final verification ran ${result.finalVerificationInvocationCount} time(s).`);
}
