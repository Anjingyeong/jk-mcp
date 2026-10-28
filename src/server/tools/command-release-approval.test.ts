import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gitRefLineHashMatchesCommit, jkReleaseCommit, jkRepoCleanAligned } from "./command.js";

describe("JK release approval identity", () => {
  const clean = {
    branch: "main",
    headCommit: "a".repeat(40),
    dirtyFiles: [],
    staged: [],
    remotes: [{ name: "origin", url: "git@example/repo.git" }],
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    syncState: "up-to-date" as const,
  };

  it("shares only a clean upstream-aligned commit", () => {
    expect(jkReleaseCommit(clean)).toBe("a".repeat(40));
    expect(jkReleaseCommit({ ...clean, dirtyFiles: ["local.txt"] })).toBeNull();
    expect(jkReleaseCommit({ ...clean, staged: ["staged.txt"] })).toBeNull();
    expect(jkReleaseCommit({ ...clean, ahead: 1, syncState: "ahead" as const })).toBeNull();
    expect(jkReleaseCommit({ ...clean, behind: 1, syncState: "behind" as const })).toBeNull();
    expect(jkReleaseCommit({ ...clean, upstream: null, syncState: "unknown" as const })).toBeNull();
    expect(jkReleaseCommit({ ...clean, headCommit: null })).toBeNull();
  });

  it("proves an old executor ref by original line hash without exposing the commit", () => {
    const commit = "b".repeat(40);
    const lineHash = createHash("sha256").update(commit).digest("hex");
    expect(jkRepoCleanAligned({ ...clean, headCommit: undefined })).toBe(true);
    expect(gitRefLineHashMatchesCommit(commit, [lineHash])).toBe(true);
    expect(gitRefLineHashMatchesCommit("c".repeat(40), [lineHash])).toBe(false);
  });
});
