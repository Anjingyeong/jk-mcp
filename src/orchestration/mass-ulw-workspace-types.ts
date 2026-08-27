export type MassUlwWorkspaceLane = {
  id: string;
  writeScopes: string[];
};

export type MassUlwWorkspaceHooks = {
  /** Intended for deterministic fault/concurrency tests and observability. */
  beforePublishPath?: (relativePath: string, ordinal: number) => void | Promise<void>;
  afterPublishPath?: (relativePath: string, ordinal: number) => void | Promise<void>;
  afterPublicationCommitted?: (receipt: MassUlwCommittedPublicationReceipt) => void | Promise<void>;
};

export type MassUlwWorkspaceOptions = {
  repositoryRoot: string;
  lanes: MassUlwWorkspaceLane[];
  /** Parent for the private directory. Defaults to the operating-system temp directory. */
  tempRoot?: string;
  /** Durable parent used to recover an interrupted publication on restart. */
  recoveryRoot?: string;
  recoveryId?: string;
  hooks?: MassUlwWorkspaceHooks;
};

export type MassUlwFingerprintEntry = {
  path: string;
  kind: "file" | "symlink" | "missing";
  mode: number;
  digest: string;
};

export type MassUlwRepositoryFingerprint = {
  digest: string;
  head: string;
  indexDigest: string;
  index: string;
  entries: MassUlwFingerprintEntry[];
};

export type MassUlwLaneCheckout = {
  id: string;
  root: string;
  writeScopes: string[];
  executionBaselineCommit: string;
  preparedAncestorIds: string[];
};

export type MassUlwIntegrationResult = {
  commit: string;
  changedPaths: string[];
  laneCommits: Array<{ id: string; commit: string; changedPaths: string[] }>;
};

export type MassUlwPublishedPostimage = {
  readonly path: string;
  readonly exists: boolean;
  readonly digest: string;
};

export type MassUlwCommittedPublicationReceipt = {
  readonly version: 1;
  readonly repositoryRoot: string;
  readonly integrationCommit: string;
  readonly changedPaths: readonly string[];
  readonly laneCommits: MassUlwIntegrationResult["laneCommits"];
  readonly publishFingerprint: string;
  readonly postimages: readonly MassUlwPublishedPostimage[];
};

export type MassUlwPublicationRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "rolled-back" }
  | { readonly kind: "committed"; readonly receipt: MassUlwCommittedPublicationReceipt };

export type MassUlwPublishResult = {
  changedPaths: string[];
  journalPath: string;
  rolledBack: boolean;
  receipt?: MassUlwCommittedPublicationReceipt;
};

export type TreeChange = { path: string; oldMode: string | null; newMode: string | null };
export type PathImage = { exists: boolean; kind: "file" | "symlink" | "missing"; mode: number; bytes: Buffer };
export type JournalRecord = {
  version: 1;
  repositoryRoot: string;
  phase: "prepared" | "publishing" | "committed" | "rolling-back" | "rolled-back";
  paths: string[];
  applied: string[];
  preexisting: string[];
  backedUp: string[];
  receipt?: MassUlwCommittedPublicationReceipt;
};
