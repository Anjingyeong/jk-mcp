/**
 * Measure the serialized MCP tool surface (what a client pays in context for
 * tools/list). Usage:
 *   npx tsx scripts/measure-tool-surface.ts [--top N] [--json] [--profile <list>]
 *
 * `--profile` sets JK_TOOL_PROFILES for the run (e.g. "all" or "core,e2e").
 */
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const topIdx = args.indexOf("--top");
const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 10;
const asJson = args.includes("--json");
const profileIdx = args.indexOf("--profile");
if (profileIdx >= 0) process.env.JK_TOOL_PROFILES = args[profileIdx + 1];

const { createServer } = await import("../src/server/mcp-server.js");

const stateDir = path.join(os.tmpdir(), "jk-measure-tool-surface");
const ctx = {
  workspaceRoot: os.tmpdir(),
  stateDir,
  registry: [],
  ledger: { append: async () => undefined },
  store: {
    loadProjects: async () => [],
    saveProjects: async () => undefined,
    getSession: async () => null,
    setSession: async () => undefined,
  },
  config: {
    workspaceRoot: os.tmpdir(),
    stateDir,
    maxReadBytes: 1024,
    maxPatchBytes: 1024,
    defaultCommandTimeoutSec: 30,
    defaultLeaseTtlMs: 30 * 60 * 1000,
  },
};

const server = await createServer(ctx as never);
const registered = Object.keys(
  (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
).length;
const handler = (
  server.server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<{ tools: Array<Record<string, unknown>> }>>;
  }
)._requestHandlers.get("tools/list");
if (!handler) throw new Error("tools/list handler not installed");
const { tools } = await handler({ method: "tools/list", params: {} });

const rows = tools
  .map((tool) => {
    const description = JSON.stringify(tool.description ?? "").length;
    const inputSchema = JSON.stringify(tool.inputSchema ?? {}).length;
    const total = JSON.stringify(tool).length;
    return { name: String(tool.name), description, inputSchema, total };
  })
  .sort((a, b) => b.total - a.total);

const sum = rows.reduce(
  (acc, r) => ({ description: acc.description + r.description, inputSchema: acc.inputSchema + r.inputSchema, total: acc.total + r.total }),
  { description: 0, inputSchema: 0, total: 0 },
);

if (asJson) {
  console.log(JSON.stringify({ registered, listed: rows.length, sum, rows }, null, 2));
} else {
  console.log(`registered=${registered} listed=${rows.length} totalBytes=${sum.total} descBytes=${sum.description} schemaBytes=${sum.inputSchema}`);
  console.log("rank | name | total | description | inputSchema");
  rows.slice(0, top).forEach((r, i) => console.log(`${i + 1} | ${r.name} | ${r.total} | ${r.description} | ${r.inputSchema}`));
}
process.exit(0);
