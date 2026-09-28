import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

// Instrument before loading the runtime: preserve execFile's custom promisified
// stdout/stderr contract and run the actual filesystem and Git operations.
const originalExecFile = childProcess.execFile;
const originalPromisified = originalExecFile[promisify.custom];
const originalFs = new Map();
let measuring = false;
let counters = {};
function count(name) {
  if (measuring) counters[name] = (counters[name] ?? 0) + 1;
}
function measuredExecFile(...args) {
  if (args[0] === "git") count("git");
  return originalExecFile(...args);
}
measuredExecFile[promisify.custom] = (...args) => {
  if (args[0] === "git") count("git");
  return originalPromisified(...args);
};
childProcess.execFile = measuredExecFile;
for (const name of ["access", "readFile", "readdir", "realpath", "stat", "lstat"]) {
  const original = fs[name];
  originalFs.set(name, original);
  fs[name] = (...args) => {
    count(name);
    return original(...args);
  };
}
syncBuiltinESMExports();

const { runExecutorWorker } = await import("../dist/executors/worker.js");
const { createRuntimeIdentity, deriveRemoteExecutionTarget } = await import("../dist/executors/target-protocol.js");
const { scanWorkspace } = await import("../dist/workspace/registry.js");
const { Store } = await import("../dist/state/store.js");
const { createServer } = await import("../dist/server/mcp-server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const originalFetch = globalThis.fetch;
const samples = 15;
const warmup = 3;
const cases = [];
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function summarize(kind, projects, observations) {
  assert.equal(observations.length, samples);
  const latencies = observations.map((item) => item.ms).sort((a, b) => a - b);
  const meanCalls = {};
  for (const observation of observations) {
    for (const [name, value] of Object.entries(observation.calls)) {
      meanCalls[name] = (meanCalls[name] ?? 0) + value / samples;
    }
  }
  const result = {
    kind, projects, samples,
    p50Ms: +latencies[Math.ceil(samples * 0.5) - 1].toFixed(2),
    p95Ms: +latencies[Math.ceil(samples * 0.95) - 1].toFixed(2),
    meanCalls: Object.fromEntries(Object.entries(meanCalls).map(([key, value]) => [key, +value.toFixed(2)])),
  };
  cases.push(result);
  console.log("PERF_CASE", JSON.stringify(result));
}

async function measureWorker(root, projectCount) {
  const controller = new AbortController();
  const hub = await createRuntimeIdentity("hub", root);
  let advertised;
  let started;
  let completed = 0;
  let failure;
  const observations = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/heartbeat")) {
      advertised = body;
      return json({ ok: true, hub, executor: body });
    }
    if (url.endsWith("/poll")) {
      assert(advertised);
      const project = advertised.projects.find((entry) => entry.projectId === "repo-00");
      assert(project);
      const executionTarget = deriveRemoteExecutionTarget(advertised, project);
      counters = {};
      measuring = true;
      started = performance.now();
      return json({ job: {
        jobId: `read-${completed}`, executorId: "benchmark-worker",
        protocolVersion: 1, runtime: advertised, executionTarget,
        tool: "file_read_slice", createdAt: Date.now(),
        payload: { sourceProjectId: project.projectId, path: "sample.txt", start: 1, end: 1 },
      } });
    }
    if (url.endsWith("/result")) {
      const observation = { ms: performance.now() - started, calls: counters };
      measuring = false;
      if (body.error || !body.result?.content?.includes("benchmark-value")) {
        failure = new Error(JSON.stringify(body));
        controller.abort();
        return json({ ok: true });
      }
      if (completed >= warmup) observations.push(observation);
      completed += 1;
      if (completed === samples + warmup) controller.abort();
      return json({ ok: true });
    }
    throw new Error(`Unexpected benchmark endpoint: ${url}`);
  };
  try {
    await runExecutorWorker({
      hubUrl: "http://benchmark.invalid", executorToken: "isolated-fixture",
      executorId: "benchmark-worker", workspaceRoot: root, signal: controller.signal,
    });
    if (failure) throw failure;
    summarize("worker-file-read", projectCount, observations);
  } finally {
    measuring = false;
    globalThis.fetch = originalFetch;
  }
}

async function measureLocalMcp(root, projectCount) {
  const stateDir = path.join(root, ".benchmark-state");
  const registry = await scanWorkspace(root);
  const store = new Store(stateDir);
  await store.saveProjects(registry);
  const ctx = {
    workspaceRoot: root, stateDir, registry, store, ledger: { append: async () => {} },
    config: { workspaceRoot: root, stateDir, maxReadBytes: 10000, maxPatchBytes: 10000,
      defaultCommandTimeoutSec: 10, defaultLeaseTtlMs: 600000 },
  };
  const server = await createServer(ctx);
  const client = new Client({ name: "performance-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const selected = await client.callTool({
      name: "project_select", arguments: { projectId: "repo-00", preset: "full-write", reason: "benchmark fixture" },
    });
    assert.notEqual(selected.isError, true, JSON.stringify(selected));
    const observations = [];
    for (let index = 0; index < samples + warmup; index += 1) {
      counters = {};
      measuring = true;
      const started = performance.now();
      const result = await client.callTool({
        name: "file_read_slice", arguments: { projectId: "repo-00", path: "sample.txt", start: 1, end: 1 },
      });
      const observation = { ms: performance.now() - started, calls: counters };
      measuring = false;
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert(result.structuredContent?.content?.includes("benchmark-value"));
      if (index >= warmup) observations.push(observation);
    }
    summarize("local-mcp-file-read", projectCount, observations);
  } finally {
    measuring = false;
    await client.close();
    await server.close();
  }
}

try {
  for (const projectCount of [1, 8, 24]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jk-read-performance-"));
    try {
      for (let index = 0; index < projectCount; index += 1) {
        const dir = path.join(root, `repo-${String(index).padStart(2, "0")}`);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: path.basename(dir) }));
        await fs.writeFile(path.join(dir, "sample.txt"), "benchmark-value\n");
        childProcess.execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
        childProcess.execFileSync("git", [
          "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
          "-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid",
          "commit", "--allow-empty", "-q", "-m", "isolated benchmark fixture",
        ], { cwd: dir, windowsHide: true });
      }
      await measureWorker(root, projectCount);
      await measureLocalMcp(root, projectCount);
    } finally {
      measuring = false;
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  console.log("PERF_RESULT", JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch, warmup, cases,
    boundary: "Worker poll-to-result without network; local MCP in-memory transport. Real filesystem/Git; instrumented equally before and after.",
  }));
} finally {
  measuring = false;
  globalThis.fetch = originalFetch;
  childProcess.execFile = originalExecFile;
  for (const [name, original] of originalFs) fs[name] = original;
  syncBuiltinESMExports();
}
