import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeExecutorJob, dispatchExecutorJob, getExecutorProjectRegistry, listExecutorStatus,
  pollExecutorJob, recordExecutorHeartbeat, resolveRoutedLocalProject, setProjectExecutorRoute,
  type ExecutorHeartbeat,
} from "./broker.js";
import {
  createRuntimeIdentity, deriveLocalExecutionTarget, deriveRemoteExecutionTarget,
  sameExecutionTarget, type RuntimeIdentity,
} from "./target-protocol.js";

describe("executor target guards", () => {
  let stateDir: string;
  let identity: RuntimeIdentity;
  let heartbeat: ExecutorHeartbeat;
  const project = { projectId: "fixture", name: "fixture", root: "C:/remote/fixture", aliases: ["logical"] };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "jk-target-guards-"));
    identity = await createRuntimeIdentity("worker", stateDir, "worker", ["file_create", "executor_restart"], "instance-1");
    heartbeat = { ...identity, platform: "win32/x64", projects: [{ ...project }] };
    await recordExecutorHeartbeat(stateDir, heartbeat);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(stateDir, { recursive: true, force: true });
  });

  function observeEnqueue() {
    const schedule = globalThis.setTimeout;
    return new Promise<void>((resolve) => {
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce((callback, delay, ...args) => {
        const timer = schedule(callback, delay, ...args);
        spy.mockRestore();
        resolve();
        return timer;
      });
    });
  }

  async function enqueue() {
    const enqueued = observeEnqueue();
    const result = dispatchExecutorJob(stateDir, "worker", "file_create", {
      sourceProjectId: project.projectId, path: "new.txt", executionTarget: deriveRemoteExecutionTarget(identity, project),
    });
    await enqueued;
    return { result };
  }

  it.each([undefined, 0, 2])("rejects heartbeat protocol %s without registering it", async (protocolVersion) => {
    const invalid = { ...heartbeat, executorId: "old-worker", protocolVersion };
    await expect(recordExecutorHeartbeat(stateDir, invalid as ExecutorHeartbeat)).rejects.toMatchObject({ name: "DomainError" });
    expect((await listExecutorStatus(stateDir)).map((item) => item.executorId)).toEqual(["worker"]);
  });

  it("requires capability negotiation rather than OS equality", async () => {
    await expect(recordExecutorHeartbeat(stateDir, { ...heartbeat, os: "darwin", arch: "arm64" })).resolves.toMatchObject({ online: true });
    await expect(recordExecutorHeartbeat(stateDir, { ...heartbeat, capabilities: ["file_create"] })).rejects.toMatchObject({ name: "DomainError" });
    await expect(dispatchExecutorJob(stateDir, "worker", "code_search", { sourceProjectId: "fixture" })).rejects.toMatchObject({ name: "DomainError" });
  });

  it.each(["missing-worker", "missing-project", "missing-protocol", "wrong-protocol"])("refuses configured %s rather than returning local", async (change) => {
    await setProjectExecutorRoute(stateDir, "logical", "worker");
    const file = path.join(stateDir, "executors.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    if (change === "missing-worker") delete state.executors.worker;
    if (change === "missing-project") state.executors.worker.projects = [];
    if (change === "missing-protocol") delete state.executors.worker.protocolVersion;
    if (change === "wrong-protocol") state.executors.worker.protocolVersion = 99;
    await writeFile(file, JSON.stringify(state));
    await expect(resolveRoutedLocalProject(stateDir, { ...project, projectId: "logical", root: stateDir }, stateDir))
      .rejects.toMatchObject({ name: "DomainError", details: { executorId: "worker", projectId: "logical" } });
  });

  it.each(["{", '{"version":1,"updatedAt":1,"executors":{},"routes":[]}', '{"version":1,"updatedAt":1,"executors":{}}'])
    ("does not treat corrupt route state as no routes: %s", async (body) => {
      await writeFile(path.join(stateDir, "executors.json"), body);
      await expect(resolveRoutedLocalProject(stateDir, { ...project, root: stateDir }, stateDir))
        .rejects.toMatchObject({ name: "DomainError", details: { stateDir } });
    });

  it("preserves explicit local and managed task-local routes with canonical targets", async () => {
    const local = { ...project, root: stateDir };
    await setProjectExecutorRoute(stateDir, local.projectId, "local");
    const resolved = await resolveRoutedLocalProject(stateDir, local, stateDir);
    const expected = await deriveLocalExecutionTarget(stateDir, local);
    expect(resolved.executionTarget).toEqual(expected);
    if (!resolved.executionTarget) throw new Error("Expected a resolved local execution target");
    expect(sameExecutionTarget(expected, resolved.executionTarget)).toBe(true);
    const task = { ...local, projectId: `jk-task-${"a".repeat(24)}` };
    await setProjectExecutorRoute(stateDir, task.projectId, "worker");
    expect((await resolveRoutedLocalProject(stateDir, task, stateDir)).executionTarget).toEqual(await deriveLocalExecutionTarget(stateDir, task));
  });
  it.each(["instance", "root", "workspace", "route"])("rejects an expected target after its %s changes", async (change) => {
    await setProjectExecutorRoute(stateDir, "logical", "worker");
    const target = deriveRemoteExecutionTarget(identity, project, "logical");
    if (change === "instance") heartbeat.instanceId = "instance-2";
    if (change === "root") heartbeat.projects = [{ ...project, root: "C:/different/fixture" }];
    if (change === "workspace") heartbeat.workspaceRoot = "C:/different";
    await recordExecutorHeartbeat(stateDir, heartbeat);
    if (change === "route") await setProjectExecutorRoute(stateDir, "logical", "local");
    await expect(dispatchExecutorJob(stateDir, "worker", "file_create", { sourceProjectId: "fixture", executionTarget: target }))
      .rejects.toMatchObject({ name: "DomainError" });
    await expect(pollExecutorJob("worker", 0, heartbeat, stateDir)).resolves.toBeNull();
  });

  it("rejects a canonical mapping changed to another project on the same worker", async () => {
    await setProjectExecutorRoute(stateDir, "logical", "worker");
    const target = deriveRemoteExecutionTarget(identity, project, "logical");
    heartbeat.projects = [{ ...project, aliases: [] }, { ...project, projectId: "other", root: "C:/other" }];
    await recordExecutorHeartbeat(stateDir, heartbeat);
    await expect(dispatchExecutorJob(stateDir, "worker", "file_create", { sourceProjectId: "fixture", executionTarget: target }))
      .rejects.toMatchObject({ name: "DomainError" });
  });

  it("binds metadata to remote registry entries and refuses alias execution", async () => {
    expect((await getExecutorProjectRegistry(stateDir, []))[0]?.executionTarget).toEqual(deriveRemoteExecutionTarget(identity, project));
    await expect(dispatchExecutorJob(stateDir, "worker", "file_create", { sourceProjectId: "logical" })).rejects.toMatchObject({ name: "DomainError" });
    await expect(dispatchExecutorJob(stateDir, "worker", "file_create", {})).rejects.toMatchObject({ name: "DomainError" });
  });

  it("rejects stale polls/results and never gives replacement workers old-instance jobs", async () => {
    const queued = await enqueue();
    const rejected = expect(queued.result).rejects.toMatchObject({ name: "DomainError" });
    const job = await pollExecutorJob("worker", 0, identity, stateDir);
    expect(job?.runtime.instanceId).toBe("instance-1");
    if (!job) throw new Error("Expected the original worker's queued job");
    expect(completeExecutorJob(job.jobId, "wrong instance", undefined, "worker", { ...identity, instanceId: "instance-2" })).toBe(false);
    const replacement = { ...heartbeat, instanceId: "instance-2" };
    await recordExecutorHeartbeat(stateDir, replacement);
    await rejected;
    await expect(pollExecutorJob("worker", 0, identity, stateDir)).rejects.toMatchObject({ name: "DomainError" });
    expect(completeExecutorJob(job.jobId, "stale", undefined, "worker", identity)).toBe(false);
    await expect(pollExecutorJob("worker", 0, replacement, stateDir)).resolves.toBeNull();
  });

  it("invalidates an undelivered job on worker replacement", async () => {
    const queued = await enqueue();
    const rejected = expect(queued.result).rejects.toMatchObject({ name: "DomainError" });
    const replacement = { ...heartbeat, instanceId: "instance-2" };
    await recordExecutorHeartbeat(stateDir, replacement);
    await rejected;
    await expect(pollExecutorJob("worker", 0, replacement, stateDir)).resolves.toBeNull();
  });

  it.each(["root", "capability"])("rejects queued work whose %s changed before delivery", async (change) => {
    const queued = await enqueue();
    const rejected = expect(queued.result).rejects.toMatchObject({ name: "DomainError" });
    if (change === "root") heartbeat.projects = [{ ...project, root: "C:/other" }];
    if (change === "capability") heartbeat.capabilities = heartbeat.capabilities.filter((item) => item !== "file_create");
    await recordExecutorHeartbeat(stateDir, heartbeat);
    await expect(pollExecutorJob("worker", 0, identity, stateDir)).resolves.toBeNull();
    await rejected;
  });

  it("requires protocol identity for polls and results even for restart", async () => {
    await expect(pollExecutorJob("worker", 0)).rejects.toMatchObject({ name: "DomainError" });
    const waiting = pollExecutorJob("worker", 1_000, identity, stateDir);
    const result = dispatchExecutorJob(stateDir, "worker", "executor_restart", { reason: "test" });
    const job = await waiting;
    if (!job) throw new Error("Expected a runtime-bound restart job");
    expect(job?.executionTarget).toBeUndefined();
    expect(job?.runtime).toEqual(identity);
    expect(completeExecutorJob(job.jobId, "no identity")).toBe(false);
    expect(completeExecutorJob(job.jobId, "ok", undefined, "worker", identity)).toBe(true);
    await expect(result).resolves.toBe("ok");
  });
});
