import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalShellApprovalRecord } from "./local-approvals.js";
import { taskApprovalIdentity } from "./local-approvals.js";
import { deriveLocalExecutionTarget, type ExecutionTarget } from "../executors/target-protocol.js";
import {
  findReusableLocalShellJob,
  listRecentLocalShellJobs,
  localShellRunnerInstanceId,
  quarantineInvalidLocalShellJob,
  queueLocalShellJob,
  readLocalShellJob,
  targetApprovalIdentity,
  updateLocalShellJob,
} from "./local-shell-jobs.js";

const tempDirs: string[] = [];

// The OCI persisted identity contract, independent of the production fingerprint.
function maintenanceIdentity(target: ExecutionTarget, owner?: string): string {
  const { instanceId: _instanceId, ...stable } = target;
  return `target:${createHash("sha256").update(JSON.stringify([stable, owner ?? null])).digest("hex")}`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  }));
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

describe("native-evolution R9 durable job records", () => {
  it("does not re-read a large unchanged job history on repeated recent-list calls", async () => {
    const dir = await stateDir();
    const queued = await queueLocalShellJob(dir, approval(), jobInput);
    const jobsDir = path.join(dir, "approvals", "shell", "jobs");
    const sample = JSON.parse(await readFile(path.join(jobsDir, `${queued.id}.json`), "utf8"));
    const now = Date.now();
    await Promise.all(Array.from({ length: 1500 }, (_, index) => {
      const id = index.toString(16).padStart(64, "0");
      const record = { ...sample, id, approvalId: id, createdAt: now - index, expiresAt: now + 5 * 60_000 };
      return writeFile(path.join(jobsDir, `${id}.json`), `${JSON.stringify(record)}\n`);
    }));

    const readSpy = vi.spyOn(fsPromises, "readFile");
    const first = await listRecentLocalShellJobs(dir, 20);
    const readsAfterFirst = readSpy.mock.calls.length;
    const second = await listRecentLocalShellJobs(dir, 20);
    const readsAfterSecond = readSpy.mock.calls.length;
    readSpy.mockRestore();

    expect(first).toHaveLength(20);
    expect(second).toHaveLength(20);
    expect(readsAfterFirst).toBeGreaterThanOrEqual(1500);
    expect(readsAfterSecond).toBe(readsAfterFirst);
  });

  const invalidRecords = [
    { label: "truncated JSON", bytes: '{"id":' },
    { label: "malformed JSON", bytes: '{not-json}' },
    { label: "null", bytes: 'null' },
    { label: "array", bytes: '[]' },
    { label: "wrong identity", fields: { id: "b".repeat(64) } },
    ...[
      ["projectId", ""], ["command", null], ["cwd", 12], ["reason", false],
      ["needsNetwork", "false"], ["destructive", null], ["writesWorkspace", 1],
      ["timeoutSec", "30"], ["createdAt", null], ["expiresAt", "never"], ["status", "done"],
      ["executionTarget", {}], ["executionKind", "unknown"], ["args", [1]],
      ["taskIdentity", 12], ["workSessionId", []], ["continuation", { goalId: 12 }],
      ["completionProof", { kind: "unknown" }], ["finishedAt", "today"],
    ].map(([field, value]) => ({ label: `invalid ${field}`, fields: { [String(field)]: value } })),
    { label: "missing required fields", bytes: JSON.stringify({ id: "a".repeat(64) }) },
  ];

  it.each(invalidRecords)("rejects $label before direct read/queue/update can replace bytes", async (invalid) => {
    const dir = await stateDir();
    const authorization = approval();
    const queued = await queueLocalShellJob(dir, authorization, jobInput);
    const target = path.join(dir, "approvals", "shell", "jobs", `${queued.id}.json`);
    const bytes = "bytes" in invalid ? invalid.bytes : JSON.stringify({ ...queued, ...invalid.fields });
    await writeFile(target, bytes);
    const before = await readdir(path.dirname(target));
    let updates = 0;
    for (const action of [
      () => readLocalShellJob(dir, queued.id),
      () => queueLocalShellJob(dir, authorization, { ...jobInput, continuation: { workSessionId: "ws", goalId: "g", loopId: "l" } }),
      () => updateLocalShellJob(dir, queued.id, (current) => { updates++; return current; }),
    ]) {
      try {
        await expect(action()).rejects.toMatchObject({ name: "LocalShellJobReadError", reason: "invalid-record", jobId: queued.id });
      } finally {
        expect(await readFile(target, "utf8")).toBe(bytes);
        expect(await readdir(path.dirname(target))).toEqual(before);
        expect(updates).toBe(0);
      }
    }
  });

  it.each([
    { label: "reuse lookup", action: (dir: string) => findReusableLocalShellJob(dir, fingerprintInput), expected: null },
    { label: "recent-job listing", action: (dir: string) => listRecentLocalShellJobs(dir), expected: [] },
  ])("quarantines a malformed record during $label and continues", async ({ action, expected }) => {
    const dir = await stateDir();
    const authorization = approval();
    const queued = await queueLocalShellJob(dir, authorization, jobInput);
    const jobs = path.join(dir, "approvals", "shell", "jobs");
    const target = path.join(jobs, `${queued.id}.json`);
    const bytes = "{broken";
    await writeFile(target, bytes);

    expect(await action(dir)).toEqual(expected);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantinedFiles = await readdir(path.join(jobs, "invalid"));
    const quarantined = quarantinedFiles.find((file) => file.startsWith(`${queued.id}.`));
    expect(quarantined).toBeTruthy();
    expect(await readFile(path.join(jobs, "invalid", quarantined!), "utf8")).toBe(bytes);
  });

  it("rejects an unreadable job path without replacing its contents", async () => {
    const dir = await stateDir();
    const authorization = approval();
    const target = path.join(dir, "approvals", "shell", "jobs", `${authorization.id}.json`);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "owned-sentinel"), "preserve");
    for (const action of [
      () => readLocalShellJob(dir, authorization.id),
      () => queueLocalShellJob(dir, authorization, jobInput),
      () => findReusableLocalShellJob(dir, fingerprintInput),
    ]) {
      await expect(action()).rejects.toMatchObject({ name: "LocalShellJobReadError", reason: "unreadable", jobId: authorization.id });
      expect(await readFile(path.join(target, "owned-sentinel"), "utf8")).toBe("preserve");
    }
  });

  it("rejects an unreadable jobs directory rather than reporting no reusable jobs", async () => {
    const dir = await stateDir();
    const shell = path.join(dir, "approvals", "shell");
    await mkdir(shell, { recursive: true });
    await writeFile(path.join(shell, "jobs"), "owned-directory-obstruction");
    for (const action of [() => findReusableLocalShellJob(dir, fingerprintInput), () => listRecentLocalShellJobs(dir)]) {
      await expect(action()).rejects.toMatchObject({ name: "LocalShellJobReadError", reason: "unreadable", jobId: null });
      expect(await readFile(path.join(shell, "jobs"), "utf8")).toBe("owned-directory-obstruction");
    }
  });

  it("rejects invalid lookup identities rather than treating them as absence", async () => {
    const dir = await stateDir();
    await expect(readLocalShellJob(dir, "../foreign")).rejects.toMatchObject({
      name: "LocalShellJobReadError", reason: "invalid-id", jobId: "../foreign",
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it("quarantines only a proven invalid record so the same approval identity can be recreated", async () => {
    const dir = await stateDir();
    const authorization = approval();
    const queued = await queueLocalShellJob(dir, authorization, jobInput);
    const target = path.join(dir, "approvals", "shell", "jobs", `${queued.id}.json`);
    const bytes = "{broken";
    await writeFile(target, bytes);
    let readError: unknown;
    try {
      await readLocalShellJob(dir, queued.id);
    } catch (error) {
      readError = error;
    }
    expect(readError).toMatchObject({ name: "LocalShellJobReadError", reason: "invalid-record", jobId: queued.id });
    const quarantined = await quarantineInvalidLocalShellJob(dir, readError as import("./local-shell-jobs.js").LocalShellJobReadError);
    expect(quarantined).toContain(path.join("jobs", "invalid", `${queued.id}.`));
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(quarantined!, "utf8")).toBe(bytes);
    expect(await queueLocalShellJob(dir, authorization, jobInput)).toMatchObject({ id: queued.id, status: "pending" });
  });

  it("treats only ENOENT as absence and permits initial queue creation", async () => {
    const dir = await stateDir();
    expect(await readLocalShellJob(dir, approval().id)).toBeNull();
    expect(await findReusableLocalShellJob(dir, fingerprintInput)).toBeNull();
    expect(await listRecentLocalShellJobs(dir)).toEqual([]);
    const queued = await queueLocalShellJob(dir, approval(), jobInput);
    expect(await readLocalShellJob(dir, queued.id)).toEqual(queued);
  });

  it("preserves valid legacy records with omitted optional fields and opaque fingerprints", async () => {
    const dir = await stateDir();
    const legacy = {
      id: approval().id, projectId: "proj", command: jobInput.command, cwd: null, reason: null,
      needsNetwork: false, destructive: false, writesWorkspace: false, timeoutSec: null,
      createdAt: 1, expiresAt: 2, status: "succeeded", fingerprint: "historical-opaque-value",
      finishedAt: 3, stdoutSummary: "retained-result", legacyMetadata: { retained: true },
    };
    const target = path.join(dir, "approvals", "shell", "jobs", `${legacy.id}.json`);
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = JSON.stringify(legacy);
    await writeFile(target, bytes);
    expect(await readLocalShellJob(dir, legacy.id)).toEqual(legacy);
    expect(await queueLocalShellJob(dir, approval(), { ...jobInput, taskIdentity: undefined })).toEqual(legacy);
    expect(await readFile(target, "utf8")).toBe(bytes);
  });

  it("reads legacy expired jobs without reusing them", async () => {
    const dir = await stateDir();
    const legacy = {
      id: approval().id, projectId: "proj", command: jobInput.command, cwd: null, reason: null,
      needsNetwork: false, destructive: false, writesWorkspace: false, timeoutSec: null,
      createdAt: 1, expiresAt: 2, status: "expired", fingerprint: "historical-expired-value",
      finishedAt: 3,
    } as const;
    const target = path.join(dir, "approvals", "shell", "jobs", `${legacy.id}.json`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(legacy));

    expect(await readLocalShellJob(dir, legacy.id)).toEqual(legacy);
    expect(await findReusableLocalShellJob(dir, fingerprintInput, 10)).toBeNull();
    expect(await listRecentLocalShellJobs(dir)).toEqual([
      expect.objectContaining({ id: legacy.id, status: "expired" }),
    ]);
  });
});

describe("local shell job restart recovery", () => {
  it.each((["local-shell", "command-run"] as const).flatMap((executionKind) =>
    (["pending", "running", "succeeded", "failed"] as const).map((status) => ({ executionKind, status })),
  ))("does not reuse a job across goals sharing a work session ($executionKind/$status)", async ({ executionKind, status }) => {
    const dir = await stateDir();
    const input = { ...jobInput, executionKind, taskIdentity: "goal:A", workSessionId: "ws_same" };
    const queued = await queueLocalShellJob(dir, approval(), input);
    await updateLocalShellJob(dir, queued.id, (current) => ({
      ...current, status, runnerInstanceId: localShellRunnerInstanceId(), finishedAt: Date.now(),
    }));
    expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input })).toMatchObject({ id: queued.id, status });
    expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input, taskIdentity: "goal:B" })).toBeNull();
  });

  it("reuses same-goal jobs after lease renewal but not session change", async () => {
    const dir = await stateDir();
    const owner = { goalId: "A", workSessionId: "ws_same" };
    const input = { ...jobInput, workSessionId: owner.workSessionId,
      taskIdentity: taskApprovalIdentity({ ...owner, leaseId: "old" }) };
    const queued = await queueLocalShellJob(dir, approval(), input);
    await updateLocalShellJob(dir, queued.id, (current) => ({ ...current, status: "succeeded", finishedAt: Date.now() }));
    expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input,
      taskIdentity: taskApprovalIdentity({ ...owner, leaseId: "new" }), reason: "changed wording" })).toMatchObject({ id: queued.id });
    expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input, workSessionId: "ws_other" })).toBeNull();
  });

  it("rejects ambiguous legacy job ownership", async () => {
    const dir = await stateDir();
    const input = { ...jobInput, taskIdentity: undefined, workSessionId: "ws_same" };
    const queued = await queueLocalShellJob(dir, approval(), input);
    await updateLocalShellJob(dir, queued.id, (current) => ({ ...current, status: "succeeded", finishedAt: Date.now() }));
    expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input, taskIdentity: "goal:A" })).toBeNull();
    expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input })).toBeNull();
  });

  it.each(["stable", "legacy"] as const)("reuses a provably owned maintenance result across executor replacement (%s)", async (format) => {
    const dir = await stateDir();
    const executionTarget = await deriveLocalExecutionTarget(dir, { projectId: "proj", root: dir });
    const continuation = { goalId: "A", loopId: "loop-A", workSessionId: "ws_same" };
    const owner = taskApprovalIdentity(continuation);
    const completionProof = { kind: "executor-reconnect" as const, executorId: "worker",
      previousInstanceId: executionTarget.instanceId, requiredHeartbeats: 2, timeoutMs: 1000, requiredCapabilities: ["command_run"] };
    const input = { ...jobInput, executionTarget, completionProof, continuation, manifestFingerprint: "build-a",
      workSessionId: "ws_same", taskIdentity: (format === "legacy" ? targetApprovalIdentity : maintenanceIdentity)(executionTarget, owner) };
    const queued = await queueLocalShellJob(dir, approval(), input);
    await updateLocalShellJob(dir, queued.id, (current) => ({ ...current, status: "succeeded", finishedAt: Date.now(), fingerprint: "historical-opaque-value" }));
    const replacement = { ...executionTarget, instanceId: "replacement" };
    const replay = { projectId: "proj", ...input, executionTarget: replacement,
      taskIdentity: maintenanceIdentity(replacement, owner),
      completionProof: { ...completionProof, previousInstanceId: replacement.instanceId } };
    expect(await findReusableLocalShellJob(dir, replay)).toMatchObject({ id: queued.id, status: "succeeded" });
    expect(await queueLocalShellJob(dir, approval(), { ...replay, continuation })).toMatchObject({ id: queued.id, status: "succeeded" });
    expect(await findReusableLocalShellJob(dir, { ...replay, manifestFingerprint: "build-b" })).toBeNull();
    expect(await findReusableLocalShellJob(dir, { ...replay, taskIdentity: maintenanceIdentity(replacement, "goal:B") })).toBeNull();
    for (const changed of [{ executorId: "other" }, { requiredHeartbeats: 3 }, { timeoutMs: 2000 }, { requiredCapabilities: ["local_shell_run"] }]) {
      expect(await findReusableLocalShellJob(dir, { ...replay, completionProof: { ...replay.completionProof, ...changed } })).toBeNull();
    }
    for (const changed of [{ kind: "remote" as const }, { executorId: "other" }, { workspaceRoot: path.dirname(dir) },
      { projectRoot: path.dirname(dir) }, { projectId: "other" }, { sourceProjectId: "other" }]) {
      expect(await findReusableLocalShellJob(dir, { ...replay, executionTarget: { ...replacement, ...changed } })).toBeNull();
    }
    await updateLocalShellJob(dir, queued.id, (current) => ({ ...current,
      taskIdentity: targetApprovalIdentity(executionTarget, owner), continuation: null }));
    expect(await findReusableLocalShellJob(dir, replay)).toBeNull();
  });

  it.each(["local-shell", "command-run"] as const)("pins every target field in %s job reuse", async (executionKind) => {
    const dir = await stateDir();
    const executionTarget = await deriveLocalExecutionTarget(dir, { projectId: "proj", root: dir });
    const input = { ...jobInput, executionKind, executionTarget, workSessionId: "ws_same" };
    const queued = await queueLocalShellJob(dir, approval("6"), input);
    expect(await readLocalShellJob(dir, queued.id)).toMatchObject({ executionTarget });
    expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input })).toMatchObject({ id: queued.id });
    for (const changed of [
      { kind: "remote" as const }, { executorId: "worker" }, { instanceId: "replacement" },
      { workspaceRoot: path.dirname(dir) }, { projectRoot: path.dirname(dir) },
      { projectId: "other-route" }, { sourceProjectId: "other-source" },
    ]) {
      expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input,
        executionTarget: { ...executionTarget, ...changed } })).toBeNull();
    }
    expect(await findReusableLocalShellJob(dir, { projectId: "proj", ...input, executionTarget: undefined })).toBeNull();
  });

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

  it("does not reuse a succeeded local-shell job across built runtime identities", async () => {
    const dir = await stateDir();
    const queued = await queueLocalShellJob(dir, approval("7"), {
      ...jobInput,
      manifestFingerprint: "build-a",
    });
    await updateLocalShellJob(dir, queued.id, (current) => ({
      ...current,
      status: "succeeded",
      finishedAt: Date.now(),
      exitCode: 0,
    }));

    expect(await findReusableLocalShellJob(dir, {
      ...fingerprintInput,
      manifestFingerprint: "build-a",
    })).toMatchObject({ id: queued.id, status: "succeeded" });
    expect(await findReusableLocalShellJob(dir, {
      ...fingerprintInput,
      manifestFingerprint: "build-b",
    })).toBeNull();
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
