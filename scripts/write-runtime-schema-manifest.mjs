import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { REQUIRED_GOAL_LOOP_INPUT_FIELDS } from "../dist/server/runtime-schema-health.js";

const root = process.cwd();
// Tool registrations were split out of tools.ts into src/server/tools/*.ts;
// keep them in the fingerprint so schema drift is still detected.
const TOOL_MODULES = [
  "shared", "register", "workspace", "guide", "goal", "image", "project", "code",
  "file", "command", "mass-ulw", "e2e", "git", "checkpoint", "control", "impulse",
];
const sourceFiles = [
  "src/server/tools.ts",
  "src/server/actions.ts",
  "src/server/runtime-schema-health.ts",
  "src/types.ts",
  "src/workspace/task-workspaces.ts",
  "src/workspace/registry.ts",
  "src/state/store.ts",
  "src/server/mass-ulw-web-tool.ts",
  "src/orchestration/mass-ulw-web.ts",
  "src/orchestration/mass-ulw-web-context.ts",
  "src/policy/local-approval-bundles.ts",
  "src/policy/local-approvals.ts",
  "src/policy/approvals.ts",
  "src/orchestration/mass-ulw-lock.ts",
  "src/executors/target-protocol.ts",
  "src/executors/broker.ts",
  "src/executors/worker.ts",
  "src/executors/windows-bootstrap.ts",
  "src/executors/http.ts",
  "src/control-center/http.ts",
  "src/policy/local-shell-jobs.ts",
  "src/server/tool-profiles.ts",
  ...TOOL_MODULES.map((name) => `src/server/tools/${name}.ts`),
];
const buildFiles = [
  "server/tools.js",
  "server/actions.js",
  "server/runtime-schema-health.js",
  "types.js",
  "workspace/task-workspaces.js",
  "workspace/registry.js",
  "state/store.js",
  "server/mass-ulw-web-tool.js",
  "orchestration/mass-ulw-web.js",
  "orchestration/mass-ulw-web-context.js",
  "policy/local-approval-bundles.js",
  "policy/local-approvals.js",
  "policy/approvals.js",
  "orchestration/mass-ulw-lock.js",
  "executors/target-protocol.js",
  "executors/broker.js",
  "executors/worker.js",
  "executors/windows-bootstrap.js",
  "executors/http.js",
  "control-center/http.js",
  "policy/local-shell-jobs.js",
  "server/tool-profiles.js",
  ...TOOL_MODULES.map((name) => `server/tools/${name}.js`),
];
const requiredGoalLoopInputFields = [...REQUIRED_GOAL_LOOP_INPUT_FIELDS];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fingerprintFiles(base, files) {
  const entries = [];
  for (const relative of files) {
    const bytes = await readFile(path.join(base, relative));
    entries.push(`${relative.replace(/\\/g, "/")}:${sha256(bytes)}`);
  }
  return sha256(entries.join("\n"));
}

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  sourceFiles,
  buildFiles,
  sourceFingerprint: await fingerprintFiles(root, sourceFiles),
  buildFingerprint: await fingerprintFiles(path.join(root, "dist"), buildFiles),
  requiredGoalLoopInputFields,
};

await writeFile(
  path.join(root, "dist", "runtime-schema-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(`[runtime-schema] manifest ${manifest.sourceFingerprint.slice(0, 12)} / ${manifest.buildFingerprint.slice(0, 12)}`);
