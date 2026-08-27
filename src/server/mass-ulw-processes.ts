import { createHash } from "node:crypto";
import { applyPatch } from "../code/patch.js";
import { runCommand } from "../exec/command-runner.js";
import { gitRepositoryStatus, gitStageAndCommit } from "../git/git.js";
import { MassUlwArtifactStore } from "../orchestration/mass-ulw-artifacts.js";
import type { LaneEngine, VerificationEngine } from "../orchestration/mass-ulw-executor.js";
import type { MassUlwPlan } from "../orchestration/mass-ulw.js";
import { DomainError, ErrorCode, type ToolContext } from "../types.js";
import type { MassUlwExecutionIdentity } from "./mass-ulw-identity.js";

export type MassUlwExecuteInput = { readonly projectId: string; readonly loopId: string; readonly planFingerprint: string; readonly workSessionId: string; readonly lanePatches: Readonly<Record<string, string>>; readonly laneVerificationCommandIds: Readonly<Record<string, string>>; readonly finalVerificationCommandId: string; readonly timeoutSec?: number };
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function pathWithinScope(file: string, scope: string): boolean { const normalized = file.split("\\").join("/").replace(/^\.\//u, "").toLowerCase(); return normalized === scope || normalized.startsWith(`${scope}/`); }
async function commitLane(root: string, lane: MassUlwPlan["lanes"][number]): Promise<string | null> {
  const status = await gitRepositoryStatus(root); const changed = [...new Set([...status.dirtyFiles, ...status.staged])];
  if (changed.length === 0) return null;
  const outsideScope = changed.filter((file) => !lane.writeScopes.some((scope) => pathWithinScope(file, scope)));
  if (outsideScope.length > 0) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `MASS ULW lane ${lane.id} wrote outside its approved scope`, { laneId: lane.id, outsideScope });
  if (lane.writeScopes.length === 0) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Read-only MASS ULW lane ${lane.id} modified the workspace`);
  return (await gitStageAndCommit(root, `mass-ulw lane ${lane.id}`, lane.writeScopes)).commit;
}
export function createMassUlwProcesses(config: { readonly ctx: ToolContext; readonly input: MassUlwExecuteInput; readonly identity: MassUlwExecutionIdentity; readonly verifierFingerprints: ReadonlyMap<string, string> }): { readonly artifacts: MassUlwArtifactStore; readonly laneEngine: LaneEngine; readonly verificationEngine: VerificationEngine } {
  const { ctx, input, identity, verifierFingerprints } = config; const artifacts = new MassUlwArtifactStore(ctx.stateDir, identity.executionId);
  const appliedLanePatches = new Set<string>();
  return { artifacts, laneEngine: {
    execute: async (request) => {
      const patch = input.lanePatches[request.lane.id];
      if (!patch) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `MASS ULW lane ${request.lane.id} has no JK-native patch`);
      const patchFingerprint = fingerprint({ version: 1, laneId: request.lane.id, patch });
      let applied: Array<{ path: string; action: string; added: number; removed: number }> = [];
      if (!appliedLanePatches.has(request.lane.id)) {
        const result = await applyPatch(request.checkout.root, patch);
        applied = result.applied;
        appliedLanePatches.add(request.lane.id);
      }
      const commit = await commitLane(request.checkout.root, request.lane);
      await artifacts.save({ laneId: request.lane.id, checkoutRoot: request.checkout.root, baselineCommit: request.checkout.executionBaselineCommit });
      return {
        outputFingerprint: fingerprint({ laneId: request.lane.id, patchFingerprint, commit, applied, workSessionId: input.workSessionId }),
        approachFingerprint: patchFingerprint,
      };
    },
    restore: async (request) => artifacts.restore({ laneId: request.lane.id, checkoutRoot: request.checkout.root, baselineCommit: request.checkout.executionBaselineCommit }),
  }, verificationEngine: {
    verifyLane: async (request) => { const commandId = input.laneVerificationCommandIds[request.lane.id]; if (!commandId) throw new Error(`MASS ULW lane ${request.lane.id} has no verifier`); const result = await runCommand(request.checkout.root, commandId, undefined, input.timeoutSec, verifierFingerprints.get(commandId)); const proof = fingerprint({ laneId: request.lane.id, commandId, outputFingerprint: request.outputFingerprint, exitCode: result.exitCode, stdoutSummary: result.stdoutSummary, stderrSummary: result.stderrSummary }); return { passed: result.exitCode === 0, fingerprint: proof, ...(result.exitCode === 0 ? {} : { failureFingerprint: proof }), message: `Lane ${request.lane.id} verifier ${commandId} exited ${result.exitCode}` }; },
    verifyIntegrated: async (request) => { const commandId = input.finalVerificationCommandId; const result = await runCommand(request.root, commandId, undefined, input.timeoutSec, verifierFingerprints.get(commandId)); const proof = fingerprint({ integrationFingerprint: request.fingerprint, commandId, exitCode: result.exitCode, stdoutSummary: result.stdoutSummary, stderrSummary: result.stderrSummary }); return { passed: result.exitCode === 0, fingerprint: proof, ...(result.exitCode === 0 ? {} : { failureFingerprint: proof }), message: `Integrated verifier ${commandId} exited ${result.exitCode}` }; },
  } };
}
