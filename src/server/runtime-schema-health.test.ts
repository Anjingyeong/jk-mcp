import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REQUIRED_GOAL_LOOP_INPUT_FIELDS,
  getRegisteredToolSchemaHealth,
  recordRegisteredToolSchemas,
} from "./runtime-schema-health.js";

describe("runtime tool schema health", () => {
  it("treats the final review verdict as part of the required live contract", () => {
    expect(REQUIRED_GOAL_LOOP_INPUT_FIELDS).toContain("reviewVerdict");
  });

  it("marks a stale goal_loop schema incompatible and reports the missing fields", () => {
    const health = recordRegisteredToolSchemas([
      {
        name: "goal_loop",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
      },
    ]);

    expect(health.toolSchemaCompatible).toBe(false);
    expect(health.missingGoalLoopInputFields).toEqual([...REQUIRED_GOAL_LOOP_INPUT_FIELDS]);
    expect(health.toolSchemaFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts the current goal_loop contract only when all required fields are registered", () => {
    const properties = Object.fromEntries(
      REQUIRED_GOAL_LOOP_INPUT_FIELDS.map((field) => [field, { type: "object" }]),
    );
    const health = recordRegisteredToolSchemas([
      { name: "runtime_upgrade", inputSchema: { type: "object", properties: { projectId: { type: "string" } } } },
      { name: "goal_loop", inputSchema: { type: "object", properties } },
    ]);

    expect(health.toolSchemaCompatible).toBe(true);
    expect(health.missingGoalLoopInputFields).toEqual([]);
    expect(health.goalLoopInputFields).toEqual([...REQUIRED_GOAL_LOOP_INPUT_FIELDS].sort());
    expect(getRegisteredToolSchemaHealth()).toMatchObject({ toolSchemaCompatible: true });
  });
});

const coveredModules = [
  "server/tools", "server/actions", "server/runtime-schema-health", "types",
  "workspace/task-workspaces", "workspace/registry", "state/store",
  "server/mass-ulw-web-tool", "orchestration/mass-ulw-web", "orchestration/mass-ulw-web-context",
  "policy/local-approval-bundles", "policy/local-approvals", "policy/approvals",
  "orchestration/mass-ulw-lock", "executors/target-protocol", "executors/broker",
  "executors/worker", "executors/windows-bootstrap", "executors/http",
  "control-center/http", "policy/local-shell-jobs",
];
const sourceFiles = coveredModules.map((file) => `src/${file}.ts`);
const buildFiles = coveredModules.map((file) => `${file}.js`);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fixtureRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of fixtureRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
    await expect(fs.access(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jk-runtime-health-"));
  fixtureRoots.push(root);
  const manifestPath = path.join(root, "dist/runtime-schema-manifest.json");
  for (const file of [...sourceFiles, ...buildFiles.map((file) => `dist/${file}`)]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), `// fixture A: ${file}\n`);
  }
  async function fingerprint(base: string, files: string[]) {
    const entries = await Promise.all(files.map(async (file) => `${file}:${hash(await fs.readFile(path.join(base, file)))}`));
    return hash(entries.join("\n"));
  }
  async function publish() {
    const manifest = {
      version: 1,
      generatedAt: "2026-09-07T00:00:00.000Z",
      sourceFiles: [...sourceFiles], buildFiles: [...buildFiles],
      sourceFingerprint: await fingerprint(root, sourceFiles),
      buildFingerprint: await fingerprint(path.join(root, "dist"), buildFiles),
      requiredGoalLoopInputFields: [...REQUIRED_GOAL_LOOP_INPUT_FIELDS],
    };
    const raw = JSON.stringify(manifest);
    await fs.writeFile(manifestPath, raw);
    return { ...manifest, manifestFingerprint: hash(raw) };
  }
  const initial = await publish();
  const repository = process.cwd();
  // Redirect only runtime evidence paths; hashing, parsing and comparison remain real.
  function redirect(file: string) {
    const relative = path.relative(repository, file);
    if (relative === path.join("src", "runtime-schema-manifest.json")) return manifestPath;
    if (relative.startsWith(`src${path.sep}dist${path.sep}`)) return path.join(root, relative.slice(4));
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return path.join(root, relative);
    return file;
  }
  vi.stubEnv("JK_SOURCE_ROOT", root);
  vi.stubEnv("JK_RUNTIME_ROOT", root);
  vi.doMock("node:fs/promises", () => ({
    ...fs,
    access: (file: Parameters<typeof fs.access>[0]) => fs.access(typeof file === "string" ? redirect(file) : file),
    readFile: (file: Parameters<typeof fs.readFile>[0], options: Parameters<typeof fs.readFile>[1]) => fs.readFile(typeof file === "string" ? redirect(file) : file, options),
  }));
  async function load() {
    vi.resetModules();
    return import("./runtime-schema-health.js");
  }
  async function replace() {
    await fs.appendFile(path.join(root, "dist/policy/local-approvals.js"), "// fixture B\n");
    return publish();
  }
  return { root, manifestPath, initial, publish, load, replace };
}

