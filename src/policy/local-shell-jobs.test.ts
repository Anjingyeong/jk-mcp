import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalShellApprovalRecord } from "./local-approvals.js";
import {
  findReusableLocalShellJob,
  listRecentLocalShellJobs,
  localShellRunnerInstanceId,
  queueLocalShellJob,
  readLocalShellJob,
  updateLocalShellJob,
} from "./local-shell-jobs.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jk-shell-job-"));
  tempDirs.push(dir);
  return dir;
}

function approval(idChar = "a"): LocalShellApprovalRecord {
  const now = Date.now();
  return {
    id: idChar.repeat(64),
    projectId: "proj",
    commandPreview: "echo approved",
    cwd: null,
    reason: "restart recovery test",
    taskIdentity: "task:restart-recovery",
    needsNetwork: false,
    destructive: false,
    createdAt: now,
    expiresAt: now + 5 * 60_000,
    status: "approved",
  };
}

const jobInput = {
  command: "echo approved",
  reason: "restart recovery test",
  taskIdentity: "task:restart-recovery",
  needsNetwork: false,
  destructive: false,
  writesWorkspace: false,
};

const fingerprintInput = {
  projectId: "proj",
  ...jobInput,
};

describe("local shell job restart recovery", () => {
  it("reuses the same job when only the human-readable reason changes", async () => {
    const dir = await stateDir();
    const queued = await queueLocalShellJob(dir, approval("d"), jobInput);
    await updateLocalShellJob(dir, queued.id, (current) => ({
      ...current,
      status: "succeeded",
      finishedAt: Date.now(),
      exitCode: 0,
      stdoutSummary: "already-done",
    }));

    const reused = await findReusableLocalShellJob(dir, {
      ...fingerprintInput,
      reason: "same operation, but the assistant phrased the explanation differently",
    });
    expect(reused).toMatchObject({ id: queued.id, status: "succeeded", stdoutSummary: "already-done" });
  });

  it("does not reuse a job when the exact command or risk changes", async () => {
    const dir = await stateDir();
    const queued = await queueLocalShellJob(dir, approval("e"), jobInput);
    await updateLocalShellJob(dir, queued.id, (current) => ({
      ...current,
      status: "succeeded",
      finishedAt: Date.now(),
      exitCode: 0,
    }));

    expect(await findReusableLocalShellJob(dir, { ...fingerprintInput, command: "echo different" })).toBeNull();
    expect(await findReusableLocalShellJob(dir, { ...fingerprintInput, destructive: true })).toBeNull();
  });

  it("persists distinct idempotent jobs for commands consumed from one approved bundle", async () => {
    const dir = await stateDir();
    const bundleApproval = approval("9");
    const authorization = {
      approvalId: bundleApproval.id,
      bundleFingerprint: "8".repeat(64),
      workSessionId: "ws_release_bundle",
    };
    const first = await queueLocalShellJob(dir, bundleApproval, {
      ...jobInput,
      ...authorization,
      command: "echo first",
    });
    const second = await queueLocalShellJob(dir, bundleApproval, {
      ...jobInput,
      ...authorization,
      command: "echo second",
    });
    const repeatedSecond = await queueLocalShellJob(dir, bundleApproval, {
      ...jobInput,
      ...authorization,
      command: "echo second",
    });

    expect(first.id).not.toBe(second.id);
    expect(repeatedSecond.id).toBe(second.id);
    expect(second).toMatchObject(authorization);

    await updateLocalShellJob(dir, second.id, (current) => ({
      ...current,
      status: "succeeded",
      finishedAt: Date.now(),
      exitCode: 0,
      stdoutSummary: "second-ran-once",
    }));
    const reused = await findReusableLocalShellJob(dir, {
      ...fingerprintInput,
      command: "echo second",
      workSessionId: authorization.workSessionId,
    });
    expect(reused).toMatchObject({
      id: second.id,
      status: "succeeded",
      stdoutSummary: "second-ran-once",
      ...authorization,
    });
  });

  it("reuses a pinned command_run when optional policy hints change", async () => {
    const dir = await stateDir();
    const command = 'command_run {"commandId":"npm:deploy","args":[],"manifestFingerprint":"abc"}';
    const queued = await queueLocalShellJob(dir, approval("f"), {
      ...jobInput,
      executionKind: "command-run",
      command,
      needsNetwork: true,
      writesWorkspace: true,
    });
    await updateLocalShellJob(dir, queued.id, (current) => ({
      ...current,
      status: "succeeded",
      finishedAt: Date.now(),
      exitCode: 0,
      stdoutSummary: "deployed-once",
    }));

    const reused = await findReusableLocalShellJob(dir, {
      projectId: "proj",
      executionKind: "command-run",
      command,
      reason: "same pinned command lookup",
      taskIdentity: jobInput.taskIdentity,
      needsNetwork: false,
      destructive: true,
      writesWorkspace: false,
    });
    expect(reused).toMatchObject({ id: queued.id, status: "succeeded", stdoutSummary: "deployed-once" });
  });

  it("turns a running job from a previous JK process into a terminal unknown-outcome failure", async () => {
    const dir = await stateDir();
    const queued = await queueLocalShellJob(dir, approval(), jobInput);
    await updateLocalShellJob(dir, queued.id, (current) => ({
      ...current,
      status: "running",
      runnerInstanceId: "previous-runtime-instance",
      startedAt: Date.now() - 1_000,
    }));

    const reused = await findReusableLocalShellJob(dir, fingerprintInput);
    expect(reused).toMatchObject({
      id: queued.id,
      status: "failed",
      interruptedByRestart: true,
    });
    expect(reused?.error).toContain("execution outcome is unknown");

    const persisted = await readLocalShellJob(dir, queued.id);
    expect(persisted).toMatchObject({ status: "failed", interruptedByRestart: true });
    expect(persisted?.finishedAt).toEqual(expect.any(Number));
  });

  it("keeps a running job owned by the current JK process running", async () => {
    const dir = await stateDir();
    const queued = await queueLocalShellJob(dir, approval("b"), jobInput);
    await updateLocalShellJob(dir, queued.id, (current) => ({
      ...current,
      status: "running",
      runnerInstanceId: localShellRunnerInstanceId(),
      startedAt: Date.now(),
    }));

    const reused = await findReusableLocalShellJob(dir, fingerprintInput);
    expect(reused).toMatchObject({ id: queued.id, status: "running" });
    expect(reused?.interruptedByRestart).not.toBe(true);
  });

  it("reconciles orphaned running jobs in recent-job listings without exposing the runner id", async () => {
    const dir = await stateDir();
    const queued = await queueLocalShellJob(dir, approval("c"), jobInput);
    await updateLocalShellJob(dir, queued.id, (current) => ({
      ...current,
      status: "running",
      runnerInstanceId: "old-runtime",
      startedAt: Date.now() - 1_000,
    }));

    const recent = await listRecentLocalShellJobs(dir, 10);
    expect(recent[0]).toMatchObject({
      id: queued.id,
      status: "failed",
      interruptedByRestart: true,
    });
    expect(recent[0]).not.toHaveProperty("runnerInstanceId");
  });
});
