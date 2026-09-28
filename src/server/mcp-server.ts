import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { registerTools } from "./tools.js";
import { RUNTIME_VERSION } from "../runtime-version.js";

/**
 * Construct and configure the MCP server (stdio transport) with all tools
 * registered against ctx. Returns the server instance ready to `connect()`.
 */
export async function createServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({
    name: "jk",
    version: RUNTIME_VERSION,
  });

  registerTools(server, ctx);

  return server;
}
