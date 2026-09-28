import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { e2eWidgetResourceMeta } from "./shared.js";

/** The securitySchemes-wrapping registerTool used by every domain module. */
export type RegisterTool = McpServer["registerTool"];
export type WidgetMeta = ReturnType<typeof e2eWidgetResourceMeta>;
