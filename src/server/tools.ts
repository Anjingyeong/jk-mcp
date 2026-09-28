// MCP tool registration entry point. Domain registrations live in
// src/server/tools/*.ts; shared helpers in src/server/tools/shared.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext } from "../types.js";
import { JK_SECURITY_SCHEMES, installChatGptToolListHandler, E2E_SCREENSHOT_WIDGET_URI, E2E_SCREENSHOT_WIDGET_MIME, E2E_SCREENSHOT_WIDGET_HTML, e2eWidgetResourceMeta } from "./tools/shared.js";
import { registerTaskWorkspaceTool, registerWorkspaceTools } from "./tools/workspace.js";
import { registerGuideTools } from "./tools/guide.js";
import { registerGoalTools } from "./tools/goal.js";
import { registerImageGuideTools, registerImageTools } from "./tools/image.js";
import { registerProjectTools } from "./tools/project.js";
import { registerCodeTools } from "./tools/code.js";
import { registerFileTools } from "./tools/file.js";
import { registerCommandTools } from "./tools/command.js";
import { registerMassUlwTools } from "./tools/mass-ulw.js";
import { registerE2eTools } from "./tools/e2e.js";
import { registerGitTools } from "./tools/git.js";
import { registerCheckpointTools } from "./tools/checkpoint.js";
import { registerControlTools } from "./tools/control.js";
import { registerImpulseTools } from "./tools/impulse.js";

export { resolveExecutionProject, bindExecutionLease, requireProjectLease, leaseTtlMs, assertExecutionTarget, discoverE2eAutomation } from "./tools/shared.js";

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

/**
 * Register every MCP tool (workspace_*, project_*, code_*, file_*,
 * command_*, git_*) against the given server instance, wiring handlers to
 * ctx (PRD §8 full tool catalog).
 */
export function registerTools(server: unknown, ctx: ToolContext): void {
  const s = server as McpServer;
  const rawRegisterTool = s.registerTool.bind(s);
  const registerTool = ((name: string, config: Record<string, unknown>, handler: unknown) =>
    rawRegisterTool(
      name,
      {
        securitySchemes: JK_SECURITY_SCHEMES,
        ...config,
        _meta: {
          securitySchemes: JK_SECURITY_SCHEMES,
          ...((config._meta as Record<string, unknown> | undefined) ?? {}),
        },
      } as never,
      handler as never,
    )) as unknown as McpServer["registerTool"];

  const widgetMeta = e2eWidgetResourceMeta(ctx.config.publicUrl);
  registerTaskWorkspaceTool(registerTool, ctx);
  s.registerResource(
    "e2e-screenshots-widget",
    E2E_SCREENSHOT_WIDGET_URI,
    {
      title: "E2E screenshot gallery",
      description: "Renders captured E2E screenshots inline in ChatGPT.",
      mimeType: E2E_SCREENSHOT_WIDGET_MIME,
      _meta: widgetMeta,
    },
    async () => ({
      contents: [
        {
          uri: E2E_SCREENSHOT_WIDGET_URI,
          mimeType: E2E_SCREENSHOT_WIDGET_MIME,
          text: E2E_SCREENSHOT_WIDGET_HTML,
          _meta: widgetMeta,
        },
      ],
    }),
  );

  registerGuideTools(registerTool, ctx);
  registerGoalTools(registerTool, ctx);
  registerImageGuideTools(registerTool, ctx);
  registerWorkspaceTools(registerTool, ctx);
  registerProjectTools(registerTool, ctx);
  registerCodeTools(registerTool, ctx);
  registerFileTools(registerTool, ctx);
  registerCommandTools(registerTool, ctx);
  registerMassUlwTools(registerTool, ctx);
  registerE2eTools(registerTool, ctx);
  registerGitTools(registerTool, ctx);
  registerCheckpointTools(registerTool, ctx);
  registerImpulseTools(registerTool, ctx);
  registerImageTools(registerTool, ctx);
  registerControlTools(registerTool, ctx);

  installChatGptToolListHandler(s, ctx);
}
