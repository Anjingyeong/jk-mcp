import type { MassUlwLane, MassUlwPlan } from "./mass-ulw.js";
import type { MassUlwStore } from "./mass-ulw-store.js";
import type { MassUlwRepairStrategies } from "./mass-ulw-store-schema.js";
import type { MassUlwIntegrationResult, MassUlwLaneCheckout, MassUlwPublishResult, MassUlwWorkspace, MassUlwWorkspaceOptions } from "./mass-ulw-workspace.js";
import type { MassUlwFailureDiagnostic } from "./mass-ulw-failure.js";
export class MassUlwPersistenceError extends Error {
  readonly name = "MassUlwPersistenceError";
  constructor(cause: unknown) {
    super("MASS ULW durable artifact persistence failed", { cause });
  }
}
export type MassUlwRecoveryApproach =
  | "initial"
  | "inspect-assumption"
  | "materially-different-approach";

export type LaneExecutionRequest = {
  loopId: string;
  lane: MassUlwLane;
  checkout: MassUlwLaneCheckout;
  attemptNumber: number;
  approach: MassUlwRecoveryApproach;
  previousFailureFingerprint: string | null;
  previousApproachFingerprint: string | null;
};

export type LaneExecutionResult = {
  outputFingerprint: string;
  approachFingerprint: string;
  checkoutCommit?: string;
};

export type LaneRestoreRequest = {
  loopId: string;
  lane: MassUlwLane;
  checkout: MassUlwLaneCheckout;
  outputFingerprint: string;
};

export interface LaneEngine {
  /** Fixed input cannot generate a repair. Omitted retains the generic three-approach engine. */
  readonly failurePolicy?: "repair-required";
  readonly approachFingerprint?: (laneId: string) => string;
  execute(request: LaneExecutionRequest): Promise<LaneExecutionResult>;
  /** Rehydrate a durable completed output into a fresh private checkout without executing the lane again. */
  restore?(request: LaneRestoreRequest): Promise<void>;
}

export type LaneVerificationRequest = LaneExecutionRequest & {
  outputFingerprint: string;
  approachFingerprint: string;
  checkoutCommit?: string;
};

export type IntegratedVerificationRequest = {
  loopId: string;
  root: string;
  fingerprint: string;
  changedPaths: string[];
  invocationCount: 1;
  baseCommit?: string;
};

export type VerificationResult = {
  passed: boolean;
  fingerprint: string;
  failureFingerprint?: string;
  message?: string;
  failure?: MassUlwFailureDiagnostic;
};

export interface VerificationEngine {
  verifyLane(request: LaneVerificationRequest): Promise<VerificationResult>;
  verifyIntegrated(request: IntegratedVerificationRequest): Promise<VerificationResult>;
}

export interface MassUlwWorkspaceLike {
  readonly privateRoot: string;
  readonly lanes: readonly MassUlwLaneCheckout[];
  readonly baselineCommit?: string;
  prepareLane?(laneId: string, ancestorIds: string[]): Promise<void>;
  integrate(): Promise<MassUlwIntegrationResult>;
  publish(): Promise<MassUlwPublishResult>;
  cleanup(options?: { preservePublicationReceipt?: boolean }): Promise<void>;
}

export type MassUlwExecutorOptions = {
  stateDir: string;
  repositoryRoot: string;
  laneEngine: LaneEngine;
  verificationEngine: VerificationEngine;
  tempRoot?: string;
  now?: () => number;
  store?: MassUlwStore;
  workspaceFactory?: (options: MassUlwWorkspaceOptions) => Promise<MassUlwWorkspaceLike | MassUlwWorkspace>;
  /** Compatibility alias for authorizeLaneExecutionStart. */
  readonly authorizeLaneStart?: (request: LaneExecutionRequest) => Promise<void>;
  readonly authorizeLaneExecutionStart?: (request: LaneExecutionRequest) => Promise<void>;
  readonly authorizeLaneVerificationStart?: (request: LaneVerificationRequest) => Promise<void>;
  authorizeIntegratedVerification?: () => Promise<void>;
  authorizePublish?: () => Promise<void>;
};

export type MassUlwExecutionInput = {
  loopId: string;
  plan: MassUlwPlan;
  readonly repairStrategies?: MassUlwRepairStrategies;
};

export type MassUlwExecutionResult = {
  status: "completed" | "blocked";
  completedLaneIds: string[];
  failedLaneIds: string[];
  blockedLaneIds: string[];
  failureDiagnostics: MassUlwFailureDiagnostic[];
  changedPaths: string[];
  laneCommits: MassUlwIntegrationResult["laneCommits"];
  integrationFingerprint: string | null;
  finalVerificationInvocationCount: 0 | 1;
  readonly recovery?: {
    readonly reason: "repair-required";
    readonly laneIds: string[];
    readonly automaticReplay: false;
  } | {
    readonly reason: "final-verification-outcome-unknown";
    readonly attemptId: string;
    readonly automaticReplay: false;
    readonly authorizationRequired: true;
    readonly nextAction: "inspect-outcome-and-start-new-approved-run";
  };
};

export type MassUlwAttemptFingerprint = {
  version: 1;
  readonly strategyGeneration?: number;
  approach: MassUlwRecoveryApproach;
  approachFingerprint: string;
  previousFailureFingerprint: string | null;
  previousApproachFingerprint: string | null;
  failureFingerprint?: string;
  outputFingerprint?: string;
  verificationFingerprint?: string;
};
