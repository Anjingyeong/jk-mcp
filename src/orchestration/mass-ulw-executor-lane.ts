import type { MassUlwLaneCheckout } from "./mass-ulw-workspace.js";
import type { MassUlwStore } from "./mass-ulw-store.js";
import type { LaneEngine, LaneExecutionRequest, LaneVerificationRequest, MassUlwAttemptFingerprint, MassUlwExecutionInput, MassUlwRecoveryApproach, VerificationEngine } from "./mass-ulw-executor-types.js";
import { encodeMassUlwAttemptFingerprint, errorApproachFingerprint, errorFailureFingerprint, fingerprint, recoveryHistory } from "./mass-ulw-executor-recovery.js";
const MAX_LANE_ATTEMPTS = 3;
type LaneOutcome = { laneId: string; status: "completed" | "failed" };
class LaneAttemptFailure extends Error { readonly failureFingerprint: string; readonly approachFingerprint?: string; constructor(message: string, failureFingerprint: string, approachFingerprint?: string) { super(message); this.name = "LaneAttemptFailure"; this.failureFingerprint = failureFingerprint; this.approachFingerprint = approachFingerprint; } }
class LaneAuthorizationFailure extends Error { constructor(readonly authorizationCause: unknown) { super("Lane authorization was revoked", { cause: authorizationCause }); this.name = "LaneAuthorizationFailure"; } }
function optionalFingerprint(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function approachForFailureCount(count: number): MassUlwRecoveryApproach { if (count === 0) return "initial"; if (count === 1) return "inspect-assumption"; return "materially-different-approach"; }
async function authorize<T>(callback: (request: T) => Promise<void>, request: T): Promise<void> { try { await callback(request); } catch (error) { throw new LaneAuthorizationFailure(error); } }
export class MassUlwLaneRunner { constructor(private readonly config: { store: MassUlwStore; laneEngine: LaneEngine; verificationEngine: VerificationEngine; now: () => number; authorizeLaneExecutionStart: (request: LaneExecutionRequest) => Promise<void>; authorizeLaneVerificationStart: (request: LaneVerificationRequest) => Promise<void> }) {}
  async run(
    input: MassUlwExecutionInput,
    checkout: MassUlwLaneCheckout,
    laneId: string,
  ): Promise<LaneOutcome> {
    let document = await this.config.store.load(input.loopId);
    let history = recoveryHistory(document, laneId);
    if (history.length >= MAX_LANE_ATTEMPTS) return { laneId, status: "failed" };

    while (history.length < MAX_LANE_ATTEMPTS) {
      document = await this.config.store.load(input.loopId);
      const laneState = document.lanes[laneId]!;
      const previous = history.at(-1);
      const approach = approachForFailureCount(history.length);
      const attemptNumber = laneState.attempts + 1;
      const attemptId = `${input.loopId}:lane:${laneId}:${attemptNumber}`;
      const plannedApproachFingerprint = fingerprint({
        laneId,
        approach,
        previousFailureFingerprint: previous?.failureFingerprint ?? null,
        previousApproachFingerprint: previous?.approachFingerprint ?? null,
      });
      const request: LaneExecutionRequest = {
        loopId: input.loopId,
        lane: laneState.lane,
        checkout,
        attemptNumber,
        approach,
        previousFailureFingerprint: previous?.failureFingerprint ?? null,
        previousApproachFingerprint: previous?.approachFingerprint ?? null,
      };
      const startedFingerprint: MassUlwAttemptFingerprint = {
        version: 1,
        approach,
        approachFingerprint: plannedApproachFingerprint,
        previousFailureFingerprint: request.previousFailureFingerprint,
        previousApproachFingerprint: request.previousApproachFingerprint,
      };
      await this.config.store.update(input.loopId, (current) => {
        const lane = current.lanes[laneId]!;
        lane.status = "in-flight";
        lane.attempts = attemptNumber;
        delete lane.completedAt;
        current.attempts.push({
          id: attemptId,
          kind: "lane",
          laneId,
          status: "in-flight",
          startedAt: this.config.now(),
          fingerprint: encodeMassUlwAttemptFingerprint(startedFingerprint),
        });
      });

      let approachFingerprint = plannedApproachFingerprint;
      try {
        await authorize(this.config.authorizeLaneExecutionStart, request);
        const execution = await this.config.laneEngine.execute(request);
        if (!optionalFingerprint(execution.outputFingerprint) || !optionalFingerprint(execution.approachFingerprint)) {
          throw new LaneAttemptFailure(
            `Lane ${laneId} returned incomplete fingerprint evidence`,
            fingerprint({ laneId, phase: "execution", reason: "missing-fingerprint" }),
          );
        }
        approachFingerprint = execution.approachFingerprint;
        if (approach === "materially-different-approach" && request.previousApproachFingerprint === approachFingerprint) {
          throw new LaneAttemptFailure(
            `Lane ${laneId} repeated its previous approach`,
            fingerprint({ laneId, phase: "execution", reason: "approach-not-materially-different" }),
            approachFingerprint,
          );
        }
        const verificationRequest: LaneVerificationRequest = {
          ...request,
          outputFingerprint: execution.outputFingerprint,
          approachFingerprint,
        };
        await authorize(this.config.authorizeLaneVerificationStart, verificationRequest);
        const verification = await this.config.verificationEngine.verifyLane(verificationRequest);
        if (!optionalFingerprint(verification.fingerprint)) {
          throw new LaneAttemptFailure(
            `Lane ${laneId} verification returned no fingerprint`,
            fingerprint({ laneId, phase: "lane-verification", reason: "missing-fingerprint" }),
            approachFingerprint,
          );
        }
        if (!verification.passed) {
          throw new LaneAttemptFailure(
            verification.message ?? `Lane ${laneId} verification failed`,
            verification.failureFingerprint ?? verification.fingerprint,
            approachFingerprint,
          );
        }

        await this.config.store.update(input.loopId, (current) => {
          const attempt = current.attempts.find((candidate) => candidate.id === attemptId);
          if (!attempt || attempt.status !== "in-flight") throw new Error(`Lane attempt is not in flight: ${attemptId}`);
          const timestamp = this.config.now();
          attempt.status = "completed";
          attempt.completedAt = timestamp;
          attempt.fingerprint = encodeMassUlwAttemptFingerprint({
            ...startedFingerprint,
            approachFingerprint,
            outputFingerprint: execution.outputFingerprint,
            verificationFingerprint: verification.fingerprint,
          });
          const lane = current.lanes[laneId]!;
          lane.status = "completed";
          lane.completedAt = timestamp;
          current.fingerprints.lanes[laneId] = execution.outputFingerprint;
        });
        return { laneId, status: "completed" };
      } catch (error) {
        if (error instanceof LaneAuthorizationFailure) throw error.authorizationCause;
        const phase = error instanceof LaneAttemptFailure && error.message.includes("verification")
          ? "lane-verification"
          : "execution";
        const failureFingerprint = error instanceof LaneAttemptFailure
          ? error.failureFingerprint
          : errorFailureFingerprint(error, phase);
        approachFingerprint = error instanceof LaneAttemptFailure
          ? error.approachFingerprint ?? approachFingerprint
          : errorApproachFingerprint(error, approachFingerprint);
        await this.config.store.update(input.loopId, (current) => {
          const attempt = current.attempts.find((candidate) => candidate.id === attemptId);
          if (!attempt || attempt.status !== "in-flight") throw new Error(`Lane attempt is not in flight: ${attemptId}`);
          const timestamp = this.config.now();
          attempt.status = "failed";
          attempt.completedAt = timestamp;
          attempt.fingerprint = encodeMassUlwAttemptFingerprint({
            ...startedFingerprint,
            approachFingerprint,
            failureFingerprint,
          });
          const lane = current.lanes[laneId]!;
          lane.status = "failed";
          delete lane.completedAt;
        });
        history = [...history, { failureFingerprint, approachFingerprint }];
        if (history.length >= MAX_LANE_ATTEMPTS) return { laneId, status: "failed" };
      }
    }
    return { laneId, status: "failed" };
  }

}
