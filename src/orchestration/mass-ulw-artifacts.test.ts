import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwArtifactStore } from "./mass-ulw-artifacts.js";
import { createMassUlwWorkspace } from "./mass-ulw-workspace.js";
import { rmResilient } from "./mass-ulw-runner-fixtures.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmResilient(root)));
});

describe("MassUlwArtifactStore", () => {
  it("restores completed lane outputs across process restart", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "mass-ulw-artifact-repo-"));
    const stateDir = await mkdtemp(join(tmpdir(), "mass-ulw-artifact-state-"));
    const tempRoot = await mkdtemp(join(tmpdir(), "mass-ulw-artifact-work-"));
    roots.push(repositoryRoot, stateDir, tempRoot);

    await writeFile(join(repositoryRoot, "baseline.txt"), "baseline\n", "utf8");
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.name", "Artifact Test"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.email", "artifact@example.test"], { cwd: repositoryRoot });
    await execFileAsync("git", ["add", "baseline.txt"], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "baseline"], { cwd: repositoryRoot });

    const artifacts = new MassUlwArtifactStore(stateDir, "restart-loop");
    const first = await createMassUlwWorkspace({
      repositoryRoot,
      tempRoot,
      lanes: [{ id: "A", writeScopes: ["src/a"] }],
    });
    const firstLane = first.lanes[0]!;
    await mkdir(join(firstLane.root, "src", "a"), { recursive: true });
    await writeFile(join(firstLane.root, "src", "a", "result.txt"), "completed A\n", "utf8");
    await execFileAsync("git", ["add", "--", "src/a"], { cwd: firstLane.root });
    await execFileAsync("git", ["commit", "-q", "-m", "complete A"], { cwd: firstLane.root });
    await artifacts.save({
      laneId: "A",
      checkoutRoot: firstLane.root,
      baselineCommit: firstLane.executionBaselineCommit,
    });
    await first.cleanup();

    const second = await createMassUlwWorkspace({
      repositoryRoot,
      tempRoot,
      lanes: [{ id: "A", writeScopes: ["src/a"] }],
    });
    const secondLane = second.lanes[0]!;
    await artifacts.restore({
      laneId: "A",
      checkoutRoot: secondLane.root,
      baselineCommit: secondLane.executionBaselineCommit,
    });

    expect((await execFileAsync("git", ["show", "HEAD:src/a/result.txt"], { cwd: secondLane.root })).stdout).toBe("completed A\n");
    expect((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: secondLane.root })).stdout).toBe("");

    await second.cleanup();
    await artifacts.cleanup();
    await expect(stat(artifacts.root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});
