import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRecentLocalShellJobs, readLocalShellJob, reconcileLocalShellJobs, type LocalShellJobRecord } from "./local-shell-jobs.js";

const tempDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jk-shell-jobs-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJob(stateDir: string, record: LocalShellJobRecord): Promise<void> {
  const dir = path.join(stateDir, "approvals", "shell", "jobs");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${record.id}.json`), `${JSON.stringify(record)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("reconcileLocalShellJobs", () => {
  it("expires pending jobs, fails stale running jobs, and removes old terminal records", async () => {
    const stateDir = await makeStateDir();
    const now = 1_000_000;
    const base = {
      projectId: "p",
      command: "echo ok",
      cwd: null,
      reason: null,
      needsNetwork: false,
      destructive: false,
      timeoutSec: 30,
      writesWorkspace: false,
      createdAt: 100,
      expiresAt: 900_000,
    };
    const pendingId = "a".repeat(64);
    const runningId = "b".repeat(64);
    const oldId = "c".repeat(64);
    const recentId = "d".repeat(64);

    await writeJob(stateDir, { ...base, id: pendingId, status: "pending" });
    await writeJob(stateDir, { ...base, id: runningId, status: "running", startedAt: 800_000, expiresAt: 2_000_000 });
    await writeJob(stateDir, { ...base, id: oldId, status: "succeeded", finishedAt: 100_000, expiresAt: 2_000_000 });
    await writeJob(stateDir, { ...base, id: recentId, status: "succeeded", finishedAt: 990_000, expiresAt: 2_000_000 });

    const result = await reconcileLocalShellJobs(stateDir, { now, retentionMs: 100_000, runningGraceMs: 10_000 });

    expect(result).toEqual({ expired: 1, failed: 1, removed: 1 });
    expect((await readLocalShellJob(stateDir, pendingId))?.status).toBe("expired");
    expect(await readLocalShellJob(stateDir, runningId)).toMatchObject({ status: "failed", finishedAt: 840_000 });
    expect(await readLocalShellJob(stateDir, oldId)).toBeNull();
    expect((await readLocalShellJob(stateDir, recentId))?.status).toBe("succeeded");
  });

  it("does not promote an old reconciled stale failure above genuinely recent jobs", async () => {
    const stateDir = await makeStateDir();
    const now = Date.now();
    const base = {
      projectId: "p",
      command: "echo ok",
      cwd: null,
      reason: null,
      needsNetwork: false,
      destructive: false,
      timeoutSec: 30,
      writesWorkspace: false,
      createdAt: now - 180_000,
      expiresAt: now + 300_000,
    };
    const staleId = "e".repeat(64);
    const recentId = "f".repeat(64);
    await writeJob(stateDir, {
      ...base,
      id: staleId,
      status: "failed",
      startedAt: now - 120_000,
      finishedAt: now,
      error: "Interrupted or stale running job reconciled after timeout",
    });
    await writeJob(stateDir, { ...base, id: recentId, status: "succeeded", finishedAt: now - 10_000 });

    const jobs = await listRecentLocalShellJobs(stateDir, 10);
    expect(jobs.map((job) => job.id).slice(0, 2)).toEqual([recentId, staleId]);
  });
});
