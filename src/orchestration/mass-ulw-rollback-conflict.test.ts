import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicationTransactionRoot, recoverMassUlwPublication } from "./mass-ulw-publish-recovery.js";
import { cleanupExecutorRoots, git, makeExecutorRepository, temporaryExecutorRoot } from "./mass-ulw-runner-fixtures.js";
import { createMassUlwWorkspace } from "./mass-ulw-workspace.js";
import { imageDigest, readPathImage } from "./mass-ulw-workspace-repository.js";
import type { JournalRecord } from "./mass-ulw-workspace-types.js";

afterEach(cleanupExecutorRoots);

async function interruptedPublication(before: string | null = "original\n", after: string | null = "published\n") {
  const repositoryRoot = await temporaryExecutorRoot("mass-ulw-rollback-repo-");
  const recoveryRoot = await temporaryExecutorRoot("mass-ulw-rollback-state-");
  const recoveryId = "interrupted";
  const relative = "file.txt";
  const transactionRoot = publicationTransactionRoot(recoveryRoot, recoveryId);
  const backupRoot = join(transactionRoot, "backup");
  const destination = join(repositoryRoot, relative);
  const backup = join(backupRoot, relative);
  await mkdir(backupRoot, { recursive: true });
  if (before !== null) await writeFile(backup, before);
  const preimage = imageDigest(await readPathImage(backupRoot, relative));
  if (after !== null) await writeFile(destination, after);
  const postimage = imageDigest(await readPathImage(repositoryRoot, relative));
  const journal: JournalRecord = {
    version: 1, repositoryRoot, phase: "publishing", paths: [relative], applied: [relative],
    preexisting: before === null ? [] : [relative],
    backedUp: before === null ? [] : [relative],
    ownership: [{ path: relative, preimage, postimage }],
  };
  const journalPath = join(transactionRoot, "journal.json");
  const saveJournal = () => writeFile(journalPath, JSON.stringify(journal));
  await saveJournal();
  return {
    destination, backup, journal, journalPath, saveJournal, transactionRoot,
    recover: () => recoverMassUlwPublication({ repositoryRoot, recoveryRoot, recoveryId }),
  };
}

