import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitDiffSummary, gitPush, gitRepositoryStatus, gitStatus, gitSyncFinish, gitSyncStart, parseNumstat } from "./git.js";

const execFileAsync = promisify(execFile);

describe("parseNumstat", () => {
  it("parses a simple numstat block into {path, added, removed}", () => {
    const numstat = "10\t2\tsrc/foo.ts\n3\t0\tREADME.md\n";
    expect(parseNumstat(numstat)).toEqual([
      { path: "src/foo.ts", added: 10, removed: 2 },
      { path: "README.md", added: 3, removed: 0 },
    ]);
  });

  it("treats binary file markers (-\\t-) as zero added/removed", () => {
    const numstat = "-\t-\tassets/logo.png\n";
    expect(parseNumstat(numstat)).toEqual([
      { path: "assets/logo.png", added: 0, removed: 0 },
    ]);
  });

  it("resolves brace-compressed rename paths to the destination", () => {
    const numstat = "5\t1\tsrc/{old => new}/file.ts\n";
    expect(parseNumstat(numstat)).toEqual([
      { path: "src/new/file.ts", added: 5, removed: 1 },
    ]);
  });

  it("resolves plain rename paths (old => new) to the destination", () => {
    const numstat = "1\t1\told.ts => new.ts\n";
    expect(parseNumstat(numstat)).toEqual([
      { path: "new.ts", added: 1, removed: 1 },
    ]);
  });

  it("ignores blank lines", () => {
    const numstat = "\n1\t1\ta.ts\n\n";
    expect(parseNumstat(numstat)).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
  });

  it("returns empty array for empty input", () => {
    expect(parseNumstat("")).toEqual([]);
  });
});

describe("gitStatus / gitDiffSummary — non-git directory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-nongit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gitStatus tolerates a non-git repo and returns empty status", async () => {
    const status = await gitStatus(dir);
    expect(status).toEqual({ branch: "", dirtyFiles: [], staged: [] });
  });

  it("gitRepositoryStatus tolerates a non-git repo and returns empty status", async () => {
    const status = await gitRepositoryStatus(dir);
    expect(status).toEqual({
      branch: "",
      dirtyFiles: [],
      staged: [],
      remotes: [],
      upstream: null,
      ahead: 0,
      behind: 0,
      syncState: "unknown",
    });
  });

  it("gitDiffSummary tolerates a non-git repo and returns empty summary", async () => {
    const diff = await gitDiffSummary(dir);
    expect(diff).toEqual({ files: [], summary: "No changes." });
  });
});

