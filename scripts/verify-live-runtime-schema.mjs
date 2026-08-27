import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const baseUrl = (process.argv[2] || process.env.JK_LOCAL_BASE_URL || "http://127.0.0.1:7979").replace(/\/$/u, "");
const runtimeRoot = process.argv[3] || process.env.JK_VERIFY_RUNTIME_ROOT || "";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "dist", "runtime-schema-manifest.json"), "utf8"));
const requiredGoalLoopFields = Array.isArray(manifest.requiredGoalLoopInputFields)
  ? manifest.requiredGoalLoopInputFields
  : [];
if (!requiredGoalLoopFields.length) throw new Error("runtime schema manifest has no required goal_loop fields");
const requiredTools = ["goal_loop", "runtime_upgrade"];

async function readStatus() {
  let lastError = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/jk/control/status`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`status HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError || new Error("runtime status did not become available");
}

async function probeRuntimePackage(root) {
  if (!root) return null;
  const resolvedRoot = path.resolve(root);
  const cli = path.join(resolvedRoot, "dist", "cli.js");
  if (!fs.existsSync(cli)) return null;
  const bundledNode = process.platform === "win32" ? path.join(resolvedRoot, "bin", "node.exe") : "";
  const nodeCommand = bundledNode && fs.existsSync(bundledNode) ? bundledNode : process.execPath;
  const transport = new StdioClientTransport({
    command: nodeCommand,
    args: [
      cli,
      "serve",
      "--workspace", repoRoot,
      "--active-project-root", repoRoot,
      "--active-project-preset", "read-only",
    ],
    cwd: resolvedRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "jk-live-runtime-schema-verifier", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await client.listTools();
  } finally {
    await client.close().catch(() => undefined);
  }
}

const status = await readStatus();
const schema = status?.runtime?.schema;
if (!schema || typeof schema !== "object") {
  throw new Error("runtime status did not expose registered tool-schema health");
}

let fields = Array.isArray(schema.goalLoopInputFields) ? schema.goalLoopInputFields : [];
let tools = Array.isArray(schema.registeredToolNames) ? schema.registeredToolNames : [];
let verificationSource = "live-cache";

if ((!fields.length || !tools.length) && !schema.toolSchemaFingerprint) {
  const listed = await probeRuntimePackage(runtimeRoot);
  if (listed?.tools?.length) {
    const goalLoop = listed.tools.find((tool) => tool.name === "goal_loop");
    fields = goalLoop?.inputSchema && typeof goalLoop.inputSchema === "object"
      ? Object.keys(goalLoop.inputSchema.properties || {})
      : [];
    tools = listed.tools.map((tool) => tool.name);
    verificationSource = "runtime-package";
  }
}

const missingFields = requiredGoalLoopFields.filter((field) => !fields.includes(field));
const missingTools = requiredTools.filter((tool) => !tools.includes(tool));
const reasons = Array.isArray(schema.reasons) ? schema.reasons : [];

if (schema.status !== "ok" || schema.releaseBlocked || missingFields.length || missingTools.length) {
  throw new Error([
    `registered tools/list schema verification failed: status=${schema.status ?? "unknown"}`,
    missingFields.length ? `missing goal_loop fields=${missingFields.join(",")}` : "",
    missingTools.length ? `missing tools=${missingTools.join(",")}` : "",
    reasons.length ? `reasons=${reasons.join(" | ")}` : "",
  ].filter(Boolean).join("; "));
}

const short = (value) => typeof value === "string" && value ? value.slice(0, 12) : "none";
console.log(
  `[runtime-schema] OK source=${verificationSource} tools/list=${short(schema.toolSchemaFingerprint)} source=${short(schema.sourceFingerprint)} build=${short(schema.buildFingerprint)} goal_loop=${requiredGoalLoopFields.join(",")} runtime_upgrade=registered`,
);
