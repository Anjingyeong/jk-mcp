import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp-server.js";
import { Store } from "../state/store.js";
import { createHash } from "node:crypto";
import * as slices from "../code/read-slice.js";
import { z } from "zod";
import { git } from "../orchestration/mass-ulw-workspace-repository.js";
import type { ToolContext } from "../types.js";

describe("task_workspace MCP coding flow", () => {
  let temp: string, root: string;
  let ctx: ToolContext;
  let client: Client;
  let server: Awaited<ReturnType<typeof createServer>>;
  async function connect() {
    server = await createServer(ctx);
    client = new Client({ name: "jk-task-tests", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
  }
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), data: result.structuredContent as Record<string, any> };
  }
  async function snapshot(directory = temp): Promise<Record<string, string>> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const result: Record<string, string> = {};
    for (const entry of entries) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) Object.assign(result, await snapshot(location));
      else result[path.relative(temp, location)] = (await fs.readFile(location)).toString("base64");
    }
    return result;
  }
  async function prepare(goal = "Add a text file") {
    const created = await call("task_workspace", { action: "create", projectId: "source", workSessionId: "ws_completion", goal });
    expect(created.error).toBe(false);
    const projectId = String(created.data.projectId);
    const intake = await call("goal_intake", { projectId, workSessionId: "ws_completion", goal });
    expect(intake.error).toBe(false);
    expect((await call("file_create", { projectId, path: "new.txt", content: "delivered" })).error).toBe(false);
    const commands = await call("command_list", { projectId });
    const commandId = String(commands.data.commands.find((item: { riskTier: string }) => item.riskTier === "verify").commandId);
    const terminal = { projectId, loopId: String(intake.data.loopId), workSessionId: "ws_completion", phase: "release", verificationStatus: "pass", reviewVerdict: "approve", pending: [] };
    return { projectId, commandId, terminal };
  }
  async function verifyAndPublish(projectId: string, commandId: string) {
    const verified = await call("task_workspace", { action: "verify", projectId, commandId });
    expect(verified.error).toBe(false);
    const published = await call("task_workspace", { action: "publish", projectId, verificationId: verified.data.workspace.verification.id, reviewSummary: "Reviewed fixture diff and verifier" });
    expect(published.error).toBe(false);
  }
  beforeEach(async () => {
    vi.stubEnv("JK_NTFY_TOPIC", "");
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "jk-task-mcp-"));
    root = path.join(temp, "source");
    await fs.mkdir(root);
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.name", "JK tests"]);
    await git(root, ["config", "user.email", "test@localhost"]);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
    await fs.writeFile(path.join(root, "check.cjs"), "console.log('verified checkout');\n");
    await fs.writeFile(path.join(root, "notes.txt"), "source");
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", "baseline"]);
    const stateDir = path.join(temp, "state");
    const store = new Store(stateDir);
    const entry = { projectId: "source", root, name: "source", aliases: [] };
    await store.saveProjects([entry]);
    ctx = { workspaceRoot: root, stateDir, registry: [entry], ledger: { append: async () => undefined }, store,
      config: { workspaceRoot: root, stateDir, maxReadBytes: 10000, maxPatchBytes: 10000, defaultCommandTimeoutSec: 30, defaultLeaseTtlMs: 100000 } };
    await connect();
    expect((await call("project_select", { projectId: "source", reason: "isolated coding", preset: "full-write" })).error).toBe(false);
  });
  afterEach(async () => { vi.restoreAllMocks(); await client?.close(); await server?.close(); await fs.rm(temp, { recursive: true, force: true });
    await expect(fs.stat(temp)).rejects.toMatchObject({ code: "ENOENT" }); vi.unstubAllEnvs(); });

  it("native-evolution R1 yields unfinished work and restores the saved budget after reconnect", async () => {
    const identity = { projectId: "source", workSessionId: "ws_budget" };
    const first = await call("goal_loop", { ...identity, goal: "Inspect source", mode: "research", maxTurns: 1, pending: ["inspect"] });
    expect(first.error).toBe(false);
    expect(first.data).toMatchObject({ terminal: false, continueRequired: true, lifecycle: "yielded", continuationReason: "turn-budget" });
    await client.close(); await server.close();
    ctx.store = new Store(ctx.stateDir); await connect();
    const resumed = await call("goal_loop", { ...identity, loopId: first.data.loopId });
    expect(resumed.data).toMatchObject({ maxTurns: 1, terminal: false, continueRequired: true, lifecycle: "yielded" });
  });

  it("native-evolution R1 retains full research completion and returns a stable terminal resume", async () => {
    const identity = { projectId: "source", workSessionId: "ws_contract" };
    const goal = "Research contract ".repeat(150);
    const first = await call("goal_loop", { ...identity, goal, mode: "research", pending: ["report"] });
    const completionEvidence = { kind: "contract-result", artifacts: ["notes.txt"] };
    const finished = await call("goal_loop", { ...identity, loopId: first.data.loopId, phase: "release", verificationStatus: "pass", reviewVerdict: "approve", pending: [], completionEvidence });
    expect(finished.error).toBe(false);
    expect(finished.data).toMatchObject({ terminal: true, completionEvidence });
    const before = await snapshot(ctx.stateDir);
    await client.close(); await server.close(); ctx.store = new Store(ctx.stateDir); await connect();
    const resumed = await call("goal_loop", { ...identity, loopId: first.data.loopId });
    expect(resumed.data).toMatchObject({ terminal: true, turn: finished.data.turn, completionEvidence });
    expect(resumed.data.taskState.currentGoal).toBe(goal.trim());
    expect(await snapshot(ctx.stateDir)).toEqual(before);
  });

  it("native-evolution R10 rejects caller-only coding proof and routes to task_workspace", async () => {
    const result = await call("goal_loop", { projectId: "source", workSessionId: "ws_no_proof", goal: "Implement code", phase: "release", verificationStatus: "pass", reviewVerdict: "approve", pending: [], completionEvidence: { kind: "contract-result", artifacts: ["notes.txt"] } });
    expect(result.error).toBe(false);
    expect(result.data).toMatchObject({ terminal: false, continueRequired: true, continuationReason: "evidence-required", nextCall: { toolName: "task_workspace", input: { action: "create", projectId: "source" } } });
  });

  it("native-evolution R3 hydrates content and CAS from one raw buffer after a controlled edit", async () => {
    const identity = { projectId: "source", workSessionId: "ws_digest" };
    await fs.writeFile(path.join(root, "notes.txt"), "old bytes");
    expect((await call("file_read_slice", { ...identity, path: "notes.txt", start: 1, end: 1 })).error).toBe(false);
    const bytes = Buffer.from([65, 13, 10, 66, 13, 10]);
    await fs.writeFile(path.join(root, "notes.txt"), bytes);
    const original = fs.readFile.bind(fs);
    let reads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (String(args[0]) === path.join(root, "notes.txt")) {
        reads += 1;
        if (reads === 1) await fs.writeFile(path.join(root, "notes.txt"), "changed after read");
      }
      return result;
    });
    const resumed = await call("session_resume", { ...identity, includeActiveSlice: true });
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(resumed.error).toBe(false);
    expect(resumed.data).toMatchObject({ activeArtifactStale: true, activePatchPreconditionHashes: { "notes.txt": digest },
      activeSlice: { content: "1" + String.fromCharCode(9) + "A", currentHash: digest, staleAtResume: true } });
    expect(reads).toBe(1);
  });

  it.each(["currentHash", "CAS", "stale", "read-count"] as const)("C evidence local hydration %s belongs to the returned slice", async (assertion) => {
    const identity = { projectId: "source", workSessionId: "ws_hydration_evidence" };
    const file = path.join(root, "notes.txt");
    await fs.writeFile(file, "remembered bytes");
    expect((await call("file_read_slice", { ...identity, path: "notes.txt", start: 1, end: 1 })).error).toBe(false);
    const bytes = Buffer.from("hydrated line\r\nsecond line\r\n");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const readSlice = slices.readSlice;
    vi.spyOn(slices, "readSlice").mockImplementation(async (...args) => {
      // Exact consumer/producer boundary: a pre-hydration hash sees remembered bytes;
      // the real slice sees CRLF bytes; a post-hydration rehash sees later bytes.
      await fs.writeFile(file, bytes);
      const result = await readSlice(...args);
      await fs.writeFile(file, "later bytes");
      return result;
    });
    const read = fs.readFile.bind(fs);
    let reads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (String(args[0]) === file) reads += 1;
      return read(...args);
    });
    const resumed = await call("session_resume", { ...identity, includeActiveSlice: true });
    expect(resumed.error).toBe(false);
    if (assertion === "currentHash") expect(resumed.data.activeSlice.currentHash).toBe(digest);
    else if (assertion === "CAS") expect(resumed.data.activePatchPreconditionHashes).toEqual({ "notes.txt": digest });
    else if (assertion === "stale") expect({ active: resumed.data.activeArtifactStale, slice: resumed.data.activeSlice.staleAtResume }).toEqual({ active: true, slice: true });
    else expect(reads).toBe(1);
  });

  it.each(["response", "remembered"] as const)("C evidence local read token %s uses the producer digest without rehashing", async (assertion) => {
    const identity = { projectId: "source", workSessionId: "ws_read_evidence" };
    const file = path.join(root, "notes.txt");
    const bytes = Buffer.from("read line\r\nsecond line\r\n");
    await fs.writeFile(file, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const readSlice = slices.readSlice;
    vi.spyOn(slices, "readSlice").mockImplementation(async (...args) => {
      const result = await readSlice(...args);
      await fs.writeFile(file, "later bytes");
      return result;
    });
    const result = await call("file_read_slice", { ...identity, path: "notes.txt", start: 1, end: 1 });
    expect(result.error).toBe(false);
    if (assertion === "response") expect(result.data).toMatchObject({ workContextFileHash: digest, tokenStatus: "same-buffer" });
    else expect((await new Store(ctx.stateDir).getSession()).workSessions.source?.ws_read_evidence?.recentFiles[0]?.fileHash).toBe(digest);
  });

  it("native-evolution R1 reconciles a committed full checkpoint after projection failure without overwriting job state", async () => {
    const identity = { projectId: "source", workSessionId: "ws_checkpoint" };
    const goal = "Full bounded requirement ".repeat(100);
    const first = await call("goal_loop", { ...identity, goal, mode: "research", pending: ["original"] });
    const store = new Store(ctx.stateDir); ctx.store = store;
    const original = store.updateSession.bind(store);
    const spy = vi.spyOn(store, "updateSession").mockImplementation(async (mutator) => {
      const next = await mutator(await store.getSession());
      const parsed = z.object({ workSessions: z.record(z.record(z.object({ taskState: z.object({ loopRevision: z.number().optional() }) }))) }).parse(next);
      if (parsed.workSessions.source?.ws_checkpoint?.taskState.loopRevision === 2) throw new Error("owned projection fault");
      return original(() => next);
    });
    const failed = await call("goal_loop", { ...identity, loopId: first.data.loopId, currentTask: "committed progress", pending: ["remaining"], decisions: [{ summary: "retained decision" }] });
    expect(failed.error).toBe(true);
    spy.mockRestore();
    const checkpoint = JSON.parse(await fs.readFile(path.join(ctx.stateDir, "goals", first.data.loopId + ".loop.json"), "utf8"));
    expect(checkpoint).toMatchObject({ revision: 2, goal: goal.trim(), taskState: { currentTask: "committed progress", pending: ["remaining"] } });
    const newerJob = { jobId: "a".repeat(64), status: "ready-to-resume" as const, updatedAt: 99, deliveredAt: 100, resultRevision: "newer" };
    await store.updateSession((session) => { session.workSessions.source!.ws_checkpoint!.taskState.continuation = newerJob; return session; });
    await client.close(); await server.close(); ctx.store = new Store(ctx.stateDir); await connect();
    const resumed = await call("goal_loop", { ...identity, loopId: first.data.loopId });
    expect(resumed.error).toBe(false);
    expect(resumed.data.taskState).toMatchObject({ currentGoal: goal.trim(), currentTask: "committed progress", pending: ["remaining"],
      decisions: [{ summary: "retained decision" }], continuation: newerJob, loopRevision: 3 });
  });

  it.each(["authority", "full-goal", "progress", "continuation"] as const)("C evidence projection %s survives an independently failed projection", async (assertion) => {
    const identity = { projectId: "source", workSessionId: "ws_projection_evidence" };
    const goal = "Complete requirement ".repeat(150).trim();
    const first = await call("goal_loop", { ...identity, goal, mode: "research", pending: ["original"] });
    expect(first.error).toBe(false);
    const store = new Store(ctx.stateDir);
    ctx.store = store;
    const original = store.updateSession.bind(store);
    const fault = vi.spyOn(store, "updateSession").mockImplementation(async (mutator) => {
      // Execute the real projection mutator, but fail its durable write boundary.
      const next = await mutator(await store.getSession());
      const parsed = z.object({ workSessions: z.record(z.record(z.object({ taskState: z.object({ loopRevision: z.number().optional() }) }))) }).parse(next);
      if (parsed.workSessions.source?.ws_projection_evidence?.taskState.loopRevision === 2) throw new Error("C projection write fault");
      return original(() => next);
    });
    try {
      const failed = await call("goal_loop", { ...identity, loopId: first.data.loopId, currentTask: "committed task", completed: ["committed item"], pending: ["remaining"], decisions: [{ summary: "committed decision" }] });
      expect(failed.error).toBe(true);
    } finally { fault.mockRestore(); }
    const loopFile = path.join(ctx.stateDir, "goals", first.data.loopId + ".loop.json");
    if (assertion === "authority") {
      const checkpoint = JSON.parse(await fs.readFile(loopFile, "utf8"));
      expect(checkpoint).toMatchObject({ revision: 2, goal, taskState: { loopRevision: 2, currentTask: "committed task", completed: ["committed item"], pending: ["remaining"] } });
      return;
    }
    const newer = { jobId: "c".repeat(64), status: "ready-to-resume" as const, updatedAt: 900, deliveredAt: 901, resultRevision: "independent-revision", deliveryToken: "independent-token" };
    await store.updateSession((session) => {
      const task = session.workSessions.source!.ws_projection_evidence!.taskState;
      // A genuinely stale, valid projection must not supply the full contract.
      task.currentGoal = "stale preview";
      task.continuation = newer;
      return session;
    });
    await client.close(); await server.close(); ctx.store = new Store(ctx.stateDir); await connect();
    const resumed = await call("goal_loop", { ...identity, loopId: first.data.loopId });
    expect(resumed.error).toBe(false);
    const persisted = (await new Store(ctx.stateDir).getSession()).workSessions.source!.ws_projection_evidence!.taskState;
    // Each case has its own fixture and assertion, so a sibling regression cannot mask it.
    if (assertion === "full-goal") {
      expect(resumed.data.taskState.currentGoal).toBe(goal);
      expect(persisted.currentGoal).toBe(goal);
    } else if (assertion === "progress") {
      expect(resumed.data.taskState).toMatchObject({ currentTask: "committed task", completed: ["committed item"], pending: ["remaining"], decisions: [{ summary: "committed decision" }], loopRevision: 3 });
      expect(persisted).toEqual(resumed.data.taskState);
    } else {
      expect(resumed.data.taskState.continuation).toEqual(newer);
      expect(persisted.continuation).toEqual(newer);
    }
  });

  it("C evidence concurrent same-loop turns retain both updates without a retention prerequisite", async () => {
    const owner = { projectId: "source", workSessionId: "ws_concurrent_evidence" };
    const first = await call("goal_loop", { ...owner, goal: "Independent concurrency", mode: "research" });
    expect(first.error).toBe(false);
    const loopId = String(first.data.loopId);
    let entered!: () => void;
    let attempted!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const secondAttempted = new Promise<void>((resolve) => { attempted = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const deadlines = new Set<ReturnType<typeof setTimeout>>();
    const bounded = async <T,>(signal: Promise<T>): Promise<T> => {
      let timer!: ReturnType<typeof setTimeout>;
      try { return await Promise.race([signal, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("C concurrency event deadline")), 10000); deadlines.add(timer);
      })]); } finally { clearTimeout(timer); deadlines.delete(timer); }
    };
    const lock = Store.prototype.lockedGoalLoop;
    let attempts = 0;
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(Store.prototype, "lockedGoalLoop").mockImplementation(async function (this: Store, id, action) {
      const ordinal = id === loopId ? ++attempts : 0;
      if (ordinal === 2) attempted();
      return lock.call(this, id, async () => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        try {
          if (ordinal === 1) { entered(); await bounded(released); }
          return await action();
        } finally { inFlight -= 1; }
      });
    });
    const firstTurn = call("goal_loop", { ...owner, loopId, completed: ["first concurrent item"] });
    let secondTurn: ReturnType<typeof call> | undefined;
    try {
      await bounded(firstEntered);
      secondTurn = call("goal_loop", { ...owner, loopId, completed: ["second concurrent item"] });
      await bounded(secondAttempted);
      release();
      const results = await Promise.all([firstTurn, secondTurn]);
      // Soft assertions also expose turn/progress loss if lock exclusion regresses.
      expect.soft(peak).toBe(1);
      expect.soft(results.map((result) => ({ error: result.error, turn: result.data.turn })).sort((a, b) => a.turn - b.turn)).toEqual([{ error: false, turn: 2 }, { error: false, turn: 3 }]);
      expect.soft((await new Store(ctx.stateDir).getSession()).workSessions.source?.ws_concurrent_evidence?.taskState.completed.toSorted()).toEqual(["first concurrent item", "second concurrent item"]);
      const checkpoint = JSON.parse(await fs.readFile(path.join(ctx.stateDir, "goals", loopId + ".loop.json"), "utf8"));
      expect.soft(checkpoint).toMatchObject({ revision: 3, totalTurns: 3, taskState: { completed: expect.arrayContaining(["first concurrent item", "second concurrent item"]) } });
    } finally {
      release();
      await Promise.allSettled([firstTurn, ...(secondTurn ? [secondTurn] : [])]);
      for (const timer of deadlines) clearTimeout(timer);
    }
  });

  it("native-evolution R1 pins active full contracts beyond the recent-session cap and serializes concurrent turns", async () => {
    const owner = { projectId: "source", workSessionId: "ws_pinned" };
    const goal = "Pinned full requirement ".repeat(100);
    const first = await call("goal_loop", { ...owner, goal, mode: "research", pending: ["owned pending"] });
    for (let index = 0; index < 21; index += 1) {
      expect((await call("goal_loop", { projectId: "source", workSessionId: "ws_other_" + index, goal: "Other goal " + index, mode: "research" })).error).toBe(false);
    }
    const context = (await new Store(ctx.stateDir).getSession()).workSessions.source?.ws_pinned;
    expect(context?.taskState).toMatchObject({ currentGoal: goal.trim(), pending: ["owned pending"] });
    const results = await Promise.all(["first", "second"].map((summary) => call("goal_loop", { ...owner, loopId: first.data.loopId, completed: [summary] })));
    expect(results.every((result) => !result.error)).toBe(true);
    expect(results.map((result) => result.data.turn).sort()).toEqual([2, 3]);
    expect((await new Store(ctx.stateDir).getSession()).workSessions.source?.ws_pinned?.taskState.completed.toSorted()).toEqual(["first", "second"]);
  }, 30000);

  it.each(["manifest", "wrong-owner", "older-pass-timeout"])("native-evolution R10 rejects %s proof through the existing workspace observer", async (kind) => {
    const { projectId, commandId, terminal } = await prepare();
    const verified = await call("task_workspace", { action: "verify", projectId, commandId });
    expect(verified.error).toBe(false);
    const taskRoot = path.join(ctx.stateDir, "task-workspaces", projectId, "merged");
    if (kind === "manifest") await fs.writeFile(path.join(taskRoot, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs --changed" } }));
    if (kind === "older-pass-timeout") {
      await fs.writeFile(path.join(taskRoot, "check.cjs"), "require('node:net').createServer().listen(0, '127.0.0.1');");
      const timedOut = await call("task_workspace", { action: "verify", projectId, commandId, timeoutSec: 1 });
      expect(timedOut.error || timedOut.data.workspace?.verification?.passed === false).toBe(true);
    }
    const rejected = kind === "wrong-owner"
      ? await call("goal_loop", { ...terminal, workSessionId: "ws_foreign" })
      : await call("goal_loop", terminal);
    expect(rejected.error).toBe(true);
    expect(rejected.data).toMatchObject({ terminal: false, continueRequired: true });
    await expect(fs.stat(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20000);

  it.each([
    { taskOwner: false, differentProject: false, differentSession: true },
    { taskOwner: false, differentProject: true, differentSession: false },
    { taskOwner: false, differentProject: true, differentSession: true },
    { taskOwner: true, differentProject: true, differentSession: false },
    { taskOwner: true, differentProject: true, differentSession: true },
  ])("rejects foreign loop ownership before persistence", async ({ taskOwner, differentProject, differentSession }) => {
    // Given an owned loop and an independent caller's persisted continuation.
    const ownerSession = "ws_owner";
    const callerSession = differentSession ? "ws_caller" : ownerSession;
    const created = taskOwner
      ? await call("task_workspace", { action: "create", projectId: "source", workSessionId: ownerSession, goal: "Owned task" })
      : null;
    if (created) expect(created.error).toBe(false);
    const ownerProject = created ? String(created.data.projectId) : "source";
    let callerProject = ownerProject;
    if (differentProject) {
      const selected = await call("project_select", { projectId: "source", reason: "Create independent fixture", preset: "full-write", confirmSwitch: true });
      expect(selected.error, JSON.stringify(selected.data)).toBe(false);
      if (taskOwner && !differentSession) {
        // A task session cannot own two private checkouts; use its source as the foreign project.
        callerProject = "source";
      } else {
        const other = await call("task_workspace", { action: "create", projectId: "source", workSessionId: callerSession, goal: "Independent task" });
        expect(other.error, JSON.stringify(other.data)).toBe(false);
        callerProject = String(other.data.projectId);
      }
    }
    const intake = await call("goal_intake", { projectId: ownerProject, workSessionId: ownerSession, goal: "Preserve owned history" });
    expect(intake.error).toBe(false);
    expect((await call("goal_intake", { projectId: callerProject, workSessionId: callerSession, goal: "Independent caller history" })).error).toBe(false);
    await new Store(ctx.stateDir).updateSession((session) => {
      const task = session.workSessions[callerProject]?.[callerSession]?.taskState;
      if (!task) throw new Error("Missing caller fixture task");
      task.continuation = { jobId: "a".repeat(64), status: "ready-to-resume", updatedAt: 1 };
      return session;
    });
    const before = await snapshot(ctx.stateDir);

    // When the foreign caller explicitly resumes the owner's global loop ID.
    const rejected = await call("goal_loop", { projectId: callerProject, workSessionId: callerSession,
      loopId: intake.data.loopId, lastResult: "Foreign progress", mode: "research" });

    // Then neither the owner's history nor caller/session/role state changes.
    expect.soft(rejected.error).toBe(true);
    expect(await snapshot(ctx.stateDir)).toEqual(before);
  });

  it.each([
    "malformed", "null", "array", "missing-turns", "non-array-turns", "invalid-turn",
    "invalid-project", "invalid-session", "invalid-mode", "invalid-profile", "invalid-preview", "wrong-loop-id",
  ])("preserves corrupt loop bytes on resume", async (kind) => {
    // Given malformed or structurally invalid persisted history after reconnect.
    const identity = { projectId: "source", workSessionId: "ws_corrupt" };
    const intake = await call("goal_intake", { ...identity, goal: "Preserve corrupt history" });
    expect(intake.error).toBe(false);
    const loopId = String(intake.data.loopId);
    const loopFile = path.join(ctx.stateDir, "goals", `${loopId}.loop.json`);
    const valid = { loopId, ...identity, turns: [] };
    const corruptions: Record<string, string> = {
      malformed: '{"loopId":', null: "null", array: "[]",
      "missing-turns": JSON.stringify({ loopId, ...identity }),
      "non-array-turns": JSON.stringify({ ...valid, turns: {} }),
      "invalid-turn": JSON.stringify({ ...valid, turns: [null, 1, []] }),
      "invalid-project": JSON.stringify({ ...valid, projectId: 1 }),
      "invalid-session": JSON.stringify({ ...valid, workSessionId: 1 }),
      "invalid-mode": JSON.stringify({ ...valid, mode: "invalid" }),
      "invalid-profile": JSON.stringify({ ...valid, executionProfile: false }),
      "invalid-coordination-mode": JSON.stringify({ ...valid, coordinationMode: "invalid" }),
      "invalid-preview": JSON.stringify({ ...valid, goalPreview: {} }),
      "wrong-loop-id": JSON.stringify({ ...valid, loopId: "another-loop" }),
    };
    await fs.writeFile(loopFile, corruptions[kind]);
    await new Store(ctx.stateDir).updateSession((session) => {
      const task = session.workSessions.source?.ws_corrupt?.taskState;
      if (!task) throw new Error("Missing corrupt fixture task");
      task.continuation = { jobId: "a".repeat(64), status: "ready-to-resume", updatedAt: 1 };
      return session;
    });
    await client.close(); await server.close();
    ctx.store = new Store(ctx.stateDir);
    await connect();
    const before = await snapshot(ctx.stateDir);

    // When resuming the matching owner, corruption must not mean absence.
    const rejected = await call("goal_loop", { ...identity, loopId, lastResult: "Do not replace history", mode: "research" });

    // Then the entire persisted fixture, including corrupt bytes, is untouched.
    expect.soft(rejected.error).toBe(true);
    expect(await snapshot(ctx.stateDir)).toEqual(before);
  });

  it("preserves state when persisted loop history cannot be read", async () => {
    const identity = { projectId: "source", workSessionId: "ws_unreadable" };
    const intake = await call("goal_intake", { ...identity, goal: "Preserve unreadable history" });
    expect(intake.error).toBe(false);
    const loopId = String(intake.data.loopId);
    const loopFile = path.join(ctx.stateDir, "goals", `${loopId}.loop.json`);
    await fs.unlink(loopFile);
    await fs.mkdir(loopFile);
    await fs.writeFile(path.join(loopFile, "evidence"), "not an absent loop");
    const before = await snapshot(ctx.stateDir);
    const rejected = await call("goal_loop", { ...identity, loopId, mode: "research" });
    expect(rejected.error).toBe(true);
    expect(await snapshot(ctx.stateDir)).toEqual(before);
  });

  it("resumes matching ownership and reconstructs absent history without replacing a new loop contract", async () => {
    const identity = { projectId: "source", workSessionId: "ws_matching" };
    const intake = await call("goal_intake", { ...identity, goal: "Original goal" });
    expect(intake.error).toBe(false);
    const loopId = String(intake.data.loopId);
    const loopFile = path.join(ctx.stateDir, "goals", `${loopId}.loop.json`);
    const first = await call("goal_loop", { ...identity, loopId, lastResult: "First progress" });
    expect(first.error).toBe(false);
    expect(first.data).toMatchObject({ loopId, workSessionId: identity.workSessionId, turn: 1 });
    const second = await call("goal_loop", { projectId: identity.projectId, loopId, lastResult: "Inferred owner" });
    expect(second.error).toBe(false);
    expect(second.data).toMatchObject({ loopId, workSessionId: identity.workSessionId, turn: 2 });
    await fs.unlink(loopFile);
    const reconstructed = await call("goal_loop", identity);
    expect(reconstructed.error).toBe(false);
    expect(reconstructed.data).toMatchObject({ loopId, workSessionId: identity.workSessionId, turn: 1 });
    expect(JSON.parse(await fs.readFile(loopFile, "utf8"))).toMatchObject({ ...identity, goalPreview: "Original goal" });
    const beforeNew = await fs.readFile(loopFile);
    const fresh = await call("goal_loop", { ...identity, newLoop: true, goal: "Explicitly separate goal" });
    expect(fresh.error).toBe(false);
    expect(fresh.data.loopId).not.toBe(loopId);
    expect(fresh.data.turn).toBe(1);
    expect(await fs.readFile(loopFile)).toEqual(beforeNew);
    const absent = await call("goal_loop", { projectId: "source", workSessionId: "ws_absent", loopId: "loop-absent-history", goal: "New absent history" });
    expect(absent.error).toBe(false);
    expect(absent.data).toMatchObject({ loopId: "loop-absent-history", workSessionId: "ws_absent", turn: 1 });
  });

  it("routes existing file/command/checkpoint/goal tools into the task, verifies, reviews and publishes", async () => {
    const created = await call("task_workspace", { action: "create", projectId: "source", workSessionId: "ws_mcp", goal: "Add a text file" });
    expect(created.error).toBe(false);
    const projectId = created.data.projectId;
    expect(projectId).toMatch(/^jk-task-/);
    expect(created.data.externalModelRequired).toBe(false);
    const intake = await call("goal_intake", { projectId, goal: "Add a text file" });
    expect(intake.data.workSessionId).toBe("ws_mcp");
    const write = await call("file_create", { projectId, workSessionId: "ws_mcp", path: "new.txt", content: "isolated content" });
    expect(write.error).toBe(false);
    await expect(fs.stat(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const read = await call("file_read_slice", { projectId, path: "new.txt", start: 1, end: 10 });
    expect(read.error).toBe(false);
    expect(JSON.stringify(read.data)).toContain("isolated content");
    const checkpoints = await call("checkpoint_list", { projectId });
    expect(checkpoints.error).toBe(false);
    const commands = await call("command_list", { projectId });
    expect(commands.error).toBe(false);
    const commandId = commands.data.commands.find((item: any) => item.riskTier === "verify").commandId;
    const terminal = { projectId, loopId: intake.data.loopId, workSessionId: "ws_mcp", phase: "release", verificationStatus: "pass", reviewVerdict: "approve", pending: [] };
    expect((await call("goal_loop", terminal)).error).toBe(true);
    const verified = await call("task_workspace", { action: "verify", projectId, commandId });
    expect(verified.error).toBe(false);
    expect(verified.data.workspace.verificationCurrent).toBe(true);
    const release = await call("goal_loop", { ...terminal, maxTurns: 1 });
    expect(release.error).toBe(false);
    expect(release.data).toMatchObject({ terminal: false, terminalStatus: null, terminalPushResult: null, continueRequired: true,
      nextCall: { toolName: "task_workspace", input: { action: "publish", projectId, verificationId: verified.data.workspace.verification.id }, needs: ["reviewSummary"] } });
    expect(release.data.taskState.pending).toEqual([]);
    await expect(fs.stat(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const published = await call("task_workspace", { action: "publish", projectId, verificationId: verified.data.workspace.verification.id, reviewSummary: "Reviewed the new text file and passing test output" });
    expect(published.error).toBe(false);
    expect(published.data.workspace.status).toBe("published");
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("isolated content");
  });

  it("acknowledges published delivery repeatedly and after reconnect without changing durable bytes", async () => {
    const { projectId, commandId, terminal } = await prepare();
    await verifyAndPublish(projectId, commandId);
    // A stale continuation must not be reconciled or consumed by this read-only path.
    const store = new Store(ctx.stateDir);
    await store.updateSession((session) => {
      const task = session.workSessions[projectId]?.ws_completion?.taskState;
      if (!task) throw new Error("Missing fixture task state");
      task.continuation = { jobId: "a".repeat(64), status: "ready-to-resume", updatedAt: 1 };
      return session;
    });
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ack = await call("goal_loop", terminal);
      expect(ack.error).toBe(false);
      expect(ack.data).toMatchObject({ projectId, workSessionId: "ws_completion", loopId: terminal.loopId,
        terminal: true, terminalStatus: "succeeded", continueRequired: false, nextActions: [], terminalPushResult: null });
      expect(ack.data.taskContinuation).toBeUndefined();
      expect(await snapshot()).toEqual(before);
    }
    await client.close(); await server.close();
    ctx.registry = []; ctx.store = new Store(ctx.stateDir);
    await connect();
    expect((await call("goal_loop", terminal)).data.terminal).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("delivered");
  });

  it("denies wrong identities and every published progress or permission mutation read-only", async () => {
    const { projectId, commandId, terminal } = await prepare();
    await verifyAndPublish(projectId, commandId);
    const before = await snapshot();
    for (const change of [
      { workSessionId: "ws_other" }, { workSessionId: undefined }, { loopId: "wrong-loop" }, { loopId: undefined },
      { newLoop: true }, { goal: "replacement" }, { currentTask: "mutation" }, { completed: ["mutation"] },
      { lastResult: "mutation" }, { decisions: [] }, { safety: { executionKind: "workspace" } },
      { pending: ["unfinished"] }, { pending: undefined }, { reviewVerdict: "reject" }, { verificationStatus: "blocked" },
      { mode: "plan" }, { maxTurns: 50 }, { failureCount: 0 }, { fanoutCandidates: [] },
    ]) {
      expect((await call("goal_loop", { ...terminal, ...change })).error, JSON.stringify(change)).toBe(true);
      expect(await snapshot()).toEqual(before);
    }
    for (const [name, input] of [
      ["file_create", { projectId, path: "forbidden.txt", content: "no" }],
      ["project_select", { projectId, reason: "no reselect", preset: "full-write" }],
      ["goal_intake", { projectId, goal: "replacement" }],
    ] as const) {
      expect((await call(name, input)).error).toBe(true);
      expect(await snapshot()).toEqual(before);
    }
  });

  it.each(["missing", "stale", "failed", "source-drift"])("never terminates an unpublished task with %s proof or blocked/empty pending", async (kind) => {
    const { projectId, commandId, terminal } = await prepare();
    if (kind === "failed") {
      const read = await call("file_read_slice", { projectId, path: "check.cjs", start: 1, end: 10 });
      expect(read.error).toBe(false);
      // Owned fixture setup; run the real discovered verifier, not a mocked proof.
      await fs.writeFile(path.join(ctx.stateDir, "task-workspaces", projectId, "merged", "check.cjs"), "process.exit(1);");
    }
    const verified = kind === "missing" ? null : await call("task_workspace", { action: "verify", projectId, commandId });
    if (kind === "stale") expect((await call("file_create", { projectId, path: "later.txt", content: "invalidates proof" })).error).toBe(false);
    if (kind === "source-drift") await fs.writeFile(path.join(root, "notes.txt"), "owner changed source");
    const rejected = await call("task_workspace", { action: "publish", projectId, verificationId: verified?.data.workspace.verification.id ?? "missing", reviewSummary: "Reviewed fixture" });
    expect(rejected.error).toBe(true);
    expect(rejected.data).toMatchObject({ terminal: false, terminalStatus: null, continueRequired: true,
      nextCall: { toolName: "task_workspace", input: { action: "status", projectId } } });
    const release = await call("goal_loop", terminal);
    expect(release.error).toBe(kind !== "source-drift");
    expect(release.data).toMatchObject({ terminal: false, terminalStatus: null, continueRequired: true });
    const blocked = await call("goal_loop", { ...terminal, verificationStatus: "blocked", maxTurns: 1 });
    expect(blocked.error).toBe(false);
    expect(blocked.data).toMatchObject({ terminal: false, terminalStatus: null, terminalPushResult: null, continueRequired: true });
    expect(blocked.data.nextCall.input.action).toBe("status");
    await expect(fs.stat(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "source-drift") expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("owner changed source");
  });

  it("does not treat published source as runtime proof or clear persisted pending", async () => {
    const { projectId, commandId, terminal } = await prepare("Add a text file and restart the service");
    expect((await call("goal_loop", { projectId, loopId: terminal.loopId, workSessionId: terminal.workSessionId, pending: ["runtime proof"] })).error).toBe(false);
    await verifyAndPublish(projectId, commandId);
    const before = await snapshot();
    const ack = await call("goal_loop", terminal);
    expect(ack.error).toBe(false);
    expect(ack.data).toMatchObject({ terminal: false, terminalStatus: null, continueRequired: true, terminalBlockedBySafety: true });
    expect(ack.data.safetyGate.terminalBlockers).toContain("runtime-proof-status");
    expect(ack.data.nextActions.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["archive", "discard"])("denies completion for a task after %s", async (action) => {
    const { projectId, terminal } = await prepare();
    const status = await call("task_workspace", { action: "status", projectId });
    expect((await call("task_workspace", { action, projectId, confirmDiscard: true, expectedFingerprint: status.data.workspace.fingerprint })).error).toBe(false);
    expect((await call("goal_loop", terminal)).error).toBe(true);
  });

  it("survives server restart/index refresh and refuses stale task/session IDs", async () => {
    const created = await call("task_workspace", { action: "create", projectId: "source", workSessionId: "ws_restart", goal: "Continue this task" });
    expect(created.error).toBe(false);
    const projectId = created.data.projectId;
    expect((await call("file_create", { projectId, workSessionId: "ws_other", path: "wrong.txt", content: "wrong" })).error).toBe(true);
    expect((await call("workspace_refresh_index", {})).error).toBe(false);
    expect((await call("project_select", { projectId, reason: "continue", preset: "full-write" })).data.workSessionId).toBe("ws_restart");
    await client.close(); await server.close();
    ctx.registry = [];
    ctx.store = new Store(ctx.stateDir);
    await connect();
    expect((await call("file_read_slice", { projectId, path: "notes.txt", start: 1, end: 1 })).error).toBe(false);
    expect((await call("task_workspace", { action: "archive", projectId })).error).toBe(false);
    expect((await call("file_read_slice", { projectId, path: "notes.txt", start: 1, end: 1 })).error).toBe(true);
    // The source's identity may be rediscovered by scanner; resolve by its root.
    const entries = await ctx.store.loadProjects();
    const sourceId = entries.find((entry) => entry.root === root)!.projectId;
    expect((await call("project_select", { projectId: sourceId, reason: "resume task", preset: "full-write" })).error).toBe(false);
    // This fixture's source id is preserved when scanning the root directory.
    const resumed = await call("task_workspace", { action: "resume", projectId });
    expect(resumed.error).toBe(false);
    expect(resumed.data.projectId).toBe(projectId);
    expect((await call("task_workspace", { action: "discard", projectId, confirmDiscard: true })).error).toBe(true);
  });
});
