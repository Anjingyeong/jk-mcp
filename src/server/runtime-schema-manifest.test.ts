import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeSchemaManifest } from "./runtime-schema-health.js";

const execute = promisify(execFile);
const roots: string[] = [];
const modules = [
  "server/tools", "server/actions", "server/runtime-schema-health", "types",
  "workspace/task-workspaces", "workspace/registry", "state/store",
  "server/mass-ulw-web-tool", "orchestration/mass-ulw-web", "orchestration/mass-ulw-web-context",
  "policy/local-approval-bundles", "policy/local-approvals", "policy/approvals",
  "orchestration/mass-ulw-lock", "executors/target-protocol", "executors/broker",
  "executors/worker", "executors/windows-bootstrap", "executors/http", "control-center/http", "policy/local-shell-jobs",
  "server/tool-profiles",
  ...["shared", "register", "workspace", "guide", "goal", "image", "project", "code",
    "file", "command", "mass-ulw", "e2e", "git", "checkpoint", "control", "impulse"].map((name) => `server/tools/${name}`),
];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jk-runtime-manifest-"));
  roots.push(root);
  for (const module of modules) {
    for (const file of [`src/${module}.ts`, `dist/${module}.js`]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), `// fixture ${file}\n`);
    }
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(root, "dist/server/runtime-schema-health.js"),
    'export const REQUIRED_GOAL_LOOP_INPUT_FIELDS = ["safety", "executionProfile", "fanoutCandidates", "reviewVerdict"];\n');
  await mkdir(path.join(root, "scripts"));
  await copyFile(path.resolve("scripts/write-runtime-schema-manifest.mjs"), path.join(root, "scripts/write-runtime-schema-manifest.mjs"));
  async function generate(): Promise<RuntimeSchemaManifest> {
    await execute(process.execPath, [path.join(root, "scripts/write-runtime-schema-manifest.mjs")], { cwd: root, timeout: 5000 });
    return JSON.parse(await readFile(path.join(root, "dist/runtime-schema-manifest.json"), "utf8"));
  }
  return { root, generate };
}

describe("runtime manifest generator", () => {
  it("includes exact approval authority in generated manifest", async () => {
    const disk = await fixture();
    const manifest = await disk.generate();
    expect(manifest.sourceFiles).toEqual(expect.arrayContaining(["src/policy/local-approvals.ts", "src/policy/approvals.ts"]));
    expect(manifest.buildFiles).toEqual(expect.arrayContaining(["policy/local-approvals.js", "policy/approvals.js"]));
    expect(manifest.requiredGoalLoopInputFields).toEqual(["safety", "executionProfile", "fanoutCandidates", "reviewVerdict"]);
  });

  it.each(["src/policy/local-approvals.ts", "dist/policy/local-approvals.js", "src/policy/approvals.ts", "dist/policy/approvals.js"])(
    "fingerprints actual approval bytes independently: %s", async (file) => {
      const disk = await fixture();
      const before = await disk.generate();
      await appendFile(path.join(disk.root, file), "// changed approval bytes\n");
      const after = await disk.generate();
      const isSource = file.startsWith("src/");
      const key = isSource ? "sourceFingerprint" : "buildFingerprint";
      expect(after[key]).not.toBe(before[key]);
      expect(after[isSource ? "buildFingerprint" : "sourceFingerprint"]).toBe(before[isSource ? "buildFingerprint" : "sourceFingerprint"]);
      const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
      const entries = await Promise.all((isSource ? after.sourceFiles : after.buildFiles).map(async (relative) =>
        `${relative}:${sha(await readFile(path.join(disk.root, isSource ? "" : "dist", relative)))}`));
      expect(after[key]).toBe(sha(entries.join("\n")));
    },
  );
});
