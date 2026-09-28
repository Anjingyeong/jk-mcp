import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskWorkspaceStore, taskWorkspaceProjects } from "./task-workspaces.js";
import { fingerprintMassUlwRepository, git } from "../orchestration/mass-ulw-workspace-repository.js";
import { listCommands } from "../exec/command-runner.js";
import * as commandRunner from "../exec/command-runner.js";
import { Store } from "../state/store.js";
import type { ProjectRegistryEntry } from "../types.js";

describe("persistent ChatGPT task workspaces", () => {
  let temp: string;
  let source: ProjectRegistryEntry;
  let stateDir: string;
  let workspaces: TaskWorkspaceStore;
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "jk-task-workspace-"));
    const root = path.join(temp, "source");
    stateDir = path.join(temp, "state");
    await fs.mkdir(root);
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.name", "JK tests"]);
    await git(root, ["config", "user.email", "test@localhost"]);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
    await fs.writeFile(path.join(root, "check.cjs"), "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'), 'good');\n");
    await fs.writeFile(path.join(root, "value.txt"), "good");
    await fs.writeFile(path.join(root, "notes.txt"), "base");
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", "baseline"]);
    source = { projectId: "source", name: "source", root, aliases: [] };
    workspaces = new TaskWorkspaceStore(stateDir);
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });
  const command = async (root: string) => (await listCommands(root)).find((item) => item.riskTier === "verify")!.commandId;

  it("preserves dirty/staged source state, separates tasks, and restores registry after restart", async () => {
    await fs.writeFile(path.join(source.root, "notes.txt"), "staged");
    await git(source.root, ["add", "notes.txt"]);
    await fs.writeFile(path.join(source.root, "notes.txt"), "working");
    const before = await fingerprintMassUlwRepository(source.root);
    const a = await workspaces.create(source, "ws_a", "Change notes");
    const b = await workspaces.create(source, "ws_b", "Another task");
    expect((await workspaces.create(source, "ws_a", "Change notes")).id).toBe(a.id);
    await expect(workspaces.create(source, "ws_a", "Different goal")).rejects.toThrow(/different goal/);
    await fs.writeFile(path.join(workspaces.root(a.id), "notes.txt"), "task A");
    expect(await fs.readFile(path.join(workspaces.root(b.id), "notes.txt"), "utf8")).toBe("working");
    expect((await fingerprintMassUlwRepository(source.root)).digest).toBe(before.digest);
    expect(await git(workspaces.root(a.id), ["remote"])).toBe("");
    const store = new Store(stateDir);
    await store.saveProjects([source, workspaces.project(a)]);
    expect((await new Store(stateDir).loadProjects()).map((entry) => entry.projectId)).toEqual(expect.arrayContaining(["source", a.id, b.id]));
    await workspaces.locked(a.id, () => workspaces.archive(a.id));
    expect((await taskWorkspaceProjects(stateDir)).map((entry) => entry.projectId)).not.toContain(a.id);
    await expect(workspaces.assertActive(a.id)).rejects.toThrow(/archived/);
    await new TaskWorkspaceStore(stateDir).locked(a.id, () => workspaces.resume(a.id));
    expect(await fs.readFile(path.join(workspaces.root(a.id), "notes.txt"), "utf8")).toBe("task A");
  });

  it("publishes only verified changes while preserving the original index, and is idempotent", async () => {
    await fs.writeFile(path.join(source.root, "notes.txt"), "user staging");
    await git(source.root, ["add", "notes.txt"]);
    const index = await git(source.root, ["ls-files", "--stage", "-z"]);
    const head = await git(source.root, ["rev-parse", "HEAD"]);
    const record = await workspaces.create(source, "ws_publish", "Update notes");
    await fs.writeFile(path.join(workspaces.root(record.id), "notes.txt"), "reviewed task output");
    await expect(workspaces.publish(record.id, "fake", "reviewed")).rejects.toThrow(/verification/);
    const verified = await workspaces.verify(record.id, await command(workspaces.root(record.id)));
    expect(verified.verification?.passed).toBe(true);
    const published = await workspaces.locked(record.id, () => workspaces.publish(record.id, verified.verification!.id, "Reviewed the notes diff"));
    expect(published.status).toBe("published");
    expect(published.changedPaths).toEqual(["notes.txt"]);
    expect(await fs.readFile(path.join(source.root, "notes.txt"), "utf8")).toBe("reviewed task output");
    expect(await git(source.root, ["ls-files", "--stage", "-z"])).toBe(index);
    expect(await git(source.root, ["rev-parse", "HEAD"])).toBe(head);
    // Simulate a crash after durable publication but before task state was saved.
    await fs.writeFile(path.join(workspaces.directory(record.id), "state.json"), JSON.stringify({ ...published, status: "active" }));
    const restarted = new TaskWorkspaceStore(stateDir);
    expect((await restarted.publish(record.id, verified.verification!.id, "recover receipt")).status).toBe("published");
    expect(await fs.readFile(path.join(source.root, "notes.txt"), "utf8")).toBe("reviewed task output");
    expect((await restarted.publish(record.id, verified.verification!.id, "already applied")).status).toBe("published");
    expect(await fs.stat(workspaces.root(record.id))).toBeDefined();
  });

  it("rejects stale verification, failed tests, and a concurrently modified original", async () => {
    const record = await workspaces.create(source, "ws_stale", "Fix notes");
    const commandId = await command(workspaces.root(record.id));
    let verified = await workspaces.verify(record.id, commandId);
    await fs.writeFile(path.join(workspaces.root(record.id), "notes.txt"), "new diff");
    await expect(workspaces.publish(record.id, verified.verification!.id, "old review")).rejects.toThrow(/verification/);
    await fs.writeFile(path.join(workspaces.root(record.id), "value.txt"), "bad");
    verified = await workspaces.verify(record.id, commandId);
    expect(verified.verification?.passed).toBe(false);
    await expect(workspaces.assertVerified(record.id)).rejects.toThrow(/verification/);
    await fs.writeFile(path.join(workspaces.root(record.id), "value.txt"), "good");
    verified = await workspaces.verify(record.id, commandId);
    await fs.writeFile(path.join(source.root, "notes.txt"), "someone else's edit");
    await expect(workspaces.publish(record.id, verified.verification!.id, "review")).rejects.toThrow(/Original repository changed/);
    expect(await fs.readFile(path.join(source.root, "notes.txt"), "utf8")).toBe("someone else's edit");
  });

  it("invalidates a previous pass before a verification attempt that throws", async () => {
    const record = await workspaces.create(source, "ws_timeout", "Verification interrupted");
    const commandId = await command(workspaces.root(record.id));
    await workspaces.verify(record.id, commandId);
    expect((await workspaces.status(record.id)).verificationCurrent).toBe(true);
    vi.spyOn(commandRunner, "runCommand").mockRejectedValueOnce(new Error("verification interrupted"));
    await expect(workspaces.verify(record.id, commandId)).rejects.toThrow(/interrupted/);
    expect((await new TaskWorkspaceStore(stateDir).load(record.id)).verification).toBeNull();
    await expect(workspaces.assertVerified(record.id)).rejects.toThrow(/verification/);
  });

  it("serializes operations and requires the exact current fingerprint before deleting a checkout", async () => {
    const record = await workspaces.create(source, "ws_discard", "Disposable task");
    const lock = await workspaces.acquire(record.id);
    try { await expect(new TaskWorkspaceStore(stateDir).acquire(record.id)).rejects.toThrow(/busy/); }
    finally { await lock.release(); }
    const before = await workspaces.fingerprint(record.id);
    await fs.writeFile(path.join(workspaces.root(record.id), "notes.txt"), "keep this");
    await expect(workspaces.discard(record.id, before)).rejects.toThrow(/changed/);
    await workspaces.locked(record.id, async () => workspaces.discard(record.id, await workspaces.fingerprint(record.id)));
    expect((await workspaces.load(record.id)).status).toBe("discarded");
    await expect(fs.stat(workspaces.root(record.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(source.root, "notes.txt"), "utf8")).toBe("base");
    await expect(workspaces.resume(record.id)).rejects.toThrow(/discarded/);
  });

  it("recovers partial discard and rejects storage inside the original repository", async () => {
    const invalid = new TaskWorkspaceStore(path.join(source.root, "state"));
    await expect(invalid.create(source, "ws_invalid", "Invalid storage")).rejects.toThrow(/outside the source/);
    await expect(fs.stat(path.join(source.root, "state"))).rejects.toMatchObject({ code: "ENOENT" });
    const record = await workspaces.create(source, "ws_partial", "Discard recovery");
    const fingerprint = await workspaces.fingerprint(record.id);
    // Tombstone written, then process dies after deleting only Git metadata.
    await fs.writeFile(path.join(workspaces.directory(record.id), "state.json"), JSON.stringify({ ...record, status: "discarded" }));
    await fs.rm(path.join(workspaces.root(record.id), ".git"), { recursive: true, force: true });
    const restarted = new TaskWorkspaceStore(stateDir);
    await restarted.locked(record.id, () => restarted.discard(record.id, fingerprint));
    await expect(fs.stat(restarted.root(record.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await restarted.load(record.id)).status).toBe("discarded");
    expect(await fs.readFile(path.join(source.root, "notes.txt"), "utf8")).toBe("base");
  });
});