describe("MASS ULW rollback ownership", () => {
  it("preserves every path and recovery artifact when a user edits an already-published existing file", async () => {
    // Given a real publication with an original preimage and a second, added path.
    const repositoryRoot = await makeExecutorRepository();
    const recoveryRoot = await temporaryExecutorRoot("mass-ulw-rollback-state-");
    const recoveryId = "edited-existing";
    const existing = "src/a/a.txt";
    const added = "src/a/z.txt";
    await writeFile(join(repositoryRoot, existing), "original\n");
    await git(repositoryRoot, ["add", "-A"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "existing preimage"]);
    const workspace = await createMassUlwWorkspace({
      repositoryRoot, recoveryRoot, recoveryId,
      lanes: [{ id: "a", writeScopes: ["src/a"] }],
      hooks: {
        afterPublishPath: async (relative) => {
          if (relative !== added) return;
          await writeFile(join(repositoryRoot, existing), "user edit after publication\n");
          throw new Error("injected interruption");
        },
      },
    });
    try {
      const lane = workspace.lanes[0];
      if (!lane) throw new Error("Missing lane fixture");
      await writeFile(join(lane.root, existing), "published existing\n");
      await writeFile(join(lane.root, added), "published addition\n");
      await git(lane.root, ["add", "-A"]);
      await git(lane.root, ["commit", "-q", "-m", "publish two paths"]);

      // When the interruption triggers rollback after the user edit.
      const failure = await workspace.publish().catch((error: unknown) => error);

      // Then preflight preserves the user's edit, even the nonconflicting path,
      // and the original backup and durable journal for explicit recovery.
      expect(await readFile(join(repositoryRoot, existing), "utf8")).toBe("user edit after publication\n");
      expect(await readFile(join(repositoryRoot, added), "utf8")).toBe("published addition\n");
      expect(failure).toBeInstanceOf(AggregateError);
      const transactionRoot = publicationTransactionRoot(recoveryRoot, recoveryId);
      expect(await readFile(join(transactionRoot, "backup", existing), "utf8")).toBe("original\n");
      const journal = await readFile(join(transactionRoot, "journal.json"), "utf8");
      expect(JSON.parse(journal)).toMatchObject({ phase: "publishing", applied: [existing, added] });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(recoverMassUlwPublication({ repositoryRoot, recoveryRoot, recoveryId }))
          .rejects.toMatchObject({ code: "MASS_ULW_ROLLBACK_CONFLICT", relativePath: existing });
        expect(await readFile(join(repositoryRoot, existing), "utf8")).toBe("user edit after publication\n");
        expect(await readFile(join(transactionRoot, "journal.json"), "utf8")).toBe(journal);
      }
    } finally {
      await workspace.cleanup();
    }
  });

  it("preserves a user's edit to a newly published path", async () => {
    // Given a real newly-added publication, edited at the exact post-rename seam.
    const repositoryRoot = await makeExecutorRepository();
    const recoveryRoot = await temporaryExecutorRoot("mass-ulw-rollback-state-");
    const recoveryId = "edited-addition";
    const relative = "src/a/new.txt";
    const workspace = await createMassUlwWorkspace({
      repositoryRoot, recoveryRoot, recoveryId,
      lanes: [{ id: "a", writeScopes: ["src/a"] }],
      hooks: { afterPublishPath: async () => {
        await writeFile(join(repositoryRoot, relative), "user-owned addition\n");
        throw new Error("injected interruption");
      } },
    });
    try {
      const lane = workspace.lanes[0];
      if (!lane) throw new Error("Missing lane fixture");
      await mkdir(join(lane.root, "src", "a"), { recursive: true });
      await writeFile(join(lane.root, relative), "published addition\n");
      await git(lane.root, ["add", "-A"]);
      await git(lane.root, ["commit", "-q", "-m", "add path"]);
      // When publishing fails after the user edit.
      const failure = await workspace.publish().catch((error: unknown) => error);
      // Then neither immediate rollback nor restart recovery removes it.
      expect(failure).toBeInstanceOf(AggregateError);
      expect(await readFile(join(repositoryRoot, relative), "utf8")).toBe("user-owned addition\n");
      await expect(recoverMassUlwPublication({ repositoryRoot, recoveryRoot, recoveryId }))
        .rejects.toMatchObject({ code: "MASS_ULW_ROLLBACK_CONFLICT", relativePath: relative });
      expect(await readFile(join(repositoryRoot, relative), "utf8")).toBe("user-owned addition\n");
    } finally {
      await workspace.cleanup();
    }
  });

  it.each([
    ["replacement", "original\n", "published\n"],
    ["addition", null, "published\n"],
    ["deletion", "original\n", null],
  ])("rolls back an unchanged %s and makes subsequent recovery a no-op", async (_kind, before, after) => {
    // Given the exact filesystem postimage of an interrupted publication.
    const fixture = await interruptedPublication(before, after);
    // When recovering once, then again after cleanup.
    expect(await fixture.recover()).toEqual({ kind: "rolled-back" });
    expect(await fixture.recover()).toEqual({ kind: "none" });
    // Then the preimage is restored and the terminal journal is cleaned up.
    if (before === null) await expect(stat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(fixture.destination, "utf8")).toBe(before);
    await expect(stat(fixture.transactionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["before-backup", "after-backup", "after-restore"] as const)("recovers the %s rename gap without relying on applied/backedUp completion", async (gap) => {
    // Given persisted intent with the filesystem paused at a precise rename gap.
    const fixture = await interruptedPublication();
    if (gap === "after-backup") await rm(fixture.destination);
    else {
      await rm(fixture.destination);
      await rename(fixture.backup, fixture.destination);
    }
    fixture.journal.backedUp = gap === "after-restore" ? ["file.txt"] : [];
    fixture.journal.phase = gap === "after-restore" ? "rolling-back" : "publishing";
    await fixture.saveJournal();
    // When recovering the stale journal.
    expect(await fixture.recover()).toEqual({ kind: "rolled-back" });
    // Then original bytes survive regardless of which rename completed.
    expect(await readFile(fixture.destination, "utf8")).toBe("original\n");
  });

  it("keeps a user edit when applied was journaled but the backup rename never happened", async () => {
    // Given a crash before mutation, followed by a user edit.
    const fixture = await interruptedPublication();
    await rm(fixture.backup);
    await writeFile(fixture.destination, "subsequent user edit\n");
    fixture.journal.backedUp = [];
    await fixture.saveJournal();
    const journal = await readFile(fixture.journalPath, "utf8");
    // When recovering.
    await expect(fixture.recover()).rejects.toMatchObject({ code: "MASS_ULW_ROLLBACK_CONFLICT" });
    // Then neither ownership ambiguity nor missing backup discards the journal.
    expect(await readFile(fixture.destination, "utf8")).toBe("subsequent user edit\n");
    expect(await readFile(fixture.journalPath, "utf8")).toBe(journal);
  });

  it("preserves a changed backup instead of restoring unowned bytes", async () => {
    // Given a valid postimage but a diverged original backup.
    const fixture = await interruptedPublication();
    await writeFile(fixture.backup, "changed backup\n");
    const journal = await readFile(fixture.journalPath, "utf8");
    // When recovering.
    await expect(fixture.recover()).rejects.toMatchObject({ code: "MASS_ULW_ROLLBACK_CONFLICT" });
    // Then all three artifacts remain untouched.
    expect(await readFile(fixture.destination, "utf8")).toBe("published\n");
    expect(await readFile(fixture.backup, "utf8")).toBe("changed backup\n");
    expect(await readFile(fixture.journalPath, "utf8")).toBe(journal);
  });

  it("preserves a user-created directory replacing an added file", async () => {
    // Given a user replacing the new file with a directory containing their work.
    const fixture = await interruptedPublication(null);
    await rm(fixture.destination);
    await mkdir(fixture.destination);
    await writeFile(join(fixture.destination, "user.txt"), "user directory contents\n");
    // When recovering.
    await expect(fixture.recover()).rejects.toMatchObject({ code: "MASS_ULW_ROLLBACK_CONFLICT" });
    // Then rollback never recursively deletes the replacement directory.
    expect(await readFile(join(fixture.destination, "user.txt"), "utf8")).toBe("user directory contents\n");
  });

  it.each(["existing", "added"] as const)("keeps ambiguous legacy %s destination bytes as a conflict", async (kind) => {
    // Given a supported version-1 journal without ownership evidence.
    const fixture = await interruptedPublication(kind === "existing" ? "original\n" : null);
    delete fixture.journal.ownership;
    await fixture.saveJournal();
    const journal = await readFile(fixture.journalPath, "utf8");
    // When recovering bytes that could belong to a subsequent user edit.
    await expect(fixture.recover()).rejects.toMatchObject({ code: "MASS_ULW_ROLLBACK_CONFLICT" });
    // Then legacy data is retained rather than silently destroyed.
    expect(await readFile(fixture.destination, "utf8")).toBe("published\n");
    if (kind === "existing") expect(await readFile(fixture.backup, "utf8")).toBe("original\n");
    expect(await readFile(fixture.journalPath, "utf8")).toBe(journal);
  });

  it("restores a legacy backup when its destination is absent", async () => {
    // Given a legacy crash after the backup rename and before destination creation.
    const fixture = await interruptedPublication();
    await rm(fixture.destination);
    delete fixture.journal.ownership;
    fixture.journal.backedUp = [];
    await fixture.saveJournal();
    // When recovering a state that requires no ambiguous data deletion.
    expect(await fixture.recover()).toEqual({ kind: "rolled-back" });
    // Then the original legacy backup is restored.
    expect(await readFile(fixture.destination, "utf8")).toBe("original\n");
  });
});
