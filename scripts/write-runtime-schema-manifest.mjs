import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { REQUIRED_GOAL_LOOP_INPUT_FIELDS } from "../dist/server/runtime-schema-health.js";

const root = process.cwd();
async function listRuntimeSourceFiles(dir, relative = "src") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const rel = `${relative}/${entry.name}`.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      files.push(...await listRuntimeSourceFiles(absolute, rel));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    files.push(rel);
  }
  return files.sort();
}

// Runtime upgrade identity must cover every TypeScript module that tsc emits,
// not only the MCP/schema-facing subset. Otherwise a behavioral code change
// can reuse an older successful reload job and leave the live process stale.
const sourceFiles = await listRuntimeSourceFiles(path.join(root, "src"));
const buildFiles = sourceFiles.map((file) => file.slice("src/".length, -".ts".length) + ".js");
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
