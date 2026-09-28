import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../state/store.js";
import { TaskWorkspaceStore } from "../workspace/task-workspaces.js";
import { makeLease } from "../workspace/project-select.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { MassUlwStore } from "../orchestration/mass-ulw-store.js";
import { MassUlwWebWorkflow, type WebMassInput } from "../orchestration/mass-ulw-web.js";
import * as web from "../orchestration/mass-ulw-web.js";
import { MassUlwWorkspace } from "../orchestration/mass-ulw-workspace.js";
import { MassUlwArtifactStore } from "../orchestration/mass-ulw-artifacts.js";
import { git } from "../orchestration/mass-ulw-workspace-repository.js";
import { buildMassUlwPlan } from "../orchestration/mass-ulw.js";
import * as commands from "../exec/command-runner.js";
import * as patches from "../code/patch.js";
import { createMassUlwExecutionIdentity } from "./mass-ulw-identity.js";
import { executeWebMassStep } from "./mass-ulw-web-tool.js";
import { ErrorCode, type ToolContext } from "../types.js";

describe("web late lease authorization", () => {
  let temp: string, source: string, stateDir: string, taskRoot: string;
  let store: Store, tasks: TaskWorkspaceStore, ctx: ToolContext, base: WebMassInput;
  const privateRoots = new Set<string>();
  const step = (input: Partial<WebMassInput>) => executeWebMassStep(ctx, { ...base, ...input }, async () => true);
  const load = () => new MassUlwWebWorkflow(stateDir, base.projectId).load();
  const patch = (id: string) => `*** Begin Patch\n*** Add File: src/${id.toLowerCase()}/result.txt\n+${id}\n*** End Patch`;
  async function submit(id: string) {
    const workflow = new MassUlwWebWorkflow(stateDir, base.projectId), doc = await workflow.load();
    return step({ action: "submit", submissions: [{ laneId: id, contextToken: workflow.contextToken(doc, id), submissionId: `${id}-1`, patch: patch(id) }] });
  }
  async function accept(id: string) {
    const doc = await load();
    return step({ action: "review", laneId: id, token: doc.lanes[id]?.proof?.token, verdict: "approve", summary: "Checked scoped contribution and verifier" });
  }
  async function expire() {
    await store.updateSession((session) => ({ ...session, lease: session.lease && { ...session.lease, expiresAt: 0 } }));
    await expect(requireProjectLease(ctx, base.projectId, "write")).rejects.toMatchObject({ code: ErrorCode.LEASE_REQUIRED });
  }
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "jk-web-lease-st_01a081e1-"));
    source = path.join(temp, "source"); stateDir = path.join(temp, "state"); await fs.mkdir(source);
    await git(source, ["init", "--quiet"]); await git(source, ["config", "user.name", "JK test"]); await git(source, ["config", "user.email", "test@localhost"]);
    await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
    await fs.writeFile(path.join(source, "check.cjs"), `require('node:fs').appendFileSync(${JSON.stringify(path.join(temp, "invocations"))}, 'verify\\n');\n`);
    await git(source, ["add", "."]); await git(source, ["commit", "--quiet", "-m", "baseline"]);
    store = new Store(stateDir); tasks = new TaskWorkspaceStore(stateDir);
    const entry = { projectId: "source", root: source, name: "source", aliases: [] };
    const task = await tasks.create(entry, "ws_lease", "Verify authorization boundaries"); taskRoot = tasks.root(task.id);
    const project = tasks.project(task); await store.saveProjects([entry, project]);
    await store.setSession({ lease: makeLease(project, "full-write"), activeProjectId: task.id });
    ctx = { workspaceRoot: source, stateDir, registry: [entry, project], store, ledger: { append: async () => undefined }, config: { workspaceRoot: source, stateDir, maxReadBytes: 10000, maxPatchBytes: 10000, defaultCommandTimeoutSec: 30, defaultLeaseTtlMs: 300000 } };
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: ["A", "B"].map((id) => ({ id, task: `Implement ${id}`, estimatedWeight: 5, writeScopes: [`src/${id.toLowerCase()}`] })) });
    base = { action: "start", projectId: task.id, workSessionId: task.workSessionId, loopId: "lease-loop", planFingerprint: plan.planFingerprint };
    const identity = await createMassUlwExecutionIdentity({ projectId: task.id, repositoryRoot: taskRoot, externalLoopId: base.loopId });
    await new MassUlwStore(stateDir).create(identity.executionId, plan);
    const create = MassUlwWorkspace.create;
    vi.spyOn(MassUlwWorkspace, "create").mockImplementation(async (options) => { const workspace = await create(options); privateRoots.add(workspace.privateRoot); return workspace; });
    await step({ action: "start", laneVerificationCommandIds: { A: "npm:test", B: "npm:test" }, finalVerificationCommandId: "npm:test" });
  }, 120000);
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of privateRoots) await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    privateRoots.clear();
    await fs.rm(temp, { recursive: true, force: true });
    await expect(fs.stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
    console.log("E_CLEANUP owned fixture and private workspaces absent");
  });

  it("F1 surfaces real artifact directory obstruction globally without verifier or repair debit", async () => {
    await submit("B"); await accept("B");
    const before = await load(), peer = before.lanes.B;
    const artifactRoot = path.join(stateDir, "orchestration", "mass-ulw-artifacts");
    const preserved = path.join(temp, "preserved-peer-artifacts");
    const peerFiles = await fs.readdir(artifactRoot, { recursive: true });
    const peerBytes = await Promise.all(peerFiles.map(async (file) => (await fs.stat(path.join(artifactRoot, file))).isFile() ? fs.readFile(path.join(artifactRoot, file)) : null));
    const invocations = await fs.readFile(path.join(temp, "invocations"));
    const run = vi.spyOn(commands, "runCommand");
    const prepare = MassUlwWorkspace.prototype.prepareLane;
    let obstructed = false;
    vi.spyOn(MassUlwWorkspace.prototype, "prepareLane").mockImplementation(async function (this: MassUlwWorkspace, id, ancestors) {
      await prepare.call(this, id, ancestors);
      if (id === "A" && !obstructed) {
        // B has already been restored by the real workspace. Keep its bytes,
        // then obstruct the actual durable save directory, not a mocked save.
        await fs.rename(artifactRoot, preserved);
        await fs.writeFile(artifactRoot, "owned obstruction", { flag: "wx" });
        obstructed = true;
      }
    });
    const outcome = await submit("A").then((result) => ({ result }), (error: unknown) => ({ error }));
    expect.soft(outcome).toMatchObject({ error: { name: "MassUlwPersistenceError", cause: { code: "ENOTDIR" } } });
    expect(obstructed).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(temp, "invocations"))).toEqual(invocations);
    const after = await load();
    expect.soft(after.lanes.A?.attempts.filter((attempt) => attempt.status === "failed")).toEqual([]);
    expect(after.lanes.A?.proof).toBeNull();
    expect(after.lanes.B).toEqual(peer);
    expect(await fs.readFile(artifactRoot, "utf8")).toBe("owned obstruction");
    for (const [index, file] of peerFiles.entries()) if (peerBytes[index]) expect(await fs.readFile(path.join(preserved, file))).toEqual(peerBytes[index]);
    for (const root of privateRoots) await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await tasks.locked(base.projectId, async () => undefined); // Adapter released its lock after draining work.
    await expect(fs.stat(path.join(taskRoot, "src"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(source, "src"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120000);

  it.each(["patch", "verifier", "integration", "integration-verifier", "publish", "task-verify"] as const)("native-evolution R5 expires the real lease before %s without repair debit or peer loss", async (boundary) => {
    // Given: accepted independent peer and real native verification artifacts.
    await submit("B"); await accept("B");
    if (["integration", "integration-verifier", "publish", "task-verify"].includes(boundary)) { await submit("A"); await accept("A"); }
    if (["publish", "task-verify"].includes(boundary)) {
      await step({ action: "integrate" }); const doc = await load();
      await step({ action: "review", token: doc.integration?.proof.token, verdict: "approve", summary: "Reviewed integrated output" });
    }
    const before = await load(), peer = before.lanes.B;
    const invocationBytes = await fs.readFile(path.join(temp, "invocations"), "utf8");
    const apply = vi.spyOn(patches, "applyPatch"), run = vi.spyOn(commands, "runCommand");
    const integrate = vi.spyOn(MassUlwWorkspace.prototype, "integrate"), publish = vi.spyOn(MassUlwWorkspace.prototype, "publish");
    const taskVerify = vi.spyOn(TaskWorkspaceStore.prototype, "verify");
    let release!: () => void, arrived!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    let armed = true;
    const gate = async () => { if (armed) { armed = false; arrived(); await held; } };
    if (boundary === "patch") {
      const prepare = MassUlwWorkspace.prototype.prepareLane;
      vi.spyOn(MassUlwWorkspace.prototype, "prepareLane").mockImplementation(async function (this: MassUlwWorkspace, id, ancestors) { await prepare.call(this, id, ancestors); if (id === "A") await gate(); });
    } else if (boundary === "verifier" || boundary === "integration-verifier") {
      const list = commands.listCommands;
      vi.spyOn(commands, "listCommands").mockImplementation(async (root) => { const result = await list(root); if (path.basename(root) === (boundary === "verifier" ? "lane-A" : "merged") && root !== taskRoot) await gate(); return result; });
    } else if (boundary === "integration") {
      const restore = MassUlwArtifactStore.prototype.restore;
      vi.spyOn(MassUlwArtifactStore.prototype, "restore").mockImplementation(async function (this: MassUlwArtifactStore, input) { const result = await restore.call(this, input); if (input.laneId === "B") await gate(); return result; });
    } else if (boundary === "publish") {
      integrate.mockRestore();
      const real = MassUlwWorkspace.prototype.integrate;
      vi.spyOn(MassUlwWorkspace.prototype, "integrate").mockImplementation(async function (this: MassUlwWorkspace) { const result = await real.call(this); await gate(); return result; });
    } else {
      const fingerprint = TaskWorkspaceStore.prototype.fingerprint;
      vi.spyOn(TaskWorkspaceStore.prototype, "fingerprint").mockImplementation(async function (this: TaskWorkspaceStore, id) { const result = await fingerprint.call(this, id); if ((await load()).integration?.status === "applied") await gate(); return result; });
    }
    // Subscribe before triggering. Timer is a failure deadline, never scheduling.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Boundary not reached: ${boundary}`)), 90000); });
    const operation = (boundary === "patch" || boundary === "verifier" ? submit("A") : step({ action: boundary === "integration" || boundary === "integration-verifier" ? "integrate" : "finish" })).then((result) => ({ result }), (error: unknown) => ({ error }));
    try {
      await Promise.race([reached, deadline, operation.then(() => { throw new Error("Operation settled before boundary"); })]);
      await expire(); release();
      const outcome = await operation;
      expect(outcome).toMatchObject({ error: { code: ErrorCode.LEASE_REQUIRED } });
      expect(run).not.toHaveBeenCalled(); expect(taskVerify).not.toHaveBeenCalled();
      if (boundary === "patch") expect(apply).not.toHaveBeenCalled();
      if (boundary === "integration") expect(integrate).not.toHaveBeenCalled();
      if (boundary !== "task-verify") expect(publish).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(temp, "invocations"), "utf8")).toBe(invocationBytes);
      const after = await load(); expect(after.lanes.B).toEqual(peer);
      if (boundary === "integration-verifier") {
        expect(after.integration?.verificationStatus).toBe("permission-paused");
        const view = await new MassUlwWebWorkflow(stateDir, base.projectId).view(after);
        expect(view.reasonCode).toBe("permission-required");
        expect(view.nextCall).toMatchObject({ input: { action: "integrate" } });
      }
      expect(after.lanes.A?.attempts.filter((attempt) => attempt.status === "failed")).toEqual(before.lanes.A?.attempts.filter((attempt) => attempt.status === "failed"));
      if (boundary === "patch" || boundary === "verifier") expect(after.lanes.A?.attempts.at(-1)?.status).toBe("permission-paused");
      await expect(fs.stat(path.join(source, "src"))).rejects.toMatchObject({ code: "ENOENT" });
      if (boundary === "integration-verifier") {
        ctx.store = store = new Store(stateDir);
        const project = tasks.project(await tasks.load(base.projectId));
        await store.setSession({ lease: makeLease(project, "full-write"), activeProjectId: base.projectId });
        await step({ action: "integrate" });
        expect(run).toHaveBeenCalledTimes(1);
        const resumed = await load(); expect(resumed.integration?.verificationStatus).toBe("passed");
        expect(resumed.lanes).toEqual(before.lanes);
        await step({ action: "integrate" });
        expect(run).toHaveBeenCalledTimes(1);
        expect((await load()).integration).toEqual(resumed.integration);
      }
    } finally { if (timer) clearTimeout(timer); release(); await operation; }
  }, 240000);

  it("E evidence R7 snapshot is read-only even with interrupted state", async () => {
    const file = path.join(tasks.directory(base.projectId), "mass-ulw-web.json");
    const doc = await load(); doc.lanes.A!.status = "running";
    const bytes = JSON.stringify(doc); await fs.writeFile(file, bytes);
    const recover = vi.spyOn(MassUlwWebWorkflow.prototype, "recoverInterrupted");
    const lock = vi.spyOn(TaskWorkspaceStore.prototype, "locked");
    const fingerprint = vi.spyOn(TaskWorkspaceStore.prototype, "fingerprint");
    const write = vi.spyOn(fs, "writeFile"), rename = vi.spyOn(fs, "rename"), open = vi.spyOn(fs, "open");
    const snapshot = await web.readWebMassSnapshot(stateDir, base.projectId);
    expect(snapshot).toMatchObject({ kind: "available", document: { lanes: { A: { status: "running" } } } });
    expect(recover).not.toHaveBeenCalled(); expect(lock).not.toHaveBeenCalled(); expect(fingerprint).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
  }, 120000);

  it("E evidence R7 snapshot rejects a different owner without rewriting bytes", async () => {
    const file = path.join(tasks.directory(base.projectId), "mass-ulw-web.json");
    const bytes = JSON.stringify({ ...await load(), workSessionId: "different-owner" }); await fs.writeFile(file, bytes);
    expect((await web.readWebMassSnapshot(stateDir, base.projectId)).kind).toBe("invalid");
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
  }, 120000);

  it.each(["json", "schema"] as const)("E evidence R7 snapshot distinguishes %s corruption from absence", async (kind) => {
    const file = path.join(tasks.directory(base.projectId), "mass-ulw-web.json");
    const bytes = kind === "json" ? "{broken" : JSON.stringify({ ...await load(), lanes: { A: { status: 17 } } });
    await fs.writeFile(file, bytes);
    expect((await web.readWebMassSnapshot(stateDir, base.projectId)).kind).toBe("invalid");
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
    await fs.rm(file);
    expect((await web.readWebMassSnapshot(stateDir, base.projectId)).kind).toBe("absent");
  }, 120000);

  it("native-evolution R7 reads and validates web owner state without recovery or writes", async () => {
    await submit("B"); await accept("B");
    const file = path.join(tasks.directory(base.projectId), "mass-ulw-web.json");
    const doc = await load(); doc.lanes.A!.status = "running";
    await fs.writeFile(file, JSON.stringify(doc));
    const bytes = await fs.readFile(file);
    expect("readWebMassSnapshot" in web).toBe(true);
    const snapshot = await web.readWebMassSnapshot(stateDir, base.projectId);
    expect(snapshot.kind).toBe("available");
    if (snapshot.kind === "available") {
      expect(snapshot.document.lanes.A?.status).toBe("running");
      expect(snapshot.document.lanes.B).toEqual(doc.lanes.B);
      expect(snapshot.task.workSessionId).toBe(base.workSessionId);
    }
    expect(await fs.readFile(file)).toEqual(bytes);
    await fs.writeFile(file, JSON.stringify({ ...doc, workSessionId: "wrong-owner" }));
    expect((await web.readWebMassSnapshot(stateDir, base.projectId)).kind).toBe("invalid");
    await fs.writeFile(file, "{broken");
    expect((await web.readWebMassSnapshot(stateDir, base.projectId)).kind).toBe("invalid");
    expect(await fs.readFile(file, "utf8")).toBe("{broken");
    const legacy = { ...doc, updatedAt: undefined, lanes: Object.fromEntries(Object.entries(doc.lanes).map(([id, lane]) => {
      const { attempts, strategyGeneration, strategies, reviews, ...state } = lane;
      return [id, state];
    })) };
    const legacyBytes = JSON.stringify(legacy); await fs.writeFile(file, legacyBytes);
    const migrated = await web.readWebMassSnapshot(stateDir, base.projectId);
    expect(migrated.kind).toBe("available");
    if (migrated.kind === "available") { expect(migrated.document.lanes.B?.attempts).toEqual([]); expect(migrated.document.updatedAt).toBeNull(); }
    expect(await fs.readFile(file, "utf8")).toBe(legacyBytes);
    await fs.rm(file);
    expect((await web.readWebMassSnapshot(stateDir, base.projectId)).kind).toBe("absent");
  }, 120000);
});