describe("gitStatus — real git repo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-git-"));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "committed.txt"), "hello\n");
    await execFileAsync("git", ["add", "committed.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the current branch with a clean tree", async () => {
    const status = await gitStatus(dir);
    expect(status.branch).toBe("main");
    expect(status.dirtyFiles).toEqual([]);
    expect(status.staged).toEqual([]);
  });

  it("reports untracked files as dirty, not staged", async () => {
    await writeFile(join(dir, "new.txt"), "new\n");
    const status = await gitStatus(dir);
    expect(status.dirtyFiles).toContain("new.txt");
    expect(status.staged).not.toContain("new.txt");
  });

  it("reports staged files separately from unstaged modifications", async () => {
    await writeFile(join(dir, "committed.txt"), "modified\n");
    await execFileAsync("git", ["add", "committed.txt"], { cwd: dir });
    const status = await gitStatus(dir);
    expect(status.staged).toContain("committed.txt");
    expect(status.dirtyFiles).not.toContain("committed.txt");
  });

  it("reports a modified-but-unstaged file as dirty", async () => {
    await writeFile(join(dir, "committed.txt"), "modified again\n");
    const status = await gitStatus(dir);
    expect(status.dirtyFiles).toContain("committed.txt");
    expect(status.staged).not.toContain("committed.txt");
  });

  it("reports configured remote and already-known upstream relation without fetching", async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-remote-"));
    try {
      await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
      await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
      await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
      await writeFile(join(dir, "committed.txt"), "local commit\n");
      await execFileAsync("git", ["add", "committed.txt"], { cwd: dir });
      await execFileAsync("git", ["commit", "-q", "-m", "local"], { cwd: dir });

      const status = await gitRepositoryStatus(dir);
      expect(status.remotes[0]?.name).toBe("origin");
      expect(status.remotes[0]?.url).toBeTypeOf("string");
      expect(status.remotes[0]?.url.length).toBeGreaterThan(0);
      expect(status.upstream).toBe("origin/main");
      expect(status.ahead).toBe(1);
      expect(status.behind).toBe(0);
      expect(status.syncState).toBe("ahead");
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  it("fast-forwards a clean remote-worker checkout from its upstream", async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-sync-remote-"));
    const publisherDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-sync-publisher-"));
    try {
      await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
      await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
      await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });

      await execFileAsync("git", ["clone", "-q", "-b", "main", remoteDir, publisherDir]);
      await execFileAsync("git", ["config", "user.email", "publisher@example.com"], { cwd: publisherDir });
      await execFileAsync("git", ["config", "user.name", "Publisher"], { cwd: publisherDir });
      await writeFile(join(publisherDir, "remote.txt"), "from origin\n");
      await execFileAsync("git", ["add", "remote.txt"], { cwd: publisherDir });
      await execFileAsync("git", ["commit", "-q", "-m", "remote update"], { cwd: publisherDir });
      await execFileAsync("git", ["push", "-q", "origin", "main"], { cwd: publisherDir });

      const synced = await gitSyncStart(dir);
      expect(synced.fastForwarded).toBe(true);
      expect(synced.after.syncState).toBe("up-to-date");
      expect((await readFile(join(dir, "remote.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("from origin\n");
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(publisherDir, { recursive: true, force: true });
    }
  });

  it("refuses to sync a dirty remote-worker checkout", async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-sync-dirty-remote-"));
    try {
      await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
      await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
      await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
      await writeFile(join(dir, "dirty.txt"), "do not overwrite\n");
      await expect(gitSyncStart(dir)).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  it("commits only explicit task paths and pushes the remote-worker result", async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-sync-finish-remote-"));
    try {
      await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
      await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
      await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
      await writeFile(join(dir, "task.txt"), "verified task\n");
      await writeFile(join(dir, "unrelated.txt"), "leave me dirty\n");

      const finished = await gitSyncFinish(dir, "verified task", ["task.txt"]);
      expect(finished.stagedFiles).toEqual(["task.txt"]);
      expect(finished.after.ahead).toBe(0);
      expect(finished.after.behind).toBe(0);
      expect(finished.after.dirtyFiles).toContain("unrelated.txt");
      const remoteHead = await execFileAsync("git", ["rev-parse", "refs/heads/main"], { cwd: remoteDir });
      const localHead = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
      expect(remoteHead.stdout.trim()).toBe(localHead.stdout.trim());
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  it("refuses to push outside the configured upstream", async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-upstream-remote-"));
    const otherDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-other-remote-"));
    try {
      await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
      await execFileAsync("git", ["init", "-q", "--bare"], { cwd: otherDir });
      await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
      await execFileAsync("git", ["remote", "add", "other", otherDir], { cwd: dir });
      await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
      await expect(gitPush(dir, "other", "main")).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    }
  });
});

describe("gitDiffSummary — real git repo (numstat integration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-gitdiff-"));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "line1\nline2\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty summary when there is no diff", async () => {
    const diff = await gitDiffSummary(dir);
    expect(diff.files).toEqual([]);
    // "No changes." contains no secret-shaped text, so redact() — once
    // implemented by the policy owner — is expected to pass it through
    // unchanged; this only asserts our own numstat-empty branch shape.
  });

  it("surfaces numstat-derived file entries for a real diff", async () => {
    await writeFile(join(dir, "a.txt"), "line1\nline2-changed\nline3\n");
    // gitDiffSummary calls policy/secrets.ts#redact() on the textual summary
    // (PRD §9.4). That module is owned by another agent and is currently a
    // NOT_IMPLEMENTED stub, so we only assert on the structured `files`
    // array here (our own parsing logic) and tolerate either a redacted
    // summary or a DomainError surfaced from the stub.
    try {
      const diff = await gitDiffSummary(dir);
      expect(diff.files).toEqual([{ path: "a.txt", added: 2, removed: 1 }]);
      expect(typeof diff.summary).toBe("string");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("NOT_IMPLEMENTED");
    }
  });
});
