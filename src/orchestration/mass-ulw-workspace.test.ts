import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMassUlwWorkspace,
  fingerprintMassUlwRepository,
  type MassUlwWorkspace,
  type MassUlwWorkspaceHooks,
  type MassUlwWorkspaceLane,
} from "./mass-ulw-workspace.js";
import { rmResilient } from "./mass-ulw-runner-fixtures.js";

const execFileAsync = promisify(execFile);
// Real git clone/integrate cycles take 10-20s each; under parallel CI load
// they can exceed 30s. Generous ceilings keep the suite load-resilient.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const cleanupRoots = new Set<string>();
const workspaces = new Set<MassUlwWorkspace>();

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.stdout;
}

async function makeRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mass-ulw-test-"));
  cleanupRoots.add(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Workspace Test"]);
  await git(root, ["config", "user.email", "workspace@example.test"]);
  await fs.mkdir(path.join(root, "src", "a"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "b"), { recursive: true });
  await fs.writeFile(path.join(root, "base.txt"), "base\n");
  await fs.writeFile(path.join(root, "src", "a", "existing.txt"), "a0\n");
  await fs.writeFile(path.join(root, "src", "b", "existing.txt"), "b0\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  return root;
}

async function create(
  root: string,
  lanes: MassUlwWorkspaceLane[],
  hooks?: MassUlwWorkspaceHooks,
): Promise<MassUlwWorkspace> {
  const workspace = await createMassUlwWorkspace({ repositoryRoot: root, lanes, hooks });
  workspaces.add(workspace);
  return workspace;
}

async function commitFile(laneRoot: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(laneRoot, ...relative.split("/"));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  await git(laneRoot, ["add", "-A"]);
  await git(laneRoot, ["commit", "-q", "-m", `change ${relative}`]);
}

afterEach(async () => {
  for (const workspace of workspaces) await workspace.cleanup();
  workspaces.clear();
  const receipts: string[] = [];
  for (const root of cleanupRoots) {
    await rmResilient(root);
    const removed = await fs.stat(root).then(() => false, () => true);
    receipts.push(`${path.basename(root)}:${removed ? "removed" : "present"}`);
  }
  cleanupRoots.clear();
  console.log(`[mass-ulw cleanup receipt] ${receipts.join(",")}`);
});

describe("Mass ULW workspace isolation", () => {
  it("requires a repository with a local HEAD", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mass-ulw-test-"));
    cleanupRoots.add(root);
    await git(root, ["init", "-q"]);
    await expect(createMassUlwWorkspace({ repositoryRoot: root, lanes: [{ id: "a", writeScopes: ["src/a"] }] }))
      .rejects.toThrow(/requires a local Git repository with HEAD/i);
  });

  it("fingerprints bytes and modes and preserves the dirty and staged baseline", async () => {
    const root = await makeRepository();
    await fs.writeFile(path.join(root, "base.txt"), "staged\n");
    await git(root, ["add", "base.txt"]);
    await fs.writeFile(path.join(root, "base.txt"), "dirty-after-stage\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "untracked\n");
    const statusBefore = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const before = await fingerprintMassUlwRepository(root);

    const workspace = await create(root, [{ id: "a", writeScopes: ["src/a"] }]);
    expect(await git(workspace.integrationRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(statusBefore);
    expect(await fs.readFile(path.join(workspace.integrationRoot, "base.txt"), "utf8")).toBe("dirty-after-stage\n");
    expect(await fs.readFile(path.join(workspace.integrationRoot, "untracked.txt"), "utf8")).toBe("untracked\n");

    await commitFile(workspace.lanes[0]!.root, "src/a/lane.txt", "lane a\n");
    await workspace.publish();
    expect(await fs.readFile(path.join(root, "src", "a", "lane.txt"), "utf8")).toBe("lane a\n");
    expect(await fs.readFile(path.join(root, "base.txt"), "utf8")).toBe("dirty-after-stage\n");
    const staged = await git(root, ["show", ":base.txt"]);
    expect(staged).toBe("staged\n");
    expect((await fingerprintMassUlwRepository(root)).indexDigest).toBe(before.indexDigest);
  });

  it("deterministically integrates disjoint lane commits", async () => {
    const root = await makeRepository();
    const workspace = await create(root, [
      { id: "z-lane", writeScopes: ["src/b"] },
      { id: "a-lane", writeScopes: ["src/a"] },
    ]);
    await Promise.all([
      commitFile(workspace.lanes.find((lane) => lane.id === "z-lane")!.root, "src/b/z.txt", "z\n"),
      commitFile(workspace.lanes.find((lane) => lane.id === "a-lane")!.root, "src/a/a.txt", "a\n"),
    ]);

    const integrated = await workspace.integrate();
    expect(integrated.laneCommits.map((lane) => lane.id)).toEqual(["a-lane", "z-lane"]);
    expect(integrated.changedPaths).toEqual(["src/a/a.txt", "src/b/z.txt"]);
    const published = await workspace.publish();
    expect(published.changedPaths).toEqual(["src/a/a.txt", "src/b/z.txt"]);
    expect(await fs.readFile(path.join(root, "src", "a", "a.txt"), "utf8")).toBe("a\n");
    expect(await fs.readFile(path.join(root, "src", "b", "z.txt"), "utf8")).toBe("z\n");
  });

  it("rejects out-of-scope and secret-classified lane changes", async () => {
    const root = await makeRepository();
    const outside = await create(root, [{ id: "a", writeScopes: ["src/a"] }]);
    await commitFile(outside.lanes[0]!.root, "src/b/escape.txt", "escape\n");
    await expect(outside.integrate()).rejects.toThrow(/out-of-scope path: src\/b\/escape\.txt/i);
    await outside.cleanup();
    workspaces.delete(outside);

    const secret = await create(root, [{ id: "a", writeScopes: ["src/a"] }]);
    await commitFile(secret.lanes[0]!.root, "src/a/access-token.txt", "not-a-real-secret\n");
    await expect(secret.integrate()).rejects.toThrow(/secret-classified path/i);
    expect(await fs.stat(path.join(root, "src", "b", "escape.txt")).then(() => true, () => false)).toBe(false);
  });

  it("blocks publish when the original repository changes concurrently", async () => {
    const root = await makeRepository();
    const workspace = await create(root, [{ id: "a", writeScopes: ["src/a"] }]);
    await commitFile(workspace.lanes[0]!.root, "src/a/lane.txt", "lane\n");
    await fs.writeFile(path.join(root, "base.txt"), "concurrent\n");

    await expect(workspace.publish()).rejects.toThrow(/changed during Mass ULW execution; publish blocked/i);
    expect(await fs.readFile(path.join(root, "base.txt"), "utf8")).toBe("concurrent\n");
    expect(await fs.stat(path.join(root, "src", "a", "lane.txt")).then(() => true, () => false)).toBe(false);
  });

  it("rolls back already-published paths after a transactional failure", async () => {
    const root = await makeRepository();
    const workspace = await create(
      root,
      [{ id: "a", writeScopes: ["src/a"] }],
      { beforePublishPath: (_relative, ordinal) => { if (ordinal === 1) throw new Error("injected publish fault"); } },
    );
    const lane = workspace.lanes[0]!.root;
    await fs.writeFile(path.join(lane, "src", "a", "existing.txt"), "changed\n");
    await fs.writeFile(path.join(lane, "src", "a", "second.txt"), "second\n");
    await git(lane, ["add", "-A"]);
    await git(lane, ["commit", "-q", "-m", "two changes"]);

    await expect(workspace.publish()).rejects.toThrow("injected publish fault");
    expect(await fs.readFile(path.join(root, "src", "a", "existing.txt"), "utf8")).toBe("a0\n");
    expect(await fs.stat(path.join(root, "src", "a", "second.txt")).then(() => true, () => false)).toBe(false);
    const journals = await fs.readdir(workspace.privateRoot, { recursive: true });
    const journalName = journals.find((name) => String(name).endsWith("journal.json"));
    expect(journalName).toBeDefined();
    const journal = JSON.parse(await fs.readFile(path.join(workspace.privateRoot, String(journalName)), "utf8")) as { phase: string };
    expect(journal.phase).toBe("rolled-back");
  });

  it("removes every private clone on cleanup", async () => {
    const root = await makeRepository();
    const workspace = await create(root, [{ id: "a", writeScopes: ["src/a"] }]);
    const privateRoot = workspace.privateRoot;
    await workspace.cleanup();
    workspaces.delete(workspace);
    expect(await fs.stat(privateRoot).then(() => false, () => true)).toBe(true);
  });
});
