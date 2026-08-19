import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpoint, restoreCheckpoint } from "./checkpoints.js";

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