function registerCurrent(runtime: typeof import("./runtime-schema-health.js")) {
  runtime.recordRegisteredToolSchemas([{
    name: "goal_loop",
    inputSchema: { properties: Object.fromEntries(REQUIRED_GOAL_LOOP_INPUT_FIELDS.map((field) => [field, {}])) },
  }]);
}

describe("runtime startup build identity", () => {
  it("keeps startup identity when coherent disk files and manifest are replaced before first health read", async () => {
    const disk = await fixture();
    const runtime = await disk.load();
    const replacement = await disk.replace();
    registerCurrent(runtime);
    expect(await runtime.getRuntimeSchemaHealth()).toMatchObject({
      status: "mismatch", releaseBlocked: true,
      startupBuildFingerprint: disk.initial.buildFingerprint,
      startupExpectedBuildFingerprint: disk.initial.buildFingerprint,
      startupManifestFingerprint: disk.initial.manifestFingerprint,
      currentManifestFingerprint: replacement.manifestFingerprint,
      buildFingerprint: replacement.buildFingerprint,
      expectedBuildFingerprint: replacement.buildFingerprint,
      sourceFingerprint: replacement.sourceFingerprint,
    });
  });

  it("does not reset startup identity after later coherent replacement", async () => {
    const disk = await fixture();
    const runtime = await disk.load();
    const first = await runtime.getRuntimeSchemaHealth();
    expect(first).toMatchObject({ status: "ok", releaseBlocked: false });
    const replacement = await disk.replace();
    registerCurrent(runtime);
    const second = await runtime.getRuntimeSchemaHealth();
    expect(second).toMatchObject({
      status: "mismatch", releaseBlocked: true,
      startupBuildFingerprint: disk.initial.buildFingerprint,
      buildFingerprint: replacement.buildFingerprint,
    });
    expect(Reflect.get(second, "startupCapturedAt")).toBe(Reflect.get(first, "startupCapturedAt"));
  });

  it("reports fresh coherent startup and registered schemas as healthy", async () => {
    const disk = await fixture();
    const replacement = await disk.replace();
    const runtime = await disk.load();
    registerCurrent(runtime);
    const health = await runtime.getRuntimeSchemaHealth();
    expect(health).toMatchObject({
      status: "ok", releaseBlocked: false, toolSchemaCompatible: true,
      startupBuildFingerprint: replacement.buildFingerprint,
      startupExpectedBuildFingerprint: replacement.buildFingerprint,
      startupManifestFingerprint: replacement.manifestFingerprint,
      currentManifestFingerprint: replacement.manifestFingerprint,
      buildFingerprint: replacement.buildFingerprint,
    });
    expect(Number.isFinite(Date.parse(Reflect.get(health, "startupCapturedAt")))).toBe(true);
  });

  const invalidCases = ["missing manifest", "missing build file", "malformed manifest", "missing source file",
    "omitted local approvals", "omitted approvals", "omitted bundles", "omitted jobs", "omitted tools",
    "omitted actions", "omitted control HTTP", "omitted durable lock", "omitted runtime health",
    "invalid fingerprint", "duplicate file", "path traversal", "missing required schema fields",
    "unreadable manifest", "unreadable build file"] as const;
  async function invalidate(disk: Awaited<ReturnType<typeof fixture>>, kind: typeof invalidCases[number]) {
    const omissions: Partial<Record<typeof invalidCases[number], string>> = {
      "omitted local approvals": "policy/local-approvals", "omitted approvals": "policy/approvals",
      "omitted bundles": "policy/local-approval-bundles", "omitted jobs": "policy/local-shell-jobs",
      "omitted tools": "server/tools", "omitted actions": "server/actions",
      "omitted control HTTP": "control-center/http", "omitted durable lock": "orchestration/mass-ulw-lock",
      "omitted runtime health": "server/runtime-schema-health",
    };
    const omitted = omissions[kind];
    if (omitted) {
      await fs.writeFile(disk.manifestPath, JSON.stringify({ ...disk.initial,
        sourceFiles: sourceFiles.filter((file) => file !== `src/${omitted}.ts`),
        buildFiles: buildFiles.filter((file) => file !== `${omitted}.js`),
      }));
      return;
    }
    switch (kind) {
      case "missing manifest": await fs.rm(disk.manifestPath); break;
      case "unreadable manifest": await fs.rm(disk.manifestPath); await fs.mkdir(disk.manifestPath); break;
      case "unreadable build file": {
        const file = path.join(disk.root, "dist/policy/local-approvals.js");
        await fs.rm(file); await fs.mkdir(file); break;
      }
      case "missing build file": await fs.rm(path.join(disk.root, "dist/policy/local-approvals.js")); break;
      case "missing source file": await fs.rm(path.join(disk.root, "src/policy/local-approvals.ts")); break;
      case "malformed manifest": await fs.writeFile(disk.manifestPath, "{"); break;
      case "invalid fingerprint": await fs.writeFile(disk.manifestPath, JSON.stringify({ ...disk.initial, buildFingerprint: 42 })); break;
      case "duplicate file": await fs.writeFile(disk.manifestPath, JSON.stringify({ ...disk.initial, buildFiles: [...buildFiles, "policy/approvals.js"] })); break;
      case "path traversal": await fs.writeFile(disk.manifestPath, JSON.stringify({ ...disk.initial, buildFiles: [...buildFiles, "../package.json"] })); break;
      case "missing required schema fields": await fs.writeFile(disk.manifestPath, JSON.stringify({ ...disk.initial, requiredGoalLoopInputFields: [] })); break;
      default: throw new Error(`Unhandled fixture ${kind}`);
    }
  }

  it.each(invalidCases)("cannot report healthy when startup build evidence is missing or invalid: %s", async (kind) => {
    const disk = await fixture();
    await invalidate(disk, kind);
    const runtime = await disk.load();
    registerCurrent(runtime);
    expect(await runtime.getRuntimeSchemaHealth()).toMatchObject({ status: "unverified", releaseBlocked: true });
  });

  it.each(invalidCases)("fails closed when current evidence becomes invalid: %s", async (kind) => {
    const disk = await fixture();
    const runtime = await disk.load();
    expect(await runtime.getRuntimeSchemaHealth()).toMatchObject({
      status: "ok", releaseBlocked: false, buildFingerprint: disk.initial.buildFingerprint,
      sourceFingerprint: disk.initial.sourceFingerprint,
    });
    await invalidate(disk, kind);
    expect(await runtime.getRuntimeSchemaHealth()).toMatchObject({ status: "unverified", releaseBlocked: true });
  });

  it("does not repair missing startup evidence by publishing a later manifest", async () => {
    const disk = await fixture();
    await fs.rm(disk.manifestPath);
    const runtime = await disk.load();
    await disk.publish();
    registerCurrent(runtime);
    expect(await runtime.getRuntimeSchemaHealth()).toMatchObject({ status: "unverified", releaseBlocked: true });
  });

  it("verifies a packaged build without available source", async () => {
    const disk = await fixture();
    await fs.rm(path.join(disk.root, "src"), { recursive: true });
    const runtime = await disk.load();
    expect(await runtime.getRuntimeSchemaHealth()).toMatchObject({
      status: "ok", releaseBlocked: false, sourceRoot: null, sourceFingerprint: null,
      startupBuildFingerprint: disk.initial.buildFingerprint,
    });
  });

  it("keeps registered schema incompatibility independent of coherent disk evidence", async () => {
    const disk = await fixture();
    const runtime = await disk.load();
    runtime.recordRegisteredToolSchemas([{ name: "goal_loop", inputSchema: { properties: {} } }]);
    expect(await runtime.getRuntimeSchemaHealth()).toMatchObject({ status: "mismatch", releaseBlocked: true, toolSchemaCompatible: false });
  });
});
