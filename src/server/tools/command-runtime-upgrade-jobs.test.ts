import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError, ErrorCode, type ProjectRegistryEntry, type ToolContext } from "../../types.js";
import * as localShell from "../../exec/local-shell.js";
import * as git from "../../git/git.js";
import * as broker from "../../executors/broker.js";
import * as shared from "./shared.js";
import { registerCommandTools } from "./command.js";
import type { RegisterTool } from "./register.js";
import { consumeLocalShellApprovalGrant, listPendingLocalShellApprovals, requestLocalShellApproval, resolveLocalShellApproval } from "../../policy/local-approvals.js";
import { listRecentLocalShellJobs, readLocalShellJob, updateLocalShellJob } from "../../policy/local-shell-jobs.js";
import type { ExecutionTarget } from "../../executors/target-protocol.js";

const dirs: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(kind: "oci" | "windows") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jk-runtime-reuse-"));
  dirs.push(dir);
  const root = path.join(dir, "source");
  const stateDir = path.join(dir, "state");
  for (const rel of ["src/server/tools.ts", "scripts/reload-jk-runtime.sh", "scripts/reload-jk-runtime.ps1"]) {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "// fixture only; never executed\n");
  }
  Object.defineProperty(process, "platform", { ...originalPlatform, value: kind === "oci" ? "linux" : "win32" });
  const projectId = kind === "oci" ? "chatgpt2codex" : "windows-main::chatgpt2codex";
  const target: ExecutionTarget = {
    kind: kind === "oci" ? "local" : "remote", protocolVersion: 1,
    executorId: kind === "oci" ? "local" : "windows-main", instanceId: "instance-a",
    workspaceRoot: kind === "oci" ? dir : "C:\\JK", projectId, sourceProjectId: "chatgpt2codex",
    projectRoot: kind === "oci" ? root : "C:\\JK\\chatgpt2codex",
  };
  const entry: ProjectRegistryEntry = {
    projectId, name: projectId, root, aliases: [], executionTarget: target,
    ...(kind === "windows" ? { executorKind: "remote", executorId: target.executorId, sourceProjectId: target.sourceProjectId } : {}),
  };
  const session = shared.emptySession();
  const ctx: ToolContext = {
    workspaceRoot: dir, stateDir, registry: [entry], ledger: { append: vi.fn(async () => undefined) },
    store: { loadProjects: async () => [entry], saveProjects: async () => undefined,
      getSession: async () => session, setSession: async () => undefined },
    config: { workspaceRoot: dir, stateDir, maxReadBytes: 1024 * 1024, maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30, defaultLeaseTtlMs: 30 * 60_000 },
  };
  let commit = "a".repeat(40);
  let manifest = JSON.stringify({ sourceFingerprint: "b".repeat(64), buildFingerprint: "c".repeat(64) });
  const repoStatus = () => ({ branch: "main", headCommit: commit, dirtyFiles: [], staged: [],
    remotes: [], upstream: "origin/main", ahead: 0, behind: 0, syncState: "up-to-date" as const });
  vi.spyOn(git, "gitRepositoryStatus").mockImplementation(async () => repoStatus());
  vi.spyOn(shared, "requireProjectLease").mockResolvedValue(undefined);
  vi.spyOn(shared, "resolveOrThrow").mockImplementation(async () => entry);
  vi.spyOn(shared, "localExecutionRoot").mockResolvedValue(root);
  const result = { cwd: root, exitCode: 0, stdoutSummary: "JK_RUNTIME_SWAP_QUEUED", stderrSummary: "", durationMs: 5, outputTruncated: false };
  const reload = vi.fn(async () => result);
  vi.spyOn(localShell, "runLocalShell").mockImplementation(reload);
  const proof = vi.spyOn(shared, "waitForExecutorReconnectCompletion").mockResolvedValue(undefined);
  let heartbeat = 0;
  vi.spyOn(broker, "listExecutorStatus").mockImplementation(async () => [{ executorId: target.executorId,
    platform: "win32/x64", online: true, instanceId: target.instanceId,
    capabilities: ["repo_status", "git_sync_start"], lastSeenAtMs: ++heartbeat } as Awaited<ReturnType<typeof broker.listExecutorStatus>>[number]]);
  vi.spyOn(broker, "dispatchExecutorJob").mockImplementation(async (_stateDir, _executorId, tool, payload) => {
    if (tool === "repo_status") return repoStatus();
    if (tool === "file_read_slice") return { content: payload?.path === "dist/runtime-schema-manifest.json" ? manifest : "// fixture\n" };
    if (tool === "local_shell_run") return reload();
    throw new Error(`Unexpected executor tool: ${tool}`);
  });
  const handlers = new Map<string, (input: { projectId: string; workSessionId?: string }) => Promise<{ structuredContent?: Record<string, unknown> }>>();
  const register = ((name: string, _config: unknown, handler: unknown) => {
    handlers.set(name, handler as (input: { projectId: string; workSessionId?: string }) => Promise<{ structuredContent?: Record<string, unknown> }>);
  }) as unknown as RegisterTool;
  registerCommandTools(register, ctx);
  const upgrade = async (workSessionId?: string) => (await handlers.get("runtime_upgrade")!({ projectId, workSessionId })).structuredContent!;
  const approveRelease = async () => {
    const input = { projectId: "chatgpt2codex", command: "bash scripts/reload-jk-runtime.sh", needsNetwork: false, destructive: true,
      scope: { key: `maintenance:jk:release:${commit}`, label: "JK Release", ttlMs: 15 * 60_000 } };
    const pending = await requestLocalShellApproval(stateDir, input);
    await resolveLocalShellApproval(stateDir, pending.id, "approve");
    // Consume the exact OCI token as the first approved release would do.
    expect((await consumeLocalShellApprovalGrant(stateDir, input))?.source).toBe("exact");
  };
  const setManifest = async () => {
    manifest = JSON.stringify({ sourceFingerprint: "d".repeat(64), buildFingerprint: "e".repeat(64) });
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist/runtime-schema-manifest.json"), manifest);
  };
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist/runtime-schema-manifest.json"), manifest);
  await approveRelease();
  return { ctx, stateDir, target, upgrade, reload, proof, result, approveRelease, setManifest,
    setCommit(value: string) { commit = value; },
    registerAgain() { registerCommandTools(register, ctx); } };
}

