import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scanWorkspace, scanWorkspaceWithRuntimeSelf } from "./registry.js";
import { runExecutorWorker } from "../executors/worker.js";
import { createRuntimeIdentity, deriveRemoteExecutionTarget, RuntimeIdentitySchema } from "../executors/target-protocol.js";
import type { ProjectRegistryEntry } from "../types.js";

const measurements = vi.hoisted(() => ({ gitCalls: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const nativeAsync = promisify(actual.execFile);
  const measuredAsync = vi.fn(nativeAsync).mockImplementation((...args) => {
    if (args[0] === "git") measurements.gitCalls += 1;
    return nativeAsync(...args);
  });
  const measured = vi.fn(actual.execFile);
  Object.defineProperty(measured, promisify.custom, { value: measuredAsync });
  return { ...actual, execFile: measured };
});

const run = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "jk-registry-performance-"));
  const project = path.join(root, "sample");
  await mkdir(project);
  await run("git", ["init", "-q"], { cwd: project });
  await run("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-q", "-m", "fixture",
  ], { cwd: project });
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "sample-alias" }));
  await writeFile(path.join(project, "AGENTS.md"), "fixture rules");
  await writeFile(path.join(project, "sample.txt"), "performance-fixture\n");
  vi.stubEnv("JK_RUNTIME_MODE", "portable");
  measurements.gitCalls = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("registry metadata cost", () => {
  it("discovers current project identities without Git subprocesses when metadata is disabled", async () => {
    // Given a real Git project with an alias and rule metadata.
    // When only discovery and identity data are requested.
    const entries = await scanWorkspace(root, { includeGitMetadata: false });

    // Then discovery remains complete without running unrelated Git queries.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      projectId: "sample", root: path.join(root, "sample"),
      aliases: expect.arrayContaining(["sample", "sample-alias"]),
      packageHints: ["node"], hasAgentsMd: true,
    });
    expect(measurements.gitCalls).toBe(0);
  });

  it("preserves nested discovery, aliases and runtime-self collisions while default scans retain Git metadata", async () => {
    // Given a nested project and a hidden development runtime with a colliding ID.
    const nested = path.join(root, "sample", "projects", "nested");
    const runtime = path.join(root, ".runtime", "sample");
    await mkdir(nested, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(nested, "package.json"), JSON.stringify({ name: "nested-alias" }));
    await writeFile(path.join(runtime, "package.json"), JSON.stringify({ name: "runtime-alias" }));
    await run("git", ["init", "-q"], { cwd: runtime });
    const full = await scanWorkspaceWithRuntimeSelf(root, runtime, "development");
    expect(measurements.gitCalls).toBeGreaterThan(0);
    expect(full.find((entry) => entry.projectId === "sample")).toMatchObject({
      branch: expect.any(String), dirty: true,
    });
    measurements.gitCalls = 0;

    // When the same discovery, including the runtime-self scan, omits Git metadata.
    const light = await scanWorkspaceWithRuntimeSelf(root, runtime, "development", { includeGitMetadata: false });

    // Then only Git metadata and observation timestamps differ.
    const discovery = (entries: ProjectRegistryEntry[]) =>
      entries.map(({ branch: _branch, dirty: _dirty, lastSeenAt: _seen, ...identity }) => identity);
    expect(discovery(light)).toEqual(discovery(full));
    expect(light.map((entry) => entry.projectId)).toEqual(["sample", "nested", "jk-self"]);
    expect(light.every((entry) => entry.branch === undefined && entry.dirty === undefined)).toBe(true);
    expect(measurements.gitCalls).toBe(0);
  });

  it("keeps worker reads cheap while startup, post-job heartbeat and project status retain live Git metadata", async () => {
    // Given the real worker and filesystem, with only transport and clock controlled.
    vi.useFakeTimers({ toFake: ["Date"] });
    const projectSchema = z.object({
      projectId: z.string(), root: z.string(), branch: z.string().optional(), dirty: z.boolean().optional(),
    });
    const heartbeatSchema = RuntimeIdentitySchema.extend({ projects: z.array(projectSchema) });
    const resultSchema = z.object({ result: z.unknown(), error: z.string().optional() });
    const hub = await createRuntimeIdentity("hub", root);
    const controller = new AbortController();
    const heartbeats: Array<z.infer<typeof heartbeatSchema>> = [];
    const results: Array<z.infer<typeof resultSchema>> = [];
    const calls: number[] = [];
    const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body: unknown = JSON.parse(String(init?.body));
      if (url.endsWith("/heartbeat")) {
        const heartbeat = heartbeatSchema.parse(body);
        heartbeats.push(heartbeat);
        return response({ ok: true, hub, executor: heartbeat });
      }
      if (url.endsWith("/poll")) {
        const identity = heartbeats.at(-1);
        const project = identity?.projects.find((entry) => entry.projectId === "sample");
        if (!identity || !project) throw new Error("Expected fixture heartbeat before job delivery");
        measurements.gitCalls = 0;
        return response({ job: {
          jobId: `job-${results.length}`, executorId: "performance-worker", protocolVersion: 1,
          runtime: identity, executionTarget: deriveRemoteExecutionTarget(identity, project),
          tool: results.length === 0 ? "file_read_slice" : "project_status", createdAt: Date.now(),
          payload: { sourceProjectId: "sample", path: "sample.txt", start: 1, end: 1 },
        } });
      }
      results.push(resultSchema.parse(body));
      calls.push(measurements.gitCalls);
      if (results.length === 1) vi.setSystemTime(Date.now() + 3001);
      else controller.abort();
      return response({ ok: true });
    }));

    // When a read is followed by a scheduled heartbeat and explicit status query.
    try {
      await runExecutorWorker({
        hubUrl: "http://fixture.invalid", executorToken: "fixture", executorId: "performance-worker",
        workspaceRoot: root, heartbeatMs: 3000, signal: controller.signal,
      });
    } finally {
      controller.abort();
    }

    // Then read execution avoids Git, while public metadata stays fresh.
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.error === undefined)).toBe(true);
    expect(calls[0]).toBe(0);
    expect(calls[1]).toBeGreaterThan(0);
    expect(results[0]?.result).toMatchObject({
      content: "1\tperformance-fixture",
      workContextFileHash: createHash("sha256").update("performance-fixture\n").digest("hex"),
    });
    expect(results[1]?.result).toMatchObject({
      branch: expect.any(String), dirtyFiles: expect.arrayContaining(["sample.txt"]), packageHints: ["node"],
    });
    expect(heartbeats).toHaveLength(2);
    for (const heartbeat of heartbeats) {
      expect(heartbeat.projects.find((entry) => entry.projectId === "sample")).toMatchObject({
        branch: expect.any(String), dirty: true,
      });
    }
  });
});
