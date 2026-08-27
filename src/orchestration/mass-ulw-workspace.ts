import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { auditChanges, treeChanges, validateLanes } from "./mass-ulw-workspace-changes.js";
import { createSnapshotCommit, fingerprintMassUlwRepository, git, gitBytes, requireRepositoryRoot, restoreOriginalCheckout } from "./mass-ulw-workspace-repository.js";
import { prepareMassUlwLaneDependencies } from "./mass-ulw-workspace-dependencies.js";
import { publicationTransactionRoot, recoverMassUlwPublication } from "./mass-ulw-publish-recovery.js";
import { publishMassUlwWorkspace } from "./mass-ulw-workspace-publish.js";
import type { MassUlwIntegrationResult, MassUlwLaneCheckout, MassUlwPublishResult, MassUlwRepositoryFingerprint, MassUlwWorkspaceHooks, MassUlwWorkspaceLane, MassUlwWorkspaceOptions } from "./mass-ulw-workspace-types.js";

const GIT_ENV = { GIT_AUTHOR_NAME: "Mass ULW", GIT_AUTHOR_EMAIL: "mass-ulw@localhost", GIT_COMMITTER_NAME: "Mass ULW", GIT_COMMITTER_EMAIL: "mass-ulw@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } as const;

export { fingerprintMassUlwRepository } from "./mass-ulw-workspace-repository.js";
export type { MassUlwCommittedPublicationReceipt, MassUlwFingerprintEntry, MassUlwIntegrationResult, MassUlwLaneCheckout, MassUlwPublishResult, MassUlwRepositoryFingerprint, MassUlwWorkspaceHooks, MassUlwWorkspaceLane, MassUlwWorkspaceOptions } from "./mass-ulw-workspace-types.js";

export function massUlwPrivateWorkspaceRoot(
  tempRoot: string | undefined,
  recoveryRoot: string,
  recoveryId: string,
): string {
  const owner = createHash("sha256").update(path.resolve(recoveryRoot)).update("\0").update(recoveryId).digest("hex");
  return path.join(path.resolve(tempRoot ?? os.tmpdir()), `mass-ulw-${owner.slice(0, 24)}`);
}

export async function cleanupMassUlwPrivateWorkspace(
  tempRoot: string | undefined,
  recoveryRoot: string,
  recoveryId: string,
): Promise<void> {
  await fs.rm(massUlwPrivateWorkspaceRoot(tempRoot, recoveryRoot, recoveryId), { recursive: true, force: true });
}

export class MassUlwWorkspace {
  readonly repositoryRoot: string;
  readonly privateRoot: string;
  readonly integrationRoot: string;
  readonly baselineCommit: string;
  readonly lanes: readonly MassUlwLaneCheckout[];
  readonly initialFingerprint: MassUlwRepositoryFingerprint;

  private readonly laneDefinitions: readonly MassUlwWorkspaceLane[];
  private readonly hooks: MassUlwWorkspaceHooks;
  private readonly durableTransactionRoot: string | null;
  private integrationResult: MassUlwIntegrationResult | null = null;
  private publicationTerminal = false;
  private cleaned = false;

  private constructor(input: {
    repositoryRoot: string;
    privateRoot: string;
    integrationRoot: string;
    baselineCommit: string;
    lanes: MassUlwLaneCheckout[];
    laneDefinitions: MassUlwWorkspaceLane[];
    initialFingerprint: MassUlwRepositoryFingerprint;
    durableTransactionRoot: string | null;
    hooks?: MassUlwWorkspaceHooks;
  }) {
    Object.assign(this, input);
    this.repositoryRoot = input.repositoryRoot;
    this.privateRoot = input.privateRoot;
    this.integrationRoot = input.integrationRoot;
    this.baselineCommit = input.baselineCommit;
    this.lanes = input.lanes;
    this.laneDefinitions = input.laneDefinitions;
    this.initialFingerprint = input.initialFingerprint;
    this.durableTransactionRoot = input.durableTransactionRoot;
    this.hooks = input.hooks ?? {};
  }

  static async create(options: MassUlwWorkspaceOptions): Promise<MassUlwWorkspace> {
    const definitions = validateLanes(options.lanes);
    if (definitions.length === 0) throw new Error("Mass ULW requires at least one lane");
    const { root } = await requireRepositoryRoot(options.repositoryRoot);
    if (Boolean(options.recoveryRoot) !== Boolean(options.recoveryId)) {
      throw new Error("MASS ULW publication recovery requires both recoveryRoot and recoveryId");
    }
    const durableTransactionRoot = options.recoveryRoot && options.recoveryId
      ? publicationTransactionRoot(options.recoveryRoot, options.recoveryId)
      : null;
    if (options.recoveryRoot && options.recoveryId) {
      const recovery = await recoverMassUlwPublication({
        recoveryRoot: options.recoveryRoot,
        recoveryId: options.recoveryId,
        repositoryRoot: root,
      });
      if (recovery.kind === "committed") {
        throw new Error("MASS ULW committed publication requires executor state reconciliation");
      }
    }
    const initialFingerprint = await fingerprintMassUlwRepository(root);
    const tempParent = path.resolve(options.tempRoot ?? os.tmpdir());
    await fs.mkdir(tempParent, { recursive: true });
    const privateRoot = options.recoveryRoot && options.recoveryId
      ? massUlwPrivateWorkspaceRoot(options.tempRoot, options.recoveryRoot, options.recoveryId)
      : await fs.mkdtemp(path.join(tempParent, "mass-ulw-"));
    if (options.recoveryRoot && options.recoveryId) {
      await fs.rm(privateRoot, { recursive: true, force: true });
      await fs.mkdir(privateRoot, { mode: 0o700 });
    }
    await fs.chmod(privateRoot, 0o700);
    const integrationRoot = path.join(privateRoot, "integration");
    try {
      await git(privateRoot, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", root, integrationRoot]);
      // A clone probes its own filesystem and may choose a different filemode setting.
      // Matching the source prevents an unchanged baseline from becoming mode-dirty.
      const sourceFileMode = (await git(root, ["config", "--bool", "core.filemode"])).trim();
      await git(integrationRoot, ["config", "core.filemode", sourceFileMode || "false"]);
      await git(integrationRoot, ["checkout", "--quiet", "--detach", initialFingerprint.head]);
      await restoreOriginalCheckout(root, integrationRoot, initialFingerprint);
      const baselineCommit = await createSnapshotCommit(integrationRoot, initialFingerprint.head, privateRoot);
      const checkouts: MassUlwLaneCheckout[] = [];
      for (const lane of definitions) {
        const laneRoot = path.join(privateRoot, `lane-${lane.id}`);
        await git(privateRoot, ["clone", "--quiet", "--no-hardlinks", "--branch", "mass-ulw-baseline", integrationRoot, laneRoot]);
        await git(laneRoot, ["checkout", "--quiet", "--detach", baselineCommit]);
        await git(laneRoot, ["config", "user.name", "Mass ULW"]);
        await git(laneRoot, ["config", "user.email", "mass-ulw@localhost"]);
        checkouts.push({
          id: lane.id,
          root: laneRoot,
          writeScopes: lane.writeScopes,
          executionBaselineCommit: baselineCommit,
          preparedAncestorIds: [],
        });
      }
      return new MassUlwWorkspace({
        repositoryRoot: root,
        privateRoot,
        integrationRoot,
        baselineCommit,
        lanes: checkouts,
        laneDefinitions: definitions,
        initialFingerprint,
        durableTransactionRoot,
        hooks: options.hooks,
      });
    } catch (error) {
      await fs.rm(privateRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async prepareLane(laneId: string, ancestorIds: string[]): Promise<void> {
    if (this.cleaned) throw new Error("Mass ULW workspace is already cleaned");
    const target = this.lanes.find((lane) => lane.id === laneId);
    if (!target) throw new Error(`Unknown MASS ULW lane checkout: ${laneId}`);
    const ancestors = ancestorIds.map((ancestorId) => {
      const ancestor = this.lanes.find((lane) => lane.id === ancestorId);
      if (!ancestor) throw new Error(`Unknown MASS ULW ancestor checkout: ${ancestorId}`);
      return ancestor;
    });
    await prepareMassUlwLaneDependencies(this.privateRoot, target, ancestors);
  }

  async integrate(): Promise<MassUlwIntegrationResult> {
    if (this.cleaned) throw new Error("Mass ULW workspace is already cleaned");
    if (this.integrationResult) return this.integrationResult;
    const mergedRoot = path.join(this.privateRoot, "merged");
    await git(this.privateRoot, ["clone", "--quiet", "--no-hardlinks", "--branch", "mass-ulw-baseline", this.integrationRoot, mergedRoot]);
    await git(mergedRoot, ["config", "user.name", "Mass ULW"]);
    await git(mergedRoot, ["config", "user.email", "mass-ulw@localhost"]);

    const occupied = new Map<string, string>();
    const laneCommits: MassUlwIntegrationResult["laneCommits"] = [];
    for (const lane of [...this.laneDefinitions].sort((a, b) => a.id.localeCompare(b.id))) {
      const checkout = this.lanes.find((item) => item.id === lane.id)!;
      const status = await git(checkout.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      if (status) throw new Error(`Lane ${lane.id} has uncommitted changes`);
      const head = (await git(checkout.root, ["rev-parse", "HEAD"])).trim();
      const changes = await treeChanges(checkout.root, checkout.executionBaselineCommit, head);
      auditChanges(checkout.root, lane, changes);
      for (const change of changes) {
        const owner = occupied.get(change.path.toLowerCase());
        if (owner) throw new Error(`Lanes ${owner} and ${lane.id} both changed path: ${change.path}`);
        occupied.set(change.path.toLowerCase(), lane.id);
      }
      if (changes.length > 0) {
        const patch = await gitBytes(checkout.root, [
          "diff",
          "--binary",
          "--full-index",
          "--no-renames",
          checkout.executionBaselineCommit,
          head,
        ]);
        const patchPath = path.join(this.privateRoot, `lane-${lane.id}.patch`);
        await fs.writeFile(patchPath, patch, { mode: 0o600 });
        try {
          await git(mergedRoot, ["apply", "--index", "--binary", patchPath]);
          await git(mergedRoot, ["commit", "--quiet", "-m", `mass-ulw lane ${lane.id}`], GIT_ENV);
        } finally {
          await fs.rm(patchPath, { force: true });
        }
      }
      laneCommits.push({ id: lane.id, commit: head, changedPaths: changes.map((change) => change.path) });
    }
    const commit = (await git(mergedRoot, ["rev-parse", "HEAD"])).trim();
    const changedPaths = (await treeChanges(mergedRoot, this.baselineCommit, commit)).map((change) => change.path);
    this.integrationResult = { commit, changedPaths, laneCommits };
    return this.integrationResult;
  }

  async publish(): Promise<MassUlwPublishResult> {
    if (this.cleaned) throw new Error("Mass ULW workspace is already cleaned");
    const result = await this.integrate();
    return publishMassUlwWorkspace({
      repositoryRoot: this.repositoryRoot,
      privateRoot: this.privateRoot,
      baselineCommit: this.baselineCommit,
      initialFingerprint: this.initialFingerprint,
      integration: result,
      hooks: this.hooks,
      durableTransactionRoot: this.durableTransactionRoot,
      onTerminal: () => { this.publicationTerminal = true; },
    });
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await fs.rm(this.privateRoot, { recursive: true, force: true });
    if (this.durableTransactionRoot && this.publicationTerminal) {
      await fs.rm(this.durableTransactionRoot, { recursive: true, force: true });
    }
  }
}

export async function createMassUlwWorkspace(options: MassUlwWorkspaceOptions): Promise<MassUlwWorkspace> {
  return MassUlwWorkspace.create(options);
}

/** Execute lane callbacks concurrently, then integrate and publish; private workspaces are always removed. */
export async function runMassUlwWorkspace(
  options: MassUlwWorkspaceOptions,
  executeLane: (lane: MassUlwLaneCheckout) => void | Promise<void>,
): Promise<MassUlwPublishResult> {
  const workspace = await createMassUlwWorkspace(options);
  try {
    await Promise.all(workspace.lanes.map(executeLane));
    await workspace.integrate();
    return await workspace.publish();
  } finally {
    await workspace.cleanup();
  }
}
