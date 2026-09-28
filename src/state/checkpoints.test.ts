import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointRetention, createCheckpoint, listCheckpoints, pruneCheckpoints, restoreCheckpoint } from "./checkpoints.js";

const execFileAsync = promisify(execFile);
let root: string;

async function git(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root, windowsHide: true });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-checkpoint-"));
  await git(["init"]);
  await git(["config", "user.email", "checkpoint-test@example.invalid"]);
  await git(["config", "user.name", "Checkpoint Test"]);
  await fs.writeFile(path.join(root, "sample.txt"), "before\n", "utf8");
  await git(["add", "sample.txt"]);
  await git(["commit", "-m", "fixture"]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("restoreCheckpoint", () => {
  it("reverse-applies the stored diff through git stdin", async () => {
    await fs.writeFile(path.join(root, "sample.txt"), "after\n", "utf8");
    const checkpoint = await createCheckpoint(root, "fixture", "test");

    expect(checkpoint.diff).toContain("-before");
    expect(checkpoint.diff).toContain("+after");

    const restored = await restoreCheckpoint(root, checkpoint.checkpointId);

    expect(restored.restored).toBe(true);
    expect((await fs.readFile(path.join(root, "sample.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("before\n");
  });
});

describe("checkpoint retention", () => {
  it("prunes the oldest checkpoints beyond the retention limit", async () => {
    const dir = path.join(root, ".jk", "checkpoints");
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(path.join(dir, `cp_100000000000${i}_aaaaaaa${i}.json`), "{}", "utf8");
    }
    expect(await pruneCheckpoints(root, 2)).toBe(3);
    expect((await fs.readdir(dir)).sort()).toEqual(["cp_1000000000003_aaaaaaa3.json", "cp_1000000000004_aaaaaaa4.json"]);
  });

  it("parses JK_CHECKPOINT_RETENTION with a safe default", () => {
    expect(checkpointRetention({})).toBe(200);
    expect(checkpointRetention({ JK_CHECKPOINT_RETENTION: "0" })).toBe(0);
    expect(checkpointRetention({ JK_CHECKPOINT_RETENTION: "junk" })).toBe(200);
  });

  it("lists this project's checkpoints even when other projects have newer ones", async () => {
    const dir = path.join(root, ".jk", "checkpoints");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "cp_1000000000000_mine0000.json"), JSON.stringify({ checkpointId: "cp_1000000000000_mine0000", projectId: "mine", createdAt: 1, reason: "r", diff: "" }));
    for (let i = 0; i < 60; i += 1) {
      const id = `cp_2000000000${String(i).padStart(3, "0")}_other000`;
      await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ checkpointId: id, projectId: "other", createdAt: 2, reason: "r", diff: "" }));
    }
    const listed = await listCheckpoints(root, "mine");
    expect(listed.map((c) => c.checkpointId)).toEqual(["cp_1000000000000_mine0000"]);
  });
});