import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp-server.js";
import { registerControlCenterRoutes } from "../control-center/http.js";
import { Store } from "../state/store.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import { makeLease } from "../workspace/project-select.js";
import { createRuntimeIdentity, deriveLocalExecutionTarget, deriveRemoteExecutionTarget, type RuntimeIdentity } from "../executors/target-protocol.js";
import { completeExecutorJob, pollExecutorJob, recordExecutorHeartbeat, setProjectExecutorRoute, EXECUTOR_HEARTBEAT_TTL_MS, type ExecutorJob } from "../executors/broker.js";
import { runLocalShell } from "../exec/local-shell.js";
import { listCommands, runCommand } from "../exec/command-runner.js";
import { requestLocalShellApproval } from "../policy/local-approvals.js";
import { queueLocalShellJob, readLocalShellJob } from "../policy/local-shell-jobs.js";

describe("execution targets through MCP and owner HTTP approval", () => {
  let temp: string;
  let root: string;
  let ctx: ToolContext;
  let client: Client;
  let mcp: Awaited<ReturnType<typeof createServer>>;
  let http: Server;
  let baseUrl: string;
  let events: EventEmitter;
  let workerRoot: string;
  let identity: RuntimeIdentity;
  let entry: ProjectRegistryEntry;

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "jk-tool-target-"));
    root = path.join(temp, "hub-project");
    await fs.mkdir(root);
    workerRoot = path.join(temp, "worker-project");
    await fs.mkdir(workerRoot);
    identity = await createRuntimeIdentity("worker", temp, "worker", ["local_shell_run", "command_list", "command_run", "file_read_slice", "list_images", "retrieve_image"]);
    const stateDir = path.join(temp, "state");
    const store = new Store(stateDir);
    entry = { projectId: "proj", name: "proj", root, aliases: [] };
    await store.saveProjects([entry]);
    await store.setSession({ activeProjectId: "proj", mode: "edit", lease: makeLease(entry, "full-write") });
    events = new EventEmitter();
    ctx = {
      workspaceRoot: temp, stateDir, registry: [entry], store,
      ledger: { append: async (event) => {
        events.emit(String(event.type), event);
        if (event.type === "local.job.finished" || event.type === "local.job.failed") events.emit("terminal", event);
      } },
      config: { workspaceRoot: temp, stateDir, maxReadBytes: 10000, maxPatchBytes: 10000,
        defaultCommandTimeoutSec: 10, defaultLeaseTtlMs: 60000 },
    };
    mcp = await createServer(ctx);
    client = new Client({ name: "target-tests", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b);
    await client.connect(a);
    const app = express();
    registerControlCenterRoutes(app, ctx);
    http = app.listen(0, "127.0.0.1");
    await once(http, "listening");
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await client?.close();
    await mcp?.close();
    if (http) await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temp, { recursive: true, force: true });
  });

  async function approve(id: string) {
    return await fetch(`${baseUrl}/api/jk/control/approvals/${id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
  }

  async function heartbeat() {
    await recordExecutorHeartbeat(ctx.stateDir, { ...identity, platform: process.platform,
      projects: [{ projectId: "worker-proj", name: "worker-proj", root: workerRoot, aliases: ["proj"] }] });
  }

  async function selectRemote() {
    await heartbeat();
    await setProjectExecutorRoute(ctx.stateDir, "proj", identity.executorId);
    const selected = await client.callTool({ name: "project_select", arguments: { projectId: "proj", reason: "test", preset: "full-write" } });
    expect(selected.isError).not.toBe(true);
  }

  function terminal() {
    return once(events, "terminal", { signal: AbortSignal.timeout(5000) });
  }

  async function nextJob(pending: Promise<ExecutorJob | null>): Promise<ExecutorJob> {
    const job = await pending;
    if (!job) throw new Error("Expected an executor job");
    return job;
  }

  async function queueRemote() {
    await selectRemote();
    const result = await client.callTool({ name: "local_shell_run", arguments: {
      projectId: "proj", command: "echo approved>marker.txt", intent: { needsNetwork: true },
    } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "APPROVAL_REQUIRED", approvalPending: true } });
    return String((result.structuredContent as Record<string, unknown>).approvalId);
  }

  it("resumes a healthy canonical remote approval on the worker, not the hub", async () => {
    const id = await queueRemote();
    const expected = deriveRemoteExecutionTarget(identity, { projectId: "worker-proj", root: workerRoot }, "proj");
    expect(await readLocalShellJob(ctx.stateDir, id)).toMatchObject({ executionTarget: expected });
    const queued = pollExecutorJob(identity.executorId, 5000, identity, ctx.stateDir);
    const finished = terminal();
    expect((await approve(id)).status).toBe(200);
    const job = await nextJob(queued);
    expect(job).toMatchObject({ tool: "local_shell_run", executionTarget: expected,
      payload: { sourceProjectId: "worker-proj", executionTarget: expected } });
    const result = await runLocalShell(workerRoot, String(job.payload.command));
    expect(completeExecutorJob(job.jobId, result, undefined, identity.executorId, identity)).toBe(true);
    await finished;
    expect(await readLocalShellJob(ctx.stateDir, id)).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect((await fs.readFile(path.join(workerRoot, "marker.txt"), "utf8")).trim()).toBe("approved");
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["root", "instance", "workspace", "route", "offline"])("rejects %s changes on approval replay before dispatch", async (change) => {
    const id = await queueRemote();
    if (change === "root") workerRoot = root;
    if (change === "instance") identity = { ...identity, instanceId: "replacement" };
    if (change === "workspace") identity = { ...identity, workspaceRoot: root };
    if (change === "route") await setProjectExecutorRoute(ctx.stateDir, "proj", "local");
    await heartbeat();
    if (change === "offline") {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + EXECUTOR_HEARTBEAT_TTL_MS + 1);
    }
    const finished = terminal();
    expect((await approve(id)).status).toBe(200);
    await finished;
    const job = await readLocalShellJob(ctx.stateDir, id);
    expect(job).toMatchObject({ status: "failed" });
    expect(job?.startedAt).toBeUndefined();
    vi.useRealTimers();
    expect(await pollExecutorJob(identity.executorId, 0, identity, ctx.stateDir)).toBeNull();
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(workerRoot, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not spend an already-approved task bundle on a replacement project root", async () => {
    const firstCommand = "echo first>first.txt";
    const followupCommand = process.platform === "win32"
      ? 'cmd /d /c "if exist disposable.tmp del /q disposable.tmp & echo bundled>marker.txt"'
      : 'sh -c "rm -rf disposable.tmp; echo bundled>marker.txt"';
    const first = await client.callTool({ name: "local_shell_run", arguments: {
      projectId: "proj", workSessionId: "ws_target_bundle", command: firstCommand,
      intent: { needsNetwork: true, approvalBundle: { label: "bounded fixture", commands: [firstCommand, followupCommand] } },
    } });
    expect(first).toMatchObject({ isError: true, structuredContent: { approvalPending: true } });
    const id = String((first.structuredContent as Record<string, unknown>).approvalId);
    const finished = terminal();
    expect((await approve(id)).status).toBe(200);
    await finished;
    expect(await readLocalShellJob(ctx.stateDir, id)).toMatchObject({ status: "succeeded", bundleFingerprint: expect.any(String) });
    const bundlesDir = path.join(ctx.stateDir, "approvals", "shell", "task-bundles");
    const bundles = (await fs.readdir(bundlesDir)).filter((file) => file.endsWith(".json"));
    expect(bundles).toHaveLength(1);
    const bundle = JSON.parse(await fs.readFile(path.join(bundlesDir, String(bundles[0])), "utf8")) as { remainingCommandKeys: string[] };
    expect(bundle.remainingCommandKeys).toHaveLength(1);
    entry.root = workerRoot;
    expect((await client.callTool({ name: "project_select", arguments: { projectId: "proj", reason: "changed root", preset: "full-write" } })).isError).not.toBe(true);
    const followup = await client.callTool({ name: "local_shell_run", arguments: {
      projectId: "proj", workSessionId: "ws_target_bundle", command: followupCommand,
    } });
    expect(followup).toMatchObject({ isError: true, structuredContent: { code: "APPROVAL_REQUIRED", approvalPending: true } });
    const newId = String((followup.structuredContent as Record<string, unknown>).approvalId);
    expect(newId).not.toBe(id);
    expect(await readLocalShellJob(ctx.stateDir, newId)).toMatchObject({ status: "pending", executionTarget: { projectRoot: workerRoot } });
    const unchanged = JSON.parse(await fs.readFile(path.join(bundlesDir, String(bundles[0])), "utf8")) as { remainingCommandKeys: string[] };
    expect(unchanged.remainingCommandKeys).toEqual(bundle.remainingCommandKeys);
    await expect(fs.stat(path.join(workerRoot, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires fresh approval for historical jobs without a target proof", async () => {
    const input = { projectId: "proj", command: "echo legacy>marker.txt", needsNetwork: true, destructive: false };
    const requested = await requestLocalShellApproval(ctx.stateDir, input);
    await queueLocalShellJob(ctx.stateDir, requested, input);
    const finished = terminal();
    expect((await approve(requested.id)).status).toBe(200);
    await finished;
    const job = await readLocalShellJob(ctx.stateDir, requested.id);
    expect(job).toMatchObject({ status: "failed" });
    expect(job?.startedAt).toBeUndefined();
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds inline MCP shell dispatch to server-derived remote identity", async () => {
    await selectRemote();
    const queued = pollExecutorJob(identity.executorId, 5000, identity, ctx.stateDir);
    const call = client.callTool({ name: "local_shell_run", arguments: {
      projectId: "proj", command: "echo inline>marker.txt", executionTarget: { projectRoot: root }, sourceProjectId: "proj",
    } });
    const job = await nextJob(queued);
    expect(job?.payload).toMatchObject({ sourceProjectId: "worker-proj", executionTarget: {
      projectRoot: workerRoot, projectId: "proj", instanceId: identity.instanceId,
    } });
    const result = await runLocalShell(workerRoot, String(job.payload.command));
    expect(completeExecutorJob(job.jobId, result, undefined, identity.executorId, identity)).toBe(true);
    expect((await call).isError).not.toBe(true);
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes image listing and retrieval to the selected remote worker", async () => {
    await selectRemote();
    const listPending = pollExecutorJob(identity.executorId, 5000, identity, ctx.stateDir);
    const listCall = client.callTool({ name: "list_images", arguments: { projectId: "proj" } });
    const listJob = await nextJob(listPending);
    expect(listJob).toMatchObject({ tool: "list_images", payload: { sourceProjectId: "worker-proj", executionTarget: { projectRoot: workerRoot } } });
    const image = { filePath: ".jk/images/pixel.png", resourceUri: "file:///worker/pixel.png", sha256: "a".repeat(64), bytes: 68, mime: "image/png", modifiedAt: 1 };
    expect(completeExecutorJob(listJob.jobId, { images: [image] }, undefined, identity.executorId, identity)).toBe(true);
    expect(await listCall).toMatchObject({ structuredContent: { images: [expect.objectContaining({ filePath: image.filePath })] } });

    const retrievePending = pollExecutorJob(identity.executorId, 5000, identity, ctx.stateDir);
    const retrieveCall = client.callTool({ name: "retrieve_image", arguments: { projectId: "proj", filePath: image.filePath } });
    const retrieveJob = await nextJob(retrievePending);
    expect(retrieveJob).toMatchObject({ tool: "retrieve_image", payload: { sourceProjectId: "worker-proj", filePath: image.filePath, executionTarget: { projectRoot: workerRoot } } });
    expect(completeExecutorJob(retrieveJob.jobId, { ...image, data: "data:image/png;base64,iVBORw0KGgo=" }, undefined, identity.executorId, identity)).toBe(true);
    expect(await retrieveCall).toMatchObject({ structuredContent: { filePath: image.filePath, mime: "image/png", data: expect.stringMatching(/^data:image\/png;base64,/) } });
  });

  it("refuses a local-only execution helper on a selected remote target", async () => {
    await selectRemote();
    const result = await client.callTool({ name: "e2e_run_command", arguments: {
      projectId: "proj", command: "echo wrong-host>marker.txt", captureScreenshot: false,
    } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "COMMAND_NOT_ALLOWED" } });
    expect(await pollExecutorJob(identity.executorId, 0, identity, ctx.stateDir)).toBeNull();
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(workerRoot, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks the local root after asynchronous pre-execution work", async () => {
    events.once("process.started", () => { entry.root = workerRoot; });
    const result = await client.callTool({ name: "local_shell_run", arguments: { projectId: "proj", command: "echo wrong-root>marker.txt" } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "APPROVAL_RESUME_FAILED" } });
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(workerRoot, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a changed local selected root before MCP mutation", async () => {
    entry.root = workerRoot;
    const result = await client.callTool({ name: "file_create", arguments: { projectId: "proj", path: "marker.txt", content: "bad" } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "COMMAND_NOT_ALLOWED" } });
    await expect(fs.stat(path.join(workerRoot, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unavailable canonical worker but permits an explicitly selected local route", async () => {
    await selectRemote();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + EXECUTOR_HEARTBEAT_TTL_MS + 1);
    const down = await client.callTool({ name: "local_shell_run", arguments: { projectId: "proj", command: "echo local>marker.txt" } });
    expect(down).toMatchObject({ isError: true, structuredContent: { code: "COMMAND_NOT_ALLOWED" } });
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await setProjectExecutorRoute(ctx.stateDir, "proj", "local");
    expect((await client.callTool({ name: "project_select", arguments: { projectId: "proj", reason: "local", preset: "full-write" } })).isError).not.toBe(true);
    const local = await client.callTool({ name: "local_shell_run", arguments: { projectId: "proj", command: "echo local>marker.txt" } });
    expect(local.isError).not.toBe(true);
    expect((await fs.readFile(path.join(root, "marker.txt"), "utf8")).trim()).toBe("local");
  });

  it("pins command_run approval and resumes its manifest-bound command on the worker", async () => {
    await fs.writeFile(path.join(workerRoot, "package.json"), JSON.stringify({ scripts: { deploy: "echo command>marker.txt" } }));
    await selectRemote();
    const discovery = pollExecutorJob(identity.executorId, 5000, identity, ctx.stateDir);
    const call = client.callTool({ name: "command_run", arguments: { projectId: "proj", commandId: "npm:deploy" } });
    const listJob = await nextJob(discovery);
    expect(listJob?.tool).toBe("command_list");
    expect(listJob?.payload.executionTarget).toMatchObject({ projectRoot: workerRoot });
    const commands = await listCommands(workerRoot);
    const policy = commands.find((c) => c.commandId === "npm:deploy");
    if (!policy) throw new Error("Expected discovered npm:deploy");
    expect(completeExecutorJob(listJob.jobId, { commands }, undefined, identity.executorId, identity)).toBe(true);
    const approval = await call;
    expect(approval).toMatchObject({ isError: true, structuredContent: { approvalPending: true } });
    const id = String((approval.structuredContent as Record<string, unknown>).approvalId);
    expect(await readLocalShellJob(ctx.stateDir, id)).toMatchObject({ executionKind: "command-run", executionTarget: { projectRoot: workerRoot } });
    const queued = pollExecutorJob(identity.executorId, 5000, identity, ctx.stateDir);
    const finished = terminal();
    expect((await approve(id)).status).toBe(200);
    const job = await nextJob(queued);
    expect(job).toMatchObject({ tool: "command_run", payload: { executionTarget: { projectRoot: workerRoot },
      expectedManifestFingerprint: policy.manifestFingerprint, approvedRisky: true } });
    const result = await runCommand(workerRoot, "npm:deploy", undefined, 10, String(job.payload.expectedManifestFingerprint), true);
    expect(completeExecutorJob(job.jobId, result, undefined, identity.executorId, identity)).toBe(true);
    await finished;
    expect(await readLocalShellJob(ctx.stateDir, id)).toMatchObject({ status: "succeeded" });
    expect((await fs.readFile(path.join(workerRoot, "marker.txt"), "utf8")).trim()).toBe("command");
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a changed approved project root without running the queued marker", async () => {
    const input = {
      projectId: "proj", command: "echo approved>marker.txt", needsNetwork: true, destructive: false,
      executionTarget: await deriveLocalExecutionTarget(temp, entry),
    };
    const approval = await requestLocalShellApproval(ctx.stateDir, input);
    await queueLocalShellJob(ctx.stateDir, approval, input);
    const replacement = path.join(temp, "replacement");
    await fs.mkdir(replacement);
    entry.root = replacement;
    // Subscribe before approval: either terminal outcome is observable without polling.
    const finished = terminal();
    const response = await approve(approval.id);
    expect(response.status).toBe(200);
    await finished;
    expect(await readLocalShellJob(ctx.stateDir, approval.id)).toMatchObject({ status: "failed" });
    await expect(fs.stat(path.join(replacement, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
