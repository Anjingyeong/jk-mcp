import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { REQUIRED_GOAL_LOOP_INPUT_FIELDS } from "../dist/server/runtime-schema-health.js";

const root = process.cwd();
const sourceFiles = [
  "src/server/tools.ts",
  "src/server/actions.ts",
  "src/server/runtime-schema-health.ts",
  "src/types.ts",
];
const buildFiles = [
  "server/tools.js",
  "server/actions.js",
  "server/runtime-schema-health.js",
  "types.js",
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
