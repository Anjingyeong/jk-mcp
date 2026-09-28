import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp-server.js";
import { Store } from "../state/store.js";
import { git } from "../orchestration/mass-ulw-workspace-repository.js";
import { buildMassUlwPlan } from "../orchestration/mass-ulw.js";
import { MassUlwWebWorkflow } from "../orchestration/mass-ulw-web.js";
import * as commands from "../exec/command-runner.js";
import { MassUlwWorkspace } from "../orchestration/mass-ulw-workspace.js";
import type { ToolContext } from "../types.js";

describe("ChatGPT web MASS ULW turn protocol", () => {
  let temp: string, source: string, stateDir: string, taskRoot: string;
  let ctx: ToolContext, client: Client, server: Awaited<ReturnType<typeof createServer>>;
  let base: Record<string, any>;
  const privateRoots = new Set<string>();
  const candidates = [
    { id: "A", task: "Implement A", estimatedWeight: 5, writeScopes: ["src/a"] },
    { id: "B", task: "Implement B", estimatedWeight: 5, writeScopes: ["src/b"] },
    { id: "C", task: "Integrate A and B", estimatedWeight: 5, writeScopes: ["src/c"], readScopes: ["src/a", "src/b"], dependsOn: ["A", "B"] },
  ];
  const patch = (id: string, value: string) => `*** Begin Patch\n*** Add File: src/${id.toLowerCase()}/result.txt\n+${value}\n*** End Patch`;
  async function connect() {
    server = await createServer(ctx);
    client = new Client({ name: "web-mass-tests", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  }
  async function call(name: string, input: Record<string, unknown>, error = false): Promise<Record<string, any>> {
    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 120000 });
    expect(Boolean(result.isError), JSON.stringify(result.structuredContent)).toBe(error);
    return result.structuredContent as Record<string, any>;
  }
  const step = (action: string, input: Record<string, unknown> = {}, error = false) => call("mass_ulw_step", { ...base, action, ...input }, error);
  const lane = (view: Record<string, any>, id: string) => view.lanes.find((item: any) => item.id === id);
  const submission = (view: Record<string, any>, id: string, value: string, suffix = "1") => ({ laneId: id, submissionId: `${id}-${suffix}`, contextToken: lane(view, id).contextToken, patch: patch(id, value), hypothesis: "Correct the value after inspecting the failing assertion and the lane scope" });
  async function approve(view: Record<string, any>, id: string) { return step("review", { laneId: id, token: lane(view, id).proof.token, verdict: "approve", summary: `Reviewed ${id} against its task and passing verifier` }); }
  beforeEach(async () => {
    const create = MassUlwWorkspace.create;
    vi.spyOn(MassUlwWorkspace, "create").mockImplementation(async (options) => { const workspace = await create(options); privateRoots.add(workspace.privateRoot); return workspace; });
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "jk-web-mass-")); source = path.join(temp, "source"); stateDir = path.join(temp, "state");
    await fs.mkdir(source);
    await git(source, ["init", "--quiet"]); await git(source, ["config", "user.name", "JK test"]); await git(source, ["config", "user.email", "test@localhost"]);
    await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ scripts: { typecheck: "node check.cjs a", lint: "node check.cjs b", check: "node check.cjs c", test: "node check.cjs all", quick: "node -e \"process.exit(0)\"" } }));
    await fs.writeFile(path.join(source, "check.cjs"), "const fs=require('node:fs'),a=require('node:assert/strict');const read=x=>fs.readFileSync('src/'+x+'/result.txt','utf8').trim();const lane=process.argv[2];if(lane==='all'){a.equal(read('a'),'A');a.equal(read('b'),'B');a.equal(read('c'),'AB');if(fs.existsSync('src/c/final-failure.txt'))throw Error('integration failure')}else if(lane==='c'){a.equal(read('c'),read('a')+read('b'))}else{a.equal(read(lane),lane.toUpperCase())}console.log('verified '+lane);\n");
    await git(source, ["add", "."]); await git(source, ["commit", "--quiet", "-m", "baseline"]);
    const entry = { projectId: "source", root: source, name: "source", aliases: [] };
    const store = new Store(stateDir); await store.saveProjects([entry]);
    ctx = { workspaceRoot: source, stateDir, registry: [entry], ledger: { append: async () => undefined }, store, config: { workspaceRoot: source, stateDir, maxReadBytes: 10000, maxPatchBytes: 10000, defaultCommandTimeoutSec: 30, defaultLeaseTtlMs: 300000 } };
    await connect(); await call("project_select", { projectId: "source", preset: "full-write", reason: "web MASS ULW" });
    const created = await call("task_workspace", { projectId: "source", action: "create", workSessionId: "ws_web_mass", goal: "Implement A, B and their integration C" });
    taskRoot = created.root;
    base = { projectId: created.projectId, workSessionId: "ws_web_mass", loopId: "loop-web-mass", planFingerprint: buildMassUlwPlan({ executionProfile: "max", candidates }).planFingerprint };
    await call("goal_loop", { projectId: base.projectId, workSessionId: base.workSessionId, loopId: base.loopId, goal: "Implement A, B and C", executionProfile: "max", fanoutCandidates: candidates, pending: ["A", "B", "C"] });
  });
  afterEach(async () => {
    await client?.close(); await server?.close(); vi.restoreAllMocks();
    for (const root of privateRoots) await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    privateRoots.clear(); await fs.rm(temp, { recursive: true, force: true });
    await expect(fs.stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
    console.log("E_CLEANUP MCP transports closed; owned fixture and private workspaces absent");
  });
  const start = () => step("start", { laneVerificationCommandIds: { A: "npm:typecheck", B: "npm:lint", C: "npm:check" }, finalVerificationCommandId: "npm:test" });

  it.each(["exhaustion", "revise", "reconnect"] as const)("E evidence R6 %s retains the executed failure budget independently", async (edge) => {
    let view = await start();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      view = await step("submit", { submissions: [submission(view, "A", `wrong-${attempt}`, String(attempt))] });
    }
    const history = lane(view, "A").attempts;
    expect(history).toHaveLength(3);
    expect(history.every((attempt: { status: string }) => attempt.status === "failed")).toBe(true);
    if (edge === "revise") view = await step("revise", { laneId: "A", token: lane(view, "A").contextToken, summary: "Inspect the three failed assertions without changing strategy" });
    if (edge === "reconnect") {
      await client.close(); await server.close(); ctx.store = new Store(stateDir); ctx.registry = []; await connect();
      view = await step("status");
    }
    expect(lane(view, "A").attempts).toEqual(history);
    expect(lane(view, "A")).toMatchObject({ strategyGeneration: 0, failures: 3, remainingFailures: 0, readiness: "exhausted" });
    const run = vi.spyOn(commands, "runCommand");
    await step("submit", { submissions: [submission(view, "A", "A", "4")] }, true);
    expect(run).not.toHaveBeenCalled();
    expect(lane(await step("status"), "A").attempts).toEqual(history);
  }, 120000);

  it.each(["unknown", "cross-lane", "reused-approach"] as const)("E evidence R6 rejects %s strategy evidence independently through MCP", async (edge) => {
    let view = await start();
    view = await step("submit", { submissions: [submission(view, "A", "wrong"), submission(view, "B", "B")] });
    const before = await new MassUlwWebWorkflow(stateDir, base.projectId).load();
    const approach = edge === "reused-approach" ? `  ${submission(view, "A", "A").hypothesis.toUpperCase()}  ` : "Use the uppercase constant from the assertion";
    const evidence = edge === "unknown" ? "missing-attempt" : edge === "cross-lane" ? lane(view, "B").proof.token : lane(view, "A").attempts[0].attemptId;
    const run = vi.spyOn(commands, "runCommand");
    await step("revise", { laneId: "A", token: lane(view, "A").contextToken, summary: "Inspect evidence", strategy: { approach, evidence: [evidence] } }, true);
    expect(await new MassUlwWebWorkflow(stateDir, base.projectId).load()).toEqual(before);
    expect(run).not.toHaveBeenCalled();
  }, 120000);

  it("E evidence R6 changed strategy opens one generation while retaining history receipts and peer", async () => {
    let view = await start();
    view = await step("submit", { submissions: [submission(view, "A", "wrong"), submission(view, "B", "B")] });
    view = await approve(view, "B");
    const before = await new MassUlwWebWorkflow(stateDir, base.projectId).load();
    view = await step("revise", { laneId: "A", token: lane(view, "A").contextToken, summary: "Use the assertion's expected constant", strategy: { approach: "Produce the uppercase value instead of a placeholder", evidence: [before.lanes.A!.attempts[0]!.attemptId] } });
    const after = await new MassUlwWebWorkflow(stateDir, base.projectId).load();
    expect(after.lanes.A?.strategyGeneration).toBe(1);
    expect(after.lanes.A?.strategies).toHaveLength(1);
    expect(after.lanes.A?.strategies[0]).toMatchObject({ generation: 1, evidence: [before.lanes.A!.attempts[0]!.attemptId] });
    expect(after.lanes.A?.attempts).toEqual(before.lanes.A?.attempts);
    expect(after.receipts).toEqual(before.receipts); expect(after.lanes.B).toEqual(before.lanes.B);
    expect(lane(view, "A")).toMatchObject({ failures: 0, remainingFailures: 3 });
    view = await step("submit", { submissions: [submission(view, "A", "A", "2")] });
    expect(lane(view, "A").proof.passed).toBe(true);
    expect(lane(view, "A").attempts[1]).toMatchObject({ strategyGeneration: 1, status: "passed" });
  }, 120000);

  it("E evidence R6 duplicate submission has zero patch verifier and persistence effects", async () => {
    let view = await start();
    const item = submission(view, "A", "A");
    view = await step("submit", { submissions: [item] });
    expect(lane(view, "A").proof.passed).toBe(true);
    const file = path.join(taskRoot, "..", "mass-ulw-web.json"), bytes = await fs.readFile(file);
    const run = vi.spyOn(commands, "runCommand");
    const patches = await import("../code/patch.js");
    const apply = vi.spyOn(patches, "applyPatch");
    const repeated = await step("submit", { submissions: [item] });
    expect(run).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    expect(lane(repeated, "A").proof).toEqual(lane(view, "A").proof);
    expect(await fs.readFile(file)).toEqual(bytes);
  }, 120000);

  it("native-evolution R6 prefers untouched independent work and retains repair exhaustion across revise and reconnect", async () => {
    let view = await start();
    view = await step("submit", { submissions: [submission(view, "A", "wrong-1")] });
    expect(view.nextCall.needs[0].submissions[0].laneId).toBe("B");
    expect(view.readyLaneIds).toEqual(["B", "A"]);
    expect(lane(view, "C").readiness).toBe("dependency-blocked");
    view = await step("submit", { submissions: [submission(view, "B", "B")] });
    view = await approve(view, "B");
    const peer = lane(view, "B");
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      view = await step("revise", { laneId: "A", token: lane(view, "A").contextToken, summary: "Assertion output proves the expected uppercase value is still missing" });
      view = await step("submit", { submissions: [submission(view, "A", `wrong-${attempt}`, String(attempt))] });
    }
    await client.close(); await server.close(); ctx.store = new Store(stateDir); await connect();
    view = await step("status");
    expect(view.role).toBe("blocked"); expect(view.reasonCode).toBe("repair-exhausted");
    expect(lane(view, "A").attempts).toHaveLength(3);
    expect(lane(view, "A").attempts.every((item: { status: string; failureSignature: string; approachHash: string }) => item.status === "failed" && item.failureSignature && item.approachHash)).toBe(true);
    expect(lane(view, "B").proof).toEqual(peer.proof);
    view = await step("revise", { laneId: "A", token: lane(view, "A").contextToken, summary: "Retry with the same strategy after inspecting assertions" });
    const verifier = vi.spyOn(commands, "runCommand");
    await step("submit", { submissions: [submission(view, "A", "A", "4")] }, true);
    expect(verifier).not.toHaveBeenCalled();
    // The producer's typed revise contract is also usable before tools.ts wires its additive fields.
    const { executeWebMassStep } = await import("./mass-ulw-web-tool.js");
    const revise = { action: "revise", projectId: base.projectId, loopId: base.loopId, workSessionId: base.workSessionId, planFingerprint: base.planFingerprint,
      laneId: "A", token: lane(view, "A").contextToken, summary: "Inspect failure" } as const;
    await expect(executeWebMassStep(ctx, { ...revise, strategy: { approach: "Different approach", evidence: [peer.proof.token] } }, async () => true)).rejects.toMatchObject({ code: "WORKSPACE_NOT_READY" });
    await expect(executeWebMassStep(ctx, { ...revise, strategy: { approach: submission(view, "A", "A").hypothesis, evidence: [lane(view, "A").attempts[2].attemptId] } }, async () => true)).rejects.toMatchObject({ code: "WORKSPACE_NOT_READY" });
    await executeWebMassStep(ctx, { action: "revise", projectId: base.projectId, loopId: base.loopId, workSessionId: base.workSessionId, planFingerprint: base.planFingerprint,
      laneId: "A", token: lane(view, "A").contextToken, summary: "Use assertion's uppercase expected value", strategy: { approach: "Produce uppercase constants rather than numbered placeholders", evidence: [lane(view, "A").attempts[2].attemptId] } }, async () => true);
    view = await step("status"); expect(lane(view, "A").strategyGeneration).toBe(1);
    const corrected = submission(view, "A", "A", "4");
    view = await step("submit", { submissions: [corrected] });
    const token = lane(view, "A").proof.token;
    expect(verifier).toHaveBeenCalledTimes(1);
    view = await step("submit", { submissions: [corrected] });
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(lane(view, "A").proof.token).toBe(token); expect(lane(view, "A").attempts).toHaveLength(4);
    expect(lane(view, "B").artifact).toBe(peer.artifact);
  }, 240000);

  const Context = z.object({
    view: z.enum(["baseline", "submitted"]), baselineCommit: z.string(), diff: z.string(),
    files: z.array(z.object({ path: z.string(), exists: z.boolean().optional(), content: z.string().optional(), hash: z.string().optional() })),
  });
  function expectContribution(value: unknown, file: string, bytes: string) {
    const context = Context.parse(value);
    const changedPaths = [...context.diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gmu)].map((match) => match[2]);
    const addedLines = context.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1));
    expect(changedPaths).toEqual([file]);
    expect(addedLines).toEqual([bytes]);
    expect(context.files.find((item) => item.path === file)).toMatchObject({ content: bytes, hash: createHash("sha256").update(bytes).digest("hex") });
    expect(context.view).toBe("submitted");
    return context;
  }

  it("retains independent and dependent contributions on submitted cache misses and reconnects", async () => {
    // Given: a submitted request is valid even before an artifact exists.
    let view = await start();
    const empty = Context.parse((await step("context", { laneId: "A", contextView: "submitted", paths: ["src/a/result.txt"] })).context);
    expect(empty.diff).toBe(""); expect(empty.files).toEqual([{ path: "src/a/result.txt", exists: false }]);
    view = await step("submit", { submissions: [submission(view, "A", "A"), submission(view, "B", "B")] });
    expectContribution(view.context, "src/a/result.txt", "A");
    await client.close(); await server.close(); ctx.registry = []; ctx.store = new Store(stateDir); await connect();

    // When: explicit paths miss the immediate default cache after reconstruction.
    const request = { laneId: "A", contextView: "submitted", paths: ["src/a/result.txt"] };
    const rebuilt = expectContribution((await step("context", request)).context, "src/a/result.txt", "A");

    // Then: the contribution, baseline and persisted cache retain distinct meanings.
    const baseline = Context.parse((await step("context", { ...request, contextView: "baseline" })).context);
    expect(baseline.baselineCommit).toBe(rebuilt.baselineCommit);
    expect(baseline.diff).toBe(""); expect(baseline.files).toEqual([{ path: "src/a/result.txt", exists: false }]);
    await client.close(); await server.close(); ctx.registry = []; ctx.store = new Store(stateDir); await connect();
    expect(Context.parse((await step("context", request)).context)).toEqual(rebuilt);
    view = await approve(view, "A"); view = await approve(view, "B");
    const dependentInput = { laneId: "C", contextView: "submitted", paths: ["src/a/result.txt", "src/b/result.txt", "src/c/result.txt"] };
    const beforeC = Context.parse((await step("context", dependentInput)).context);
    expect(beforeC.diff).toBe("");
    expect(beforeC.files.map((file) => [file.path, file.content ?? file.exists])).toEqual([["src/a/result.txt", "A"], ["src/b/result.txt", "B"], ["src/c/result.txt", false]]);
    view = await step("submit", { submissions: [submission(view, "C", "AB")] });
    const submittedC = expectContribution((await step("context", dependentInput)).context, "src/c/result.txt", "AB");
    expect(submittedC.baselineCommit).toBe(beforeC.baselineCommit);
    const baselineC = Context.parse((await step("context", { ...dependentInput, contextView: "baseline" })).context);
    expect(baselineC.files).toEqual(beforeC.files); expect(baselineC.diff).toBe("");
    expect(baselineC.baselineCommit).toBe(beforeC.baselineCommit);
    await expect(fs.stat(path.join(taskRoot, "src"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 240000);

  it("ignores legacy derived context entries without deleting persisted workflow or artifacts", async () => {
    // Given: an old installation persisted the erroneous empty submitted diff.
    let view = await start();
    view = await step("submit", { submissions: [submission(view, "A", "A")] });
    const doc = await new MassUlwWebWorkflow(stateDir, base.projectId).load();
    const paths = ["src/a/result.txt"];
    const key = createHash("sha256").update(JSON.stringify([doc.runId, doc.baseline, "A", [], doc.lanes.A?.artifact, true, paths, undefined])).digest("hex");
    const directory = path.dirname(taskRoot);
    const legacyFile = path.join(directory, `mass-context-${key}.json`);
    const stale = JSON.stringify({ ...Context.parse(view.context), diff: "", baselineCommit: "0".repeat(40) });
    await fs.writeFile(legacyFile, stale);
    await client.close(); await server.close(); ctx.registry = []; ctx.store = new Store(stateDir); await connect();

    // When: the same public request encounters the old cache key.
    const rebuilt = expectContribution((await step("context", { laneId: "A", contextView: "submitted", paths })).context, "src/a/result.txt", "A");

    // Then: only the derived cache namespace migrates; durable user state survives.
    expect(rebuilt.baselineCommit).not.toBe("0".repeat(40));
    expect(Context.parse(JSON.parse(await fs.readFile(path.join(directory, `mass-context-v2-${key}.json`), "utf8")))).toEqual(rebuilt);
    expect(await fs.readFile(legacyFile, "utf8")).toBe(stale);
    expect(await new MassUlwWebWorkflow(stateDir, base.projectId).load()).toEqual(doc);
  }, 240000);

  it("repairs one failed lane, preserves its peer, resumes, uses accepted dependency context, and publishes only after reviews", async () => {
    let view = await start();
    expect(view.role).toBe("implementer"); expect(view.context).toBeDefined();
    const shortcut = await call("task_workspace", { projectId: base.projectId, action: "verify", commandId: "npm:quick" });
    await call("task_workspace", { projectId: base.projectId, action: "publish", verificationId: shortcut.workspace.verification.id, reviewSummary: "Premature completion must be blocked" }, true);
    await call("goal_loop", { ...base, phase: "release", verificationStatus: "pass", reviewVerdict: "approve", pending: [] }, true);
    expect(lane(view, "C").ready).toBe(false);
    const batch = [submission(view, "A", "wrong"), submission(view, "B", "B")];
    view = await step("submit", { submissions: batch });
    expect(lane(view, "A").status).toBe("failed"); expect(lane(view, "A").proof.stderr).toContain("AssertionError");
    expect(lane(view, "A").revision).toBe(1); expect(lane(view, "B").status).toBe("review");
    const peerProof = lane(view, "B").proof.token;
    view = await step("submit", { submissions: batch });
    expect(lane(view, "B").proof.token).toBe(peerProof); expect(lane(view, "A").revision).toBe(1);
    await step("review", { laneId: "A", token: lane(view, "A").proof.token, verdict: "approve", summary: "should be refused" }, true);
    view = await approve(view, "B");
    await step("submit", { submissions: [submission(view, "C", "AB")] }, true);
    await client.close(); await server.close(); ctx.registry = []; ctx.store = new Store(stateDir); await connect();
    view = await step("next"); expect(view.role).toBe("repair");
    expect(lane(view, "B").status).toBe("accepted");
    const failedCode = await step("context", { laneId: "A", contextView: "submitted", paths: ["src/a/result.txt"] });
    expect(failedCode.context.files[0].content).toBe("wrong"); expect(failedCode.nextCall.input.contextView).toBe("baseline");
    view = await step("submit", { submissions: [submission(view, "A", "A", "2")] });
    view = await approve(view, "A");
    expect(view.context.files.find((file: any) => file.path === "src/a/result.txt").content).toContain("A");
    expect(view.context.files.find((file: any) => file.path === "src/b/result.txt").content).toContain("B");
    view = await step("submit", { submissions: [submission(view, "C", "AB")] }); view = await approve(view, "C");
    await expect(fs.stat(path.join(source, "src"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(taskRoot, "src"))).rejects.toMatchObject({ code: "ENOENT" });
    view = await step("integrate"); expect(view.integration.proof.passed).toBe(true);
    await step("finish", {}, true);
    view = await step("review", { token: view.integration.proof.token, verdict: "approve", summary: "Reviewed integrated A/B/C diff and final assertions" });
    view = await step("finish"); expect(view.terminal).toBe(false); expect(view.nextCall.tool).toBe("task_workspace");
    expect(view.nextCall.input.action).toBe("publish");
    const stateFile = path.join(taskRoot, "..", "mass-ulw-web.json");
    const interrupted = JSON.parse(await fs.readFile(stateFile, "utf8"));
    interrupted.integration.status = "applying"; interrupted.integration.appliedFingerprint = null;
    await fs.writeFile(stateFile, JSON.stringify(interrupted));
    view = await step("finish"); // Recover the publication receipt after a lost state write.
    const publishInput = view.nextCall.input;
    await fs.writeFile(path.join(taskRoot, "src/a/result.txt"), "changed after review");
    const otherProof = await call("task_workspace", { projectId: base.projectId, action: "verify", commandId: "npm:quick" });
    await call("task_workspace", { ...publishInput, verificationId: otherProof.workspace.verification.id }, true);
    await fs.writeFile(path.join(taskRoot, "src/a/result.txt"), "A");
    view = await step("finish");
    await call(view.nextCall.tool, view.nextCall.input);
    view = await step("status"); expect(view.terminal).toBe(true);
    expect(await fs.readFile(path.join(source, "src/c/result.txt"), "utf8")).toBe("AB");
  }, 240000);

  it("invalidates dependent work on revision, rejects stale contexts and out-of-scope patches, and keeps source edits intact", async () => {
    let view = await start();
    const staleA = submission(view, "A", "A");
    view = await step("revise", { laneId: "A", token: lane(view, "A").contextToken, summary: "Clarify implementation" });
    await step("submit", { submissions: [staleA] }, true);
    const bad = { ...submission(view, "A", "A"), patch: "*** Begin Patch\n*** Add File: outside.txt\n+wrong scope\n*** End Patch" };
    view = await step("submit", { submissions: [bad] }); expect(lane(view, "A").status).toBe("failed");
    expect(lane(view, "A").feedback).toContain("out-of-scope");
    await step("submit", { submissions: [{ ...bad, patch: patch("A", "A") }] }, true);
    view = await step("submit", { submissions: [submission(view, "A", "A", "2"), submission(view, "B", "B")] });
    view = await approve(view, "A"); view = await approve(view, "B");
    view = await step("submit", { submissions: [submission(view, "C", "AB")] }); view = await approve(view, "C");
    view = await step("revise", { laneId: "A", token: lane(view, "A").contextToken, summary: "Review requests a different A implementation" });
    expect(lane(view, "A").status).toBe("waiting"); expect(lane(view, "C").status).toBe("waiting");
    expect(lane(view, "C").proof).toBeNull(); expect(lane(view, "B").status).toBe("accepted");
    await fs.writeFile(path.join(taskRoot, "external.txt"), "external edit");
    await step("submit", { submissions: [submission(view, "A", "A", "3")] }, true);
    expect(await fs.readFile(path.join(taskRoot, "external.txt"), "utf8")).toBe("external edit");
    await expect(fs.stat(path.join(source, "src"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 240000);

  it("recovers an interrupted submission without automatically executing its persisted request", async () => {
    const view = await start();
    const peer = await step("submit", { submissions: [submission(view, "B", "B")] });
    const workflow = new MassUlwWebWorkflow(stateDir, base.projectId);
    const doc = await workflow.load();
    doc.lanes.A!.status = "running"; doc.lanes.A!.submissionId = "interrupted";
    await fs.writeFile(path.join(taskRoot, "..", "mass-ulw-web.json"), JSON.stringify(doc));
    const resumed = await step("next");
    expect(lane(resumed, "A").status).toBe("failed"); expect(lane(resumed, "A").feedback).toContain("not be executed again automatically");
    expect(lane(resumed, "B").status).toBe("review"); expect(lane(resumed, "B").proof.token).toBe(lane(peer, "B").proof.token);
    await step("context", { laneId: "A", paths: ["../../source/check.cjs"] }, true);
    await step("context", { laneId: "A", paths: [".env"] }, true);
    expect(view.externalModelRequired).toBe(false);
  }, 240000);

  it("returns final verification and review failures to the responsible lane while retaining accepted peers", async () => {
    let view = await start();
    view = await step("submit", { submissions: [submission(view, "A", "A"), submission(view, "B", "B")] });
    view = await approve(view, "A"); view = await approve(view, "B");
    const badIntegration = { ...submission(view, "C", "AB"), patch: "*** Begin Patch\n*** Add File: src/c/result.txt\n+AB\n*** Add File: src/c/final-failure.txt\n+forces final verification failure\n*** End Patch" };
    view = await step("submit", { submissions: [badIntegration] }); view = await approve(view, "C");
    view = await step("integrate"); expect(view.integration.proof.passed).toBe(false); expect(view.role).toBe("repair");
    expect(view.integration.proof.stderr).toContain("integration failure");
    await step("finish", {}, true);
    const peerToken = lane(view, "A").proof.token;
    view = await step("revise", { laneId: "C", token: lane(view, "C").contextToken, summary: "Remove the integration-only failure artifact" });
    view = await step("submit", { submissions: [submission(view, "C", "AB", "2")] }); view = await approve(view, "C");
    view = await step("integrate"); expect(view.integration.proof.passed).toBe(true);
    const fullContext = await step("context", { paths: ["src/c/result.txt"] });
    expect(fullContext.context.files[0].content).toBe("AB");
    view = await step("review", { token: view.integration.proof.token, verdict: "reject", repairLaneId: "C", summary: "Reviewer requests another C implementation" });
    expect(lane(view, "C").status).toBe("waiting"); expect(lane(view, "A").proof.token).toBe(peerToken); expect(lane(view, "B").status).toBe("accepted");
    expect(view.integration).toBeNull();
  }, 240000);
});