describe.each(["oci", "windows"] as const)("%s scope-reused runtime_upgrade durable jobs", (kind) => {
  it("executes once and reuses the durable success across reconnect, handler replacement and work sessions", async () => {
    const f = await fixture(kind);
    const first = await f.upgrade("ws_first");
    expect(first).toMatchObject({ exitCode: 0, approvalReused: "maintenance-scope", jobId: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(await readLocalShellJob(f.stateDir, String(first.jobId))).toMatchObject({
      status: "succeeded", releaseCommit: "a".repeat(40), exitCode: 0, stdoutSummary: f.result.stdoutSummary,
      startedAt: expect.any(Number), finishedAt: expect.any(Number),
      completionProof: kind === "windows" ? expect.objectContaining({ kind: "executor-reconnect", previousInstanceId: "instance-a", requiredHeartbeats: 3 }) : null,
    });
    const second = await f.upgrade("ws_first");
    expect(second).toMatchObject({ jobId: first.jobId, reusedJob: true, exitCode: 0, stdoutSummary: first.stdoutSummary });
    f.target.instanceId = "instance-b";
    await updateLocalShellJob(f.stateDir, String(first.jobId), (job) => ({ ...job, runnerInstanceId: "previous-hub" }));
    f.registerAgain();
    expect(await f.upgrade("ws_other")).toMatchObject({ jobId: first.jobId, reusedJob: true });
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.proof).toHaveBeenCalledTimes(1);
    expect(await listPendingLocalShellApprovals(f.stateDir)).toHaveLength(0);
  });

  it("serializes simultaneous requests and returns running without another reload", async () => {
    const f = await fixture(kind);
    const entered = deferred();
    const finish = deferred();
    f.reload.mockImplementation(async () => { entered.resolve(); await finish.promise; return f.result; });
    const calls = [f.upgrade(), f.upgrade()];
    await entered.promise;
    const running = await Promise.race(calls);
    expect(running).toMatchObject({ status: "running", reusedJob: true });
    expect(await f.upgrade()).toMatchObject({ status: "running", reusedJob: true, jobId: running.jobId });
    expect(f.reload).toHaveBeenCalledTimes(1);
    finish.resolve();
    await Promise.all(calls);
    expect(await f.upgrade()).toMatchObject({ jobId: running.jobId, reusedJob: true, exitCode: 0 });
  });

  it("executes a changed manifest and a separately approved commit while retaining earlier results", async () => {
    const f = await fixture(kind);
    const first = await f.upgrade();
    await f.setManifest();
    const build = await f.upgrade();
    expect(build).toMatchObject({ exitCode: 0, approvalReused: "maintenance-scope" });
    expect(build.jobId).not.toBe(first.jobId);
    f.setCommit("f".repeat(40));
    await f.approveRelease();
    const release = await f.upgrade();
    expect(release).toMatchObject({ exitCode: 0, approvalReused: "maintenance-scope" });
    expect(release.jobId).not.toBe(build.jobId);
    expect(f.reload).toHaveBeenCalledTimes(3);
    expect(await readLocalShellJob(f.stateDir, String(first.jobId))).toMatchObject({ status: "succeeded", releaseCommit: "a".repeat(40) });
    expect(await readLocalShellJob(f.stateDir, String(release.jobId))).toMatchObject({ status: "succeeded", releaseCommit: "f".repeat(40) });
  });

  it("does not use the previous commit's release approval for a new commit", async () => {
    const f = await fixture(kind);
    await f.upgrade();
    f.setCommit("f".repeat(40));
    expect(await f.upgrade()).toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it("executes separately for another target root", async () => {
    const f = await fixture(kind);
    const first = await f.upgrade();
    f.target.projectRoot = kind === "oci" ? path.join(f.ctx.workspaceRoot, "other") : "C:\\JK\\other";
    const other = await f.upgrade();
    expect(other).toMatchObject({ exitCode: 0, approvalReused: "maintenance-scope" });
    expect(other.jobId).not.toBe(first.jobId);
    expect(f.reload).toHaveBeenCalledTimes(2);
  });

  it("reuses success after scope expiry without creating authority for another build", async () => {
    const f = await fixture(kind);
    const first = await f.upgrade();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
    expect(await f.upgrade()).toMatchObject({ jobId: first.jobId, reusedJob: true });
    await f.setManifest();
    expect(await f.upgrade()).toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it("does not rerun an interrupted job owned by a replaced hub instance", async () => {
    const f = await fixture(kind);
    const first = await f.upgrade();
    await updateLocalShellJob(f.stateDir, String(first.jobId), (job) => ({ ...job, status: "running", runnerInstanceId: "previous-hub" }));
    expect(await f.upgrade()).toMatchObject({ code: "COMMAND_FAILED", jobId: first.jobId });
    expect(await readLocalShellJob(f.stateDir, String(first.jobId))).toMatchObject({ status: "failed", interruptedByRestart: true });
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing failed-job retention window and records a later scoped retry separately", async () => {
    const f = await fixture(kind);
    f.reload.mockRejectedValueOnce(new Error("temporary reload failure"));
    await f.upgrade();
    const [failed] = await listRecentLocalShellJobs(f.stateDir);
    expect(await f.upgrade()).toMatchObject({ code: "COMMAND_FAILED", jobId: failed.id });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    const retry = await f.upgrade();
    expect(retry).toMatchObject({ exitCode: 0, approvalReused: "maintenance-scope" });
    expect(retry.jobId).not.toBe(failed.id);
    expect(f.reload).toHaveBeenCalledTimes(2);
    expect(await readLocalShellJob(f.stateDir, failed.id)).toMatchObject({ status: "failed" });
  });

  it("requires fresh approval when the release scope expires and there is no successful result", async () => {
    const f = await fixture(kind);
    const scopeDir = path.join(f.stateDir, "approvals", "shell", "scopes");
    for (const file of await fs.readdir(scopeDir)) {
      const target = path.join(scopeDir, file);
      const scope = JSON.parse(await fs.readFile(target, "utf8"));
      await fs.writeFile(target, JSON.stringify({ ...scope, expiresAt: scope.createdAt + 1 }));
    }
    expect(await f.upgrade()).toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(f.reload).not.toHaveBeenCalled();
    expect(await listRecentLocalShellJobs(f.stateDir)).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it.each(["exit", "throw", "proof"] as const)("persists %s failure and does not replay it", async (failure) => {
    const f = await fixture(kind);
    if (failure === "exit") f.reload.mockResolvedValue({ ...f.result, exitCode: 7, stderrSummary: "reload failed" });
    if (failure === "throw") f.reload.mockRejectedValue(new Error("executor disconnected"));
    if (failure === "proof") f.proof.mockRejectedValue(new DomainError(ErrorCode.COMMAND_FAILED, "replacement never stabilized"));
    const first = await f.upgrade();
    expect(first.exitCode).not.toBe(0);
    const [job] = await listRecentLocalShellJobs(f.stateDir);
    expect(job).toMatchObject({ status: "failed", error: expect.any(String), finishedAt: expect.any(Number) });
    if (failure !== "throw") expect(job).toMatchObject({ exitCode: failure === "exit" ? 7 : 0, stdoutSummary: f.result.stdoutSummary });
    expect(await f.upgrade()).toMatchObject({ code: "COMMAND_FAILED", jobId: job.id });
    expect(f.reload).toHaveBeenCalledTimes(1);
  });
});

it("keeps the Windows job running until the real reconnect proof observes three replacement heartbeats", async () => {
  const f = await fixture("windows");
  f.proof.mockRestore();
  const entered = deferred();
  const finish = deferred();
  f.reload.mockImplementation(async () => { entered.resolve(); await finish.promise; return f.result; });
  const running = f.upgrade();
  await entered.promise;
  expect((await listRecentLocalShellJobs(f.stateDir))[0]).toMatchObject({ status: "running" });
  f.target.instanceId = "instance-b";
  finish.resolve();
  expect(await running).toMatchObject({ exitCode: 0 });
  expect((await listRecentLocalShellJobs(f.stateDir))[0]).toMatchObject({ status: "succeeded", completionProof: { previousInstanceId: "instance-a" } });
});
