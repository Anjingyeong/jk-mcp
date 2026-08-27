import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertNoSymlinkParents, imagesEqual, treeChanges, writeJournal } from "./mass-ulw-workspace-changes.js";
import { massUlwPublishFingerprint, rollbackMassUlwPublication } from "./mass-ulw-publish-recovery.js";
import {
  absoluteFromRelative,
  fingerprintMassUlwRepository,
  git,
  gitBytes,
  readPathImage,
} from "./mass-ulw-workspace-repository.js";
import type {
  JournalRecord,
  MassUlwIntegrationResult,
  MassUlwPublishResult,
  MassUlwRepositoryFingerprint,
  MassUlwWorkspaceHooks,
  PathImage,
} from "./mass-ulw-workspace-types.js";

export async function publishMassUlwWorkspace(input: {
  repositoryRoot: string;
  privateRoot: string;
  baselineCommit: string;
  initialFingerprint: MassUlwRepositoryFingerprint;
  integration: MassUlwIntegrationResult;
  hooks: MassUlwWorkspaceHooks;
  durableTransactionRoot: string | null;
  onTerminal(): void;
}): Promise<MassUlwPublishResult> {
  const current = await fingerprintMassUlwRepository(input.repositoryRoot);
  if (current.digest !== input.initialFingerprint.digest) {
    throw new Error("Original repository changed during Mass ULW execution; publish blocked");
  }
  const mergedRoot = path.join(input.privateRoot, "merged");
  const changes = await treeChanges(mergedRoot, input.baselineCommit, input.integration.commit);
  for (const change of changes) {
    if (change.oldMode === "120000" || change.newMode === "120000" || change.oldMode === "160000" || change.newMode === "160000") {
      throw new Error(`Unsafe publish mode for path: ${change.path}`);
    }
  }

  const preimages = new Map<string, PathImage>();
  for (const change of changes) preimages.set(change.path, await readPathImage(input.repositoryRoot, change.path));
  const transactionRoot = input.durableTransactionRoot ?? path.join(input.privateRoot, `publish-${randomUUID()}`);
  const backupRoot = path.join(transactionRoot, "backup");
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const journalPath = path.join(transactionRoot, "journal.json");
  const journal: JournalRecord = {
    version: 1,
    repositoryRoot: input.repositoryRoot,
    phase: "prepared",
    paths: changes.map((change) => change.path),
    applied: [],
    preexisting: changes.filter((change) => preimages.get(change.path)!.exists).map((change) => change.path),
    backedUp: [],
  };
  await writeJournal(journalPath, journal);
  try {
    journal.phase = "publishing";
    await writeJournal(journalPath, journal);
    for (let ordinal = 0; ordinal < changes.length; ordinal += 1) {
      const change = changes[ordinal]!;
      await input.hooks.beforePublishPath?.(change.path, ordinal);
      await assertNoSymlinkParents(input.repositoryRoot, change.path);
      const expected = preimages.get(change.path)!;
      const actual = await readPathImage(input.repositoryRoot, change.path);
      if (!imagesEqual(expected, actual)) throw new Error(`Publish preimage changed: ${change.path}`);
      const destination = absoluteFromRelative(input.repositoryRoot, change.path);
      const backup = absoluteFromRelative(backupRoot, change.path);
      journal.applied.push(change.path);
      await writeJournal(journalPath, journal);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      if (expected.exists) {
        await fs.rename(destination, backup);
        journal.backedUp.push(change.path);
        await writeJournal(journalPath, journal);
      }
      if (change.newMode !== null) {
        const bytes = await gitBytes(mergedRoot, ["show", `${input.integration.commit}:${change.path}`]);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const modeChanged = change.oldMode !== change.newMode;
        const mode = modeChanged ? (change.newMode === "100755" ? 0o755 : 0o644) : (expected.mode & 0o777) || 0o644;
        const temporary = `${destination}.mass-ulw-${randomUUID()}`;
        await fs.writeFile(temporary, bytes, { mode });
        await fs.chmod(temporary, mode);
        await fs.rename(temporary, destination);
      }
      await input.hooks.afterPublishPath?.(change.path, ordinal);
    }
    const afterHead = (await git(input.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const afterIndex = await git(input.repositoryRoot, ["ls-files", "--stage", "-z"]);
    if (afterHead !== input.initialFingerprint.head || afterIndex !== input.initialFingerprint.index) {
      throw new Error("Original HEAD or index changed during publish");
    }
    const changedPaths = changes.map((change) => change.path);
    const postimages = await Promise.all(changedPaths.map(async (relative) => {
      const image = await readPathImage(input.repositoryRoot, relative);
      return {
        path: relative,
        exists: image.exists,
        digest: createHash("sha256").update(image.bytes).digest("hex"),
      };
    }));
    const receipt = {
      version: 1 as const,
      repositoryRoot: input.repositoryRoot,
      integrationCommit: input.integration.commit,
      changedPaths,
      laneCommits: input.integration.laneCommits,
      publishFingerprint: massUlwPublishFingerprint(input.integration.commit, changedPaths),
      postimages,
    };
    journal.receipt = receipt;
    journal.phase = "committed";
    await writeJournal(journalPath, journal);
    await fs.rm(backupRoot, { recursive: true, force: true });
    await input.hooks.afterPublicationCommitted?.(receipt);
    input.onTerminal();
    return { changedPaths, journalPath, rolledBack: false, receipt };
  } catch (error) {
    if (journal.phase === "committed") throw error;
    try {
      await rollbackMassUlwPublication(transactionRoot, journal);
      input.onTerminal();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "MASS ULW publication and rollback both failed");
    }
    throw error;
  }
}
