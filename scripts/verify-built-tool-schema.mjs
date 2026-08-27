import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = process.cwd();
const manifest = JSON.parse(
  await readFile(path.join(repoRoot, "dist", "runtime-schema-manifest.json"), "utf8"),
);
const requiredFields = Array.isArray(manifest.requiredGoalLoopInputFields)
  ? manifest.requiredGoalLoopInputFields
  : [];
if (!requiredFields.length) throw new Error("runtime schema manifest has no required goal_loop fields");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(repoRoot, "dist", "cli.js"),
    "serve",
    "--workspace", repoRoot,
    "--active-project-root", repoRoot,
    "--active-project-preset", "read-only",
  ],
  cwd: repoRoot,
  stderr: "pipe",
});
const client = new Client({ name: "jk-runtime-schema-build-verifier", version: "0.0.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const goalLoop = listed.tools.find((tool) => tool.name === "goal_loop");
  if (!goalLoop) throw new Error("goal_loop missing from tools/list");
  const properties = goalLoop.inputSchema && typeof goalLoop.inputSchema === "object"
    ? goalLoop.inputSchema.properties || {}
    : {};
  const missing = requiredFields.filter((field) => !(field in properties));
  if (missing.length) throw new Error(`goal_loop tools/list schema missing: ${missing.join(", ")}`);
  if (!listed.tools.some((tool) => tool.name === "runtime_upgrade")) {
    throw new Error("runtime_upgrade missing from tools/list");
  }
  console.log(`[runtime-schema] built tools/list OK goal_loop=${requiredFields.join(",")} runtime_upgrade=registered tools=${listed.tools.length}`);
} finally {
  await client.close().catch(() => undefined);
}
