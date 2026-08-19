import type { Express, Request, Response } from "express";
import { promises as fs } from "node:fs";
import { verifyOwnerToken } from "../auth/owner-token.js";
import type { ToolContext } from "../types.js";
import { createE2eScreenshotShare, readE2eScreenshotShare } from "../e2e/screenshot-share.js";
import { CONTROL_TOOL_NAMES, isControlChatGptExposed } from "../control/policy.js";
import { createServer as createMcpServer } from "./mcp-server.js";
import { TOOL_AVAILABILITY_GATE, toolCallProof } from "./tool-proof.js";
import { normalizeObjectSchema, safeParseAsync, getParseErrorMessage } from "@modelcontextprotocol/sdk/server/zod-compat.js";

interface CallToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<CallToolResultLike>;
  inputSchema?: unknown;
}

interface ActionAccessTokenVerifier {
  verifyAccessToken(token: string): Promise<{ scopes?: string[] }>;
}

interface ActionRoute {
  path: string;
  tool: string;
  operationId: string;
  summary: string;
  description: string;
  schema: string;
}

const ACTION_ROUTES: ActionRoute[] = [
  {
    path: "/actions/agent-guide",
    tool: "agent_guide",
    operationId: "agent_guide",
    summary: "Get the chatgpt2codex workflow guide",
    description:
      "Call this first so the GPT knows the available chatgpt2codex tools and the ChatGPT image-save workflow. Do not proceed with local coding unless this or another chatgpt2codex action returns ok=true in the current turn.",
    schema: "EmptyInput",
  },
  {
    path: "/actions/goal-intake",
    tool: "goal_intake",
    operationId: "goal_intake",
    summary: "Start a broad local coding goal",
    description:
      "Call this immediately for /goal, deep research, vague large implementation, or 'proceed quickly' prompts. This uses the local chatgpt2codex execution bridge; ChatGPT remains the reasoning surface. It returns within seconds with the next tool calls so ChatGPT does not spend ~30 seconds thinking and then stop. If this action is unavailable, stop and say no local coding occurred.",
    schema: "GoalIntakeInput",
  },
  {
    path: "/actions/goal-loop",
    tool: "goal_loop",
    operationId: "goal_loop",
    summary: "Run or continue a local coding loop",
    description:
      "Use this for a Codex-style inspect/edit/verify loop driven through ChatGPT Actions. It keeps the loop state local, can persist structured current-task/completed/pending/decision progress, returns the next concrete action batch quickly, and tells ChatGPT to call it again after each inspect/edit/verify batch until done or blocked. It is not intended to bypass product rate limits, usage limits, or safety restrictions.",
    schema: "GoalLoopInput",
  },
  {
    path: "/actions/project-select",
    tool: "project_select",
    operationId: "project_select",
    summary: "Select the active local project",
    description:
      "Selects and leases the project. GPT Actions default to preset=full-write when preset is omitted, so source edits can be applied directly through chatgpt2codex instead of returning copy/paste scripts. Use preset=image-only only for image-only saves.",
    schema: "ProjectSelectInput",
  },
  {
    path: "/actions/session-resume",
    tool: "session_resume",
    operationId: "session_resume",
    summary: "Resume recent local project work",
    description:
      "Load the active project's recent work context and validate stored file hashes before reusing it. Call this after project_select on follow-up work so unchanged artifacts can be resumed without broad rediscovery.",
    schema: "SessionResumeInput",
  },
  {
    path: "/actions/workspace-list-projects",
    tool: "workspace_list_projects",
    operationId: "workspace_list_projects",
    summary: "List local workspace projects",
    description: "List projects registered under the local chatgpt2codex workspace.",
    schema: "WorkspaceListProjectsInput",
  },
  {
    path: "/actions/workspace-refresh-index",
    tool: "workspace_refresh_index",
    operationId: "workspace_refresh_index",
    summary: "Refresh the local project index",
    description: "Rescan the local workspace root and refresh chatgpt2codex's project registry.",
    schema: "WorkspaceRefreshIndexInput",
  },
  {
    path: "/actions/workspace-get-project",
    tool: "workspace_get_project",
    operationId: "workspace_get_project",
    summary: "Get local project metadata",
    description: "Resolve a project by project id or local path inside the configured workspace.",
    schema: "WorkspaceGetProjectInput",
  },
  {
    path: "/actions/project-status",
    tool: "project_status",
    operationId: "project_status",
    summary: "Get project status",
    description: "Read branch, dirty files, rule files, commands, and Code Brain availability for a project.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/project-rules",
    tool: "project_rules",
    operationId: "project_rules",
    summary: "Read project rules",
    description: "Read local AGENTS/CLAUDE project rules through chatgpt2codex, optionally scoped to a nested path, with secret redaction.",
    schema: "ProjectRulesInput",
  },
  {
    path: "/actions/code-search",
    tool: "code_search",
    operationId: "code_search",
    summary: "Search project code",
    description: "Search project source code through the local chatgpt2codex runtime.",
    schema: "CodeSearchInput",
  },
  {
    path: "/actions/code-context-pack",
    tool: "code_context_pack",
    operationId: "code_context_pack",
    summary: "Build project code context",
    description: "Build a compact search/read context pack for implementation work.",
    schema: "CodeContextPackInput",
  },
  {
    path: "/actions/file-read-slice",
    tool: "file_read_slice",
    operationId: "file_read_slice",
    summary: "Read project file slice",
    description: "Read a line range from a project file with hash anchors for safe patching.",
    schema: "FileReadSliceInput",
  },
  {
    path: "/actions/file-apply-patch",
    tool: "file_apply_patch",
    operationId: "file_apply_patch",
    summary: "Apply a project file patch",
    description: "Apply a Codex-style patch directly to the selected local project. Requires project_select preset=full-write; do not return shell scripts for the user to paste.",
    schema: "FileApplyPatchInput",
  },
  {
    path: "/actions/file-create",
    tool: "file_create",
    operationId: "file_create",
    summary: "Create a project file",
    description: "Create or overwrite a project-confined file directly through chatgpt2codex. Requires project_select preset=full-write.",
    schema: "FileCreateInput",
  },
  {
    path: "/actions/command-list",
    tool: "command_list",
    operationId: "command_list",
    summary: "List project commands",
    description: "List allowlisted project commands discovered by chatgpt2codex.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/command-run",
    tool: "command_run",
    operationId: "command_run",
    summary: "Run allowlisted project command",
    description: "Run an allowlisted project command through chatgpt2codex.",
    schema: "CommandRunInput",
  },
  {
    path: "/actions/local-shell-run",
    tool: "local_shell_run",
    operationId: "local_shell_run",
    summary: "Run local project shell",
    description: "Run a guarded local shell command inside the project through chatgpt2codex. Network/destructive intents remain approval-gated. Approval-required calls are queued and automatically execute after the owner approves them, so callers must not retry the same command just to consume approval. For known multi-step risky work, intent.approvalBundle can predeclare exact follow-up commands for one bounded owner approval.",
    schema: "LocalShellRunInput",
  },
  {
    path: "/actions/omo-run",
    tool: "omo_run",
    operationId: "omo_run",
    summary: "Run the OMO coding agent",
    description:
      "Optional adapter used only when the user explicitly asks for OMO; normal JK-native goal_loop work never invokes it. Delegates a coding pass to the locally installed OMO/Oh My OpenAgent CLI, requires a full-write project lease, and keeps remote model-provider use behind the local approval gate.",
    schema: "OmoRunInput",
  },
  {
    path: "/actions/e2e-start-server",
    tool: "e2e_start_server",
    operationId: "e2e_start_server",
    summary: "Start a local dev server for E2E",
    description:
      "Start a long-running project dev/server command in the background, optionally wait for a URL, and return pid/log path. Use before browser/app E2E screenshots.",
    schema: "E2eStartServerInput",
  },
  {
    path: "/actions/e2e-open-target",
    tool: "e2e_open_target",
    operationId: "e2e_open_target",
    summary: "Open a URL or local app for E2E",
    description: "Open a URL, installed app name, or allowed local app path on the Mac before E2E screenshot capture.",
    schema: "E2eOpenTargetInput",
  },
  {
    path: "/actions/e2e-run-command",
    tool: "e2e_run_command",
    operationId: "e2e_run_command",
    summary: "Run E2E command and capture proof",
    description:
      "Run a guarded project E2E/test command and capture a macOS screenshot by default so the user can inspect visual proof.",
    schema: "E2eRunCommandInput",
  },
  {
    path: "/actions/e2e-test-and-show-screenshot",
    tool: "e2e_test_and_show_screenshot",
    operationId: "e2e_test_and_show_screenshot",
    summary: "E2E test and show screenshot inline",
    description:
      "Call this one-shot action when the user says 'e2e 테스트하고 스크린샷 보여줘', 'run e2e and show me the screenshot', or similar. It uses the active project by default, detects web vs desktop-app projects such as Tauri, runs only discovered local package scripts, and captures visual proof. macOS supports app-window and top/middle/bottom browser-region screenshots; Windows web projects use an installed Edge/Chrome with an isolated profile and capture desktop plus 390x844 mobile top/middle/bottom views. The action returns imageMarkdown/imageMarkdownList. If the local check fails, inspect logs, make normal code fixes with separate coding tools, rerun E2E, and only then render the final passing screenshot set inline.",
    schema: "E2eTestAndShowScreenshotInput",
  },
  {
    path: "/actions/e2e-screenshot",
    tool: "e2e_screenshot",
    operationId: "e2e_screenshot",
    summary: "Capture an E2E screenshot",
    description:
      "Capture a macOS screenshot into the selected project under .chatgpt2codex/e2e/screenshots and return the file path so the user can inspect it.",
    schema: "E2eScreenshotInput",
  },
  {
    path: "/actions/e2e-open-url-screenshot",
    tool: "e2e_open_url_screenshot",
    operationId: "e2e_open_url_screenshot",
    summary: "Open a URL and capture an E2E screenshot",
    description: "Open a local loopback URL, wait briefly, capture browser visual proof on macOS or Windows, and return inline image markdown.",
    schema: "E2eOpenUrlScreenshotInput",
  },
  {
    path: "/actions/repo-status",
    tool: "repo_status",
    operationId: "repo_status",
    summary: "Read repository status",
    description: "Read local git branch, dirty files, staged files, upstream, and sync state.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/repo-diff-summary",
    tool: "repo_diff_summary",
    operationId: "repo_diff_summary",
    summary: "Summarize repository diff",
    description: "Summarize the local working diff with secret redaction.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/show-changes",
    tool: "show_changes",
    operationId: "show_changes",
    summary: "Show project changes",
    description: "Return the current redacted working diff for review.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/checkpoint-list",
    tool: "checkpoint_list",
    operationId: "checkpoint_list",
    summary: "List project checkpoints",
    description: "List recent mutation checkpoints captured by chatgpt2codex.",
    schema: "ProjectOnlyInput",
  },
  {
    path: "/actions/checkpoint-show",
    tool: "checkpoint_show",
    operationId: "checkpoint_show",
    summary: "Show project checkpoint",
    description: "Show the redacted diff stored in a chatgpt2codex checkpoint.",
    schema: "CheckpointShowInput",
  },
  {
    path: "/actions/checkpoint-restore",
    tool: "checkpoint_restore",
    operationId: "checkpoint_restore",
    summary: "Restore project checkpoint",
    description: "Reverse-apply a checkpoint diff through chatgpt2codex. Requires a write lease.",
    schema: "CheckpointShowInput",
  },
  {
    path: "/actions/git-commit",
    tool: "git_commit",
    operationId: "git_commit",
    summary: "Commit project changes",
    description: "Stage and commit project changes through chatgpt2codex after inspecting status/diff.",
    schema: "GitCommitInput",
  },
  {
    path: "/actions/git-push",
    tool: "git_push",
    operationId: "git_push",
    summary: "Push project branch",
    description: "Push the current project branch through chatgpt2codex when the user explicitly requested pushing.",
    schema: "GitPushInput",
  },
  {
    path: "/actions/save-chatgpt-image",
    tool: "save_chatgpt_image",
    operationId: "save_chatgpt_image",
    summary: "Save a finished ChatGPT image from URL, clipboard, download, or path",
    description:
      "Device-agnostic import when a ChatGPT Share/Copy Link or content URL is available. Also supports local Mac clipboard/download/path sources. This is the correct Custom GPT path for phone-generated images after the user provides the image URL.",
    schema: "SaveChatGptImageInput",
  },
  {
    path: "/actions/import-chatgpt-image-url",
    tool: "save_chatgpt_image_from_url",
    operationId: "save_chatgpt_image_from_url",
    summary: "Import a ChatGPT image URL",
    description:
      "Device-agnostic import for ChatGPT image URLs, including chatgpt.com/s/m_... share pages and backend estuary content URLs. Use for phone-generated images or any device where chatgpt2codex cannot inspect local Chrome.",
    schema: "ImportChatGptImageUrlInput",
  },
  {
    path: "/actions/list-images",
    tool: "list_images",
    operationId: "list_images",
    summary: "List saved project images",
    description: "Lists images already saved under .chatgpt2codex/images for a project.",
    schema: "ListImagesInput",
  },
];

const OPENAPI_ACTION_TOOL_NAMES = new Set([
  "agent_guide",
  "goal_intake",
  "goal_loop",
  "project_select",
  "session_resume",
  "workspace_list_projects",
  "project_status",
  "project_rules",
  "code_search",
  "file_read_slice",
  "file_apply_patch",
  "file_create",
  "command_run",
  "local_shell_run",
  "omo_run",
  "e2e_start_server",
  "e2e_open_target",
  "e2e_run_command",
  "e2e_test_and_show_screenshot",
  "e2e_screenshot",
  "e2e_open_url_screenshot",
  "repo_status",
  "repo_diff_summary",
  "git_commit",
  "git_push",
  "save_chatgpt_image",
  "save_chatgpt_image_from_url",
  "list_images",
]);

function openApiActionRoutes(): ActionRoute[] {
  return ACTION_ROUTES.filter((route) => OPENAPI_ACTION_TOOL_NAMES.has(route.tool));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionInput(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return {};
  return isRecord(body.input) ? body.input : body;
}

function actionInputForRoute(route: ActionRoute, body: unknown): Record<string, unknown> {
  const input = { ...actionInput(body) };
  if (route.tool === "project_select" && input.preset === undefined) {
    input.preset = "full-write";
  }
  return input;
}

function genericToolInput(body: unknown): { toolName: string; input: Record<string, unknown> } {
  const raw =
    isRecord(body) && isRecord(body.input) && typeof body.input.toolName === "string"
      ? body.input
      : isRecord(body)
        ? body
        : {};
  const toolName = typeof raw.toolName === "string" ? raw.toolName.trim() : "";
  const input = isRecord(raw.input) ? { ...raw.input } : {};
  if (toolName === "project_select" && input.preset === undefined) {
    input.preset = "full-write";
  }
  return { toolName, input };
}

function bearerToken(req: Request): string | undefined {
  const raw = req.header("authorization") ?? "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

async function requireActionBearer(
  ctx: ToolContext,
  oauthVerifier: ActionAccessTokenVerifier | undefined,
  requiredScope: string,
  req: Request,
  res: Response,
): Promise<boolean> {
  const token = bearerToken(req);
  if (token && (await verifyOwnerToken(ctx.stateDir, token))) return true;
  if (token && oauthVerifier) {
    try {
      const auth = await oauthVerifier.verifyAccessToken(token);
      if ((auth.scopes ?? []).includes(requiredScope)) return true;
    } catch {
      // Fall through to one generic 401 so token details never leak.
    }
  }
  res.status(401).json({
    ok: false,
    error: "Missing or invalid Bearer token. Connect this GPT with JK OAuth or use the owner token API key.",
  });
  return false;
}

async function callRegisteredTool(
  ctx: ToolContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<CallToolResultLike> {
  // Desktop-control tools are blocked on the generic action bridge (even for
  // the owner-bearer /actions/call-tool route, even if isControlEnabled() is
  // on) unless the owner has separately opted in to exposing them to ChatGPT
  // via CHATGPT2CODEX_CONTROL_CHATGPT (isControlChatGptExposed) — the
  // public-product default keeps this block in place, matching the
  // tools/list hide in src/server/tools.ts installChatGptToolListHandler.
  if (CONTROL_TOOL_NAMES.has(toolName) && !isControlChatGptExposed()) {
    const message = `Tool ${toolName} is not available through the chatgpt2codex action bridge.`;
    return {
      isError: true,
      structuredContent: { code: "PERMISSION_DENIED", error: message },
      content: [{ type: "text", text: message }],
    };
  }
  // project_select isn't itself a control tool (so it isn't caught by
  // CONTROL_TOOL_NAMES above), but preset="control" is the only way to grant
  // a control lease and clear the kill switch (see src/server/tools.ts
  // project_select handler / src/control/queue.ts clearKill). A remote
  // owner-bearer caller must never be able to resume a locally killed
  // control session or grant itself a control lease through the bridge, so
  // this is rejected at the single choke point both /actions/call-tool
  // (genericToolInput) and the per-route bridge (actionInputForRoute) call
  // through. The local/MCP zod path (registerTool project_select) is
  // untouched, so a local approver can still grant/resume control normally.
  if (toolName === "project_select" && input.preset === "control") {
    const message = "preset=control cannot be granted through the chatgpt2codex action bridge.";
    await ctx.ledger.append({ type: "control.bridge.rejected", preset: "control" }).catch(() => undefined);
    return {
      isError: true,
      structuredContent: { code: "PERMISSION_DENIED", error: message },
      content: [{ type: "text", text: message }],
    };
  }
  const server = await createMcpServer(ctx);
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  const registered = tools?.[toolName];
  const handler = registered?.handler;
  if (!handler) {
    return {
      isError: true,
      structuredContent: { code: "TOOL_NOT_FOUND", error: `Tool not found: ${toolName}` },
      content: [{ type: "text", text: `Tool not found: ${toolName}` }],
    };
  }
  // This bridge calls the raw registered handler directly, bypassing the
  // MCP SDK's normal tools/call path (McpServer#validateToolInput), which is
  // where every tool's zod inputSchema (ranges, enums, refine, min/max) is
  // actually enforced. Without re-running that validation here, a bridge
  // caller can send out-of-schema values — e.g. a windowPoint xRel/yRel
  // outside [0,1], or an invalid enum — straight into the tool handler.
  // Re-validate against the same registered schema before dispatching.
  if (registered?.inputSchema) {
    const objSchema = normalizeObjectSchema(registered.inputSchema as never);
    const schemaToParse = objSchema ?? registered.inputSchema;
    const parsed = await safeParseAsync(schemaToParse as never, input);
    if (!parsed.success) {
      const message = `Invalid arguments for tool ${toolName}: ${getParseErrorMessage((parsed as { error: unknown }).error)}`;
      return {
        isError: true,
        structuredContent: { code: "INVALID_INPUT", error: message },
        content: [{ type: "text", text: message }],
      };
    }
    return handler(parsed.data as Record<string, unknown>);
  }
  return handler(input);
}

function resultText(result: CallToolResultLike): string {
  return (result.content ?? [])
    .map((item) => item.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function isScreenshotRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.includes(`${["", ".chatgpt2codex", "e2e", "screenshots", ""].join("/")}`) &&
    value.path.endsWith(".png")
  );
}

async function attachInlineScreenshotShares(
  ctx: ToolContext,
  publicOrigin: string,
  value: unknown,
): Promise<{ value: unknown; markdown: string[] }> {
  const markdown: string[] = [];
  async function visit(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) {
      return Promise.all(node.map((item) => visit(item)));
    }
    if (!isRecord(node)) return node;

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = await visit(child);
    }
    if (isScreenshotRecord(out)) {
      const share = await createE2eScreenshotShare(ctx.stateDir, String(out.path), publicOrigin);
      out.inlineUrl = share.url;
      out.inlineMarkdown = share.markdown;
      out.inlineExpiresAt = share.expiresAt;
      out.markdown = share.markdown;
      markdown.push(share.markdown);
    }
    return out;
  }
  return { value: await visit(value), markdown };
}

async function actionResponse(ctx: ToolContext, publicOrigin: string, tool: string, result: CallToolResultLike): Promise<Record<string, unknown>> {
  const enriched = await attachInlineScreenshotShares(ctx, publicOrigin, result.structuredContent ?? {});
  const text = resultText(result);
  const inlineText = enriched.markdown.length > 0 ? `${text}\n\n${enriched.markdown.join("\n")}` : text;
  const ok = result.isError !== true;
  return {
    ok,
    tool,
    toolCall: toolCallProof(tool, ok),
    text: inlineText,
    imageMarkdown: enriched.markdown[0],
    imageMarkdownList: enriched.markdown,
    structuredContent: enriched.value,
    ...(result.isError ? { isError: true } : {}),
  };
}

function openApiSpec(publicOrigin: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    "/actions/health": {
      get: {
        operationId: "action_health",
        summary: "Check chatgpt2codex action bridge health",
        security: [],
        responses: {
          "200": {
            description: "Health status",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/HealthResponse" } } },
          },
        },
      },
    },
    "/actions/call-tool": {
      post: {
        operationId: "call_tool",
        summary: "Call any chatgpt2codex MCP tool",
        description:
          "Full-power owner bridge for Custom GPTs. Use this when a dedicated action route is missing. It calls the named chatgpt2codex MCP tool on the local Mac; do not try to write /Users/... directly from ChatGPT's sandbox. For source edits: select project with preset=full-write, then call file_apply_patch or file_create through this route. The response toolCall object is the required proof that the local tool was actually callable.",
        security: [{ oauth2: ["chatgpt2codex"] }, { ownerBearer: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { "$ref": "#/components/schemas/CallToolInput" } } },
        },
        responses: {
          "200": {
            description: "Tool call result",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ActionToolResponse" } } },
          },
          "401": {
            description: "Missing or invalid OAuth/owner Bearer token",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
  };

  for (const route of openApiActionRoutes()) {
    paths[route.path] = {
      post: {
        operationId: route.tool,
        summary: route.summary,
        description: `ChatGPT_To_Codex tool: ${route.tool}. ${route.description}`,
        security: [{ oauth2: ["chatgpt2codex"] }, { ownerBearer: [] }],
        requestBody: {
          required: route.schema !== "EmptyInput",
          content: { "application/json": { schema: { "$ref": `#/components/schemas/${route.schema}` } } },
        },
        responses: {
          "200": {
            description: "Tool call result",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ActionToolResponse" } } },
          },
          "401": {
            description: "Missing or invalid OAuth/owner Bearer token",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "chatgpt2codex Custom GPT Actions",
      version: "0.1.6",
      description:
        "OpenAPI bridge for Custom GPTs. ChatGPT drives local coding actions through chatgpt2codex; the bridge does not embed a separate LLM coding client and is not intended to bypass any OpenAI product rate limit, usage limit, or safety restriction. Hard gate: do not claim local project inspection, edits, tests, commits, or image saves unless a current-turn ActionToolResponse includes ok=true and toolCall.namespace=ChatGPT_To_Codex. If the active ChatGPT app was Image Generation/ImageGen, image_gen, python_user_visible, or a text-only answer, no chatgpt2codex local work happened; reselect/reconnect ChatGPT To Codex or refresh this Action schema. For /goal or broad implementation prompts, call goal_intake or goal_loop immediately before long reasoning. This compact schema stays under 30 operations including action_health and call_tool, and exposes exact tool names such as workspace_list_projects, project_select, code_search, file_read_slice, file_apply_patch, file_create, local_shell_run, and e2e_test_and_show_screenshot for source editing and E2E proof. It avoids broad context-pack actions that ChatGPT safety may block; inspect with code_search followed by narrow file_read_slice calls instead. It also exposes E2E server/app launch plus screenshot capture. Hidden tools remain reachable through call_tool. ChatGPT's sandbox cannot write /Users/... directly; use these actions. For generated images, use a Share/Copy Link/content URL, copied image, download, or local path with save_chatgpt_image/save_chatgpt_image_from_url.",
      "x-chatgpt2codex-tool-proof": TOOL_AVAILABILITY_GATE,
      "x-chatgpt2codex-openapi-operation-count": Object.keys(paths).length,
      "x-chatgpt2codex-tool-names": openApiActionRoutes().map((route) => route.tool),
    },
    servers: [{ url: publicOrigin }],
    paths,
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          description: "Recommended for ChatGPT web/mobile GPT Actions. JK reuses the same owner-approved OAuth server as MCP.",
          flows: {
            authorizationCode: {
              authorizationUrl: `${publicOrigin}/authorize`,
              tokenUrl: `${publicOrigin}/token`,
              scopes: {
                chatgpt2codex: "Run owner-approved JK coding actions",
              },
            },
          },
        },
        ownerBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "chatgpt2codex-owner-token",
          description: "Use the chatgpt2codex owner token shown at init/setup time. Never commit it.",
        },
      },
      schemas: {
        EmptyInput: { type: "object", additionalProperties: false, properties: {} },
        CallToolInput: {
          type: "object",
          additionalProperties: false,
          required: ["toolName"],
          properties: {
            toolName: {
              type: "string",
              description:
                "Registered chatgpt2codex MCP tool name, e.g. file_apply_patch, file_create, local_shell_run, repo_status, git_commit, git_push.",
            },
            input: {
              type: "object",
              additionalProperties: true,
              description: "Input object passed directly to the named chatgpt2codex MCP tool.",
            },
          },
        },
        GoalIntakeInput: {
          type: "object",
          additionalProperties: false,
          required: ["goal"],
          properties: {
            goal: {
              type: "string",
              description:
                "The user's broad /goal, deep research, implementation, debugging, review, or planning request. Pass the full request text.",
            },
            projectId: { type: "string", description: "Optional known project id/name." },
            workSessionId: {
              type: "string",
              pattern: "^ws_[A-Za-z0-9_.-]+$",
              maxLength: 120,
              description: "Optional existing local work-session handle. If omitted for a known project, goal_intake creates one.",
            },
            mode: { type: "string", enum: ["implement", "research", "debug", "review", "plan"] },
            urgency: { type: "string", enum: ["normal", "fast"] },
          },
        },
        GoalLoopInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            goal: {
              type: "string",
              description:
                "The user's full coding goal. Required on the first loop call unless loopId is provided.",
            },
            loopId: {
              type: "string",
              description: "Existing local loop id returned by a previous goal_loop call.",
            },
            newLoop: {
              type: "boolean",
              description: "Set true only when intentionally starting a separate loop instead of resuming the active project/work-session loop.",
            },
            projectId: { type: "string", description: "Optional known project id/name." },
            workSessionId: {
              type: "string",
              pattern: "^ws_[A-Za-z0-9_.-]+$",
              maxLength: 120,
              description: "Work-session handle returned by goal_intake/goal_loop. Reuse it for the same isolated task.",
            },
            mode: { type: "string", enum: ["implement", "research", "debug", "review", "plan"] },
            maxTurns: { type: "integer", minimum: 1, maximum: 50, description: "Maximum ChatGPT action turns for this loop." },
            lastResult: {
              type: "string",
              description: "Short summary of the previous inspect/edit/verify batch before continuing.",
            },
            phase: {
              type: "string",
              enum: ["discover", "plan", "patch", "verify", "review", "recovery", "release"],
              description: "Optional explicit JK-native orchestration phase for this loop turn.",
            },
            verificationStatus: {
              type: "string",
              enum: ["unknown", "pass", "fail", "blocked"],
              description: "Result of the closest verification from the previous batch.",
            },
            failureCount: {
              type: "integer",
              minimum: 0,
              maximum: 20,
              description: "Consecutive failed verification/implementation attempts for recovery escalation.",
            },
            currentTask: {
              type: "string",
              maxLength: 500,
              description: "Current concrete task within the broader goal. Replaces the prior current task when provided.",
            },
            completed: {
              type: "array",
              maxItems: 50,
              items: { type: "string", maxLength: 500 },
              description: "Newly completed task items. They are merged into the project's completed history.",
            },
            pending: {
              type: "array",
              maxItems: 50,
              items: { type: "string", maxLength: 500 },
              description: "Current pending-task snapshot. Replaces the prior pending list when provided.",
            },
            decisions: {
              type: "array",
              maxItems: 10,
              description: "New design or implementation decisions worth preserving for later resume.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["summary"],
                properties: {
                  summary: { type: "string", maxLength: 500 },
                  rationale: { type: "string", maxLength: 1000 },
                },
              },
            },
          },
        },
        WorkspaceListProjectsInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            includeDirty: { type: "boolean" },
            includeRecent: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        WorkspaceRefreshIndexInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            depth: { type: "integer", minimum: 1 },
            includeHidden: { type: "boolean" },
          },
        },
        WorkspaceGetProjectInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            path: { type: "string" },
          },
        },
        ProjectOnlyInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        ProjectRulesInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: {
            projectId: { type: "string" },
            path: {
              type: "string",
              minLength: 1,
              description: "Optional project-relative file or directory path. Nested AGENTS.md/CLAUDE.md rules are returned root-to-leaf for this scope.",
            },
          },
        },
        SessionResumeInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            workSessionId: {
              type: "string",
              pattern: "^ws_[A-Za-z0-9_.-]+$",
              maxLength: 120,
              description: "Optional isolated work-session handle. Omit to use the legacy project-default context.",
            },
            includeActiveSlice: {
              type: "boolean",
              description: "When true, fresh-read the remembered active line range and return it with the resume metadata.",
            },
            maxActiveSliceLines: {
              type: "integer",
              minimum: 1,
              maximum: 300,
              description: "Maximum number of active-file lines to hydrate in the resume response. Default 160.",
            },
            validationScope: {
              type: "string",
              enum: ["active", "recent"],
              description: "Hash-validation scope. Defaults to recent for backward compatibility; active validates only the current artifact.",
            },
          },
        },
        ProjectSelectInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "reason"],
          properties: {
            projectId: { type: "string", description: "Project id or name, for example chatgpt2codex." },
            workSessionId: {
              type: "string",
              pattern: "^ws_[A-Za-z0-9_.-]+$",
              maxLength: 120,
              description: "Optional isolated work-session handle to select/resume within this project.",
            },
            resumeHint: {
              type: "string",
              maxLength: 1000,
              description: "Optional follow-up hint used to conservatively rank same-project work sessions when workSessionId is unknown.",
            },
            includeResumeContext: {
              type: "boolean",
              description: "When true, include validated recent work context directly in the project-select response.",
            },
            includeResumeSlice: {
              type: "boolean",
              description: "When resume context is included, fresh-read its remembered active line range. Defaults true for a resolved work session.",
            },
            maxResumeSliceLines: {
              type: "integer",
              minimum: 1,
              maximum: 300,
              description: "Maximum hydrated source lines returned inside fused resume context. Default 160.",
            },
            resumeValidationScope: {
              type: "string",
              enum: ["active", "recent"],
              description: "Hash-validation scope for fused resume. Defaults to active for the fast path; recent validates the full remembered working set.",
            },
            reason: { type: "string" },
            preset: {
              type: "string",
              enum: ["read-only", "tests-only", "full-write", "image-only"],
              description: "Defaults to full-write on the GPT Actions bridge when omitted.",
            },
            confirmSwitch: { type: "boolean" },
          },
        },
        CodeSearchInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "query"],
          properties: {
            projectId: { type: "string" },
            query: { type: "string" },
            mode: { type: "string", enum: ["text", "symbol", "semantic"] },
            maxResults: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
        FileReadSliceInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string" },
            workSessionId: { type: "string", pattern: "^ws_[A-Za-z0-9_.-]+$", maxLength: 120 },
            path: { type: "string" },
            start: { type: "integer", minimum: 1 },
            end: { type: "integer", minimum: 1 },
            offset: { type: "integer", minimum: 0 },
          },
        },
        FileApplyPatchInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "patch"],
          properties: {
            projectId: { type: "string" },
            workSessionId: { type: "string", pattern: "^ws_[A-Za-z0-9_.-]+$", maxLength: 120 },
            patch: { type: "string", description: "Codex-style *** Begin Patch envelope." },
            preconditionHashes: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        FileCreateInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "path", "content"],
          properties: {
            projectId: { type: "string" },
            workSessionId: { type: "string", pattern: "^ws_[A-Za-z0-9_.-]+$", maxLength: 120 },
            path: { type: "string" },
            content: { type: "string" },
            overwrite: { type: "boolean" },
          },
        },
        CommandRunInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "commandId"],
          properties: {
            projectId: { type: "string" },
            workSessionId: { type: "string", pattern: "^ws_[A-Za-z0-9_.-]+$", maxLength: 120 },
            commandId: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                expectedDurationSec: { type: "integer", minimum: 1 },
              },
            },
          },
        },
        LocalShellRunInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            workSessionId: { type: "string", pattern: "^ws_[A-Za-z0-9_.-]+$", maxLength: 120 },
            command: { type: "string" },
            cwd: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                reason: { type: "string" },
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
                approvalBundle: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "commands"],
                  properties: {
                    label: { type: "string", minLength: 1, maxLength: 160 },
                    commands: {
                      type: "array",
                      minItems: 1,
                      maxItems: 19,
                      items: { type: "string", minLength: 1 },
                    },
                    ttlMinutes: { type: "integer", minimum: 1, maximum: 30 },
                  },
                },
              },
            },
          },
        },
        OmoRunInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "message"],
          properties: {
            projectId: { type: "string" },
            message: { type: "string", minLength: 1 },
            agent: { type: "string" },
            model: { type: "string" },
            sessionId: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 3600 },
            verbose: { type: "boolean" },
          },
        },
        E2eStartServerInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            workSessionId: {
              type: "string",
              pattern: "^ws_[A-Za-z0-9_.-]+$",
              maxLength: 120,
              description: "Optional work-session handle; servers in the same session reuse/replace the same primary E2E slot by default.",
            },
            command: { type: "string", description: "Dev/server command to run in the project, e.g. npm run dev -- --host 127.0.0.1." },
            cwd: { type: "string", description: "Optional project-relative working directory." },
            label: { type: "string" },
            instanceKey: { type: "string", minLength: 1, maxLength: 80, description: "Optional named E2E server slot when a task intentionally needs multiple simultaneous servers." },
            waitUrl: { type: "string", description: "Optional URL to poll until ready." },
            waitTimeoutSec: { type: "integer", minimum: 1, maximum: 120 },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
              },
            },
          },
        },
        E2eOpenTargetInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string", description: "Required when appPath is project-relative or screenshot proof should be tied to a project." },
            url: { type: "string" },
            appName: { type: "string", description: "Installed macOS app name, e.g. Safari or ChatGPT." },
            appPath: { type: "string", description: "Absolute /Applications path or project-relative .app path." },
            args: { type: "array", items: { type: "string" } },
          },
        },
        E2eRunCommandInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "command"],
          properties: {
            projectId: { type: "string" },
            workSessionId: { type: "string", pattern: "^ws_[A-Za-z0-9_.-]+$", maxLength: 120 },
            command: { type: "string", description: "E2E/test command to run in the project, e.g. npm run test:e2e." },
            cwd: { type: "string", description: "Optional project-relative working directory." },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            label: { type: "string" },
            captureScreenshot: { type: "boolean", description: "Defaults to true. Set false only for non-visual E2E checks." },
            screenshotUrl: { type: "string", description: "Optional URL to open before the screenshot after the command exits." },
            screenshotWaitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
            intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                writesWorkspace: { type: "boolean" },
                needsNetwork: { type: "boolean" },
                destructive: { type: "boolean" },
              },
            },
          },
        },
        E2eTestAndShowScreenshotInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string", description: "Optional. If omitted, use the currently selected project." },
            workSessionId: { type: "string", pattern: "^ws_[A-Za-z0-9_.-]+$", maxLength: 120 },
            instruction: {
              type: "string",
              description: "The user's natural-language request, e.g. e2e 테스트하고 스크린샷 보여줘.",
            },
            url: { type: "string", description: "Optional local localhost/127.0.0.1 page URL to open before screenshot capture." },
            cwd: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 900 },
            screenshotWaitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
          },
        },
        E2eScreenshotInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: {
            projectId: { type: "string" },
            label: { type: "string" },
            waitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean", description: "Open the screenshot locally immediately after capture when supported." },
          },
        },
        E2eOpenUrlScreenshotInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "url"],
          properties: {
            projectId: { type: "string" },
            url: { type: "string" },
            label: { type: "string" },
            waitMs: { type: "integer", minimum: 0, maximum: 30000 },
            openAfterCapture: { type: "boolean" },
          },
        },
        CheckpointShowInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "checkpointId"],
          properties: {
            projectId: { type: "string" },
            checkpointId: { type: "string" },
          },
        },
        GitCommitInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "message"],
          properties: {
            projectId: { type: "string" },
            message: { type: "string" },
            paths: { type: "array", items: { type: "string" } },
          },
        },
        GitPushInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: {
            projectId: { type: "string" },
            remote: { type: "string" },
            branch: { type: "string" },
          },
        },
        SaveChatGptImageInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            destPath: { type: "string" },
            url: { type: "string" },
            sourcePath: { type: "string" },
            source: { type: "string", enum: ["auto", "url", "clipboard", "download", "path"] },
            maxAgeSec: { type: "integer", minimum: 1, maximum: 86400 },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        ImportChatGptImageUrlInput: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string" },
            projectId: { type: "string" },
            destPath: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        ListImagesInput: {
          type: "object",
          additionalProperties: false,
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        ActionToolResponse: {
          type: "object",
          required: ["ok", "tool", "toolCall", "text", "structuredContent"],
          properties: {
            ok: { type: "boolean" },
            tool: { type: "string" },
            toolCall: { "$ref": "#/components/schemas/ToolCallProof" },
            text: { type: "string" },
            imageMarkdown: {
              type: "string",
              description:
                "When present, the assistant must paste this exact markdown image in the final answer so the screenshot renders inline. Do not only report the local path.",
            },
            imageMarkdownList: {
              type: "array",
              items: { type: "string" },
              description: "All inline screenshot markdown images returned by this action.",
            },
            structuredContent: { type: "object", additionalProperties: true },
            isError: { type: "boolean" },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["ok", "name"],
          properties: {
            ok: { type: "boolean" },
            name: { type: "string" },
            actions: { type: "integer" },
            toolAvailabilityGate: { "$ref": "#/components/schemas/ToolAvailabilityGate" },
          },
        },
        ToolAvailabilityGate: {
          type: "object",
          additionalProperties: true,
          required: ["namespace", "app", "rule", "noResultMeans"],
          properties: {
            namespace: { type: "string" },
            app: { type: "string" },
            rule: { type: "string" },
            noResultMeans: { type: "string" },
            wrongSurfaceExamples: { type: "array", items: { type: "string" } },
          },
        },
        ToolCallProof: {
          type: "object",
          additionalProperties: true,
          required: ["namespace", "app", "tool", "ok", "currentTurnProof", "requiredBeforeCoding"],
          properties: {
            namespace: { type: "string" },
            app: { type: "string" },
            tool: { type: "string" },
            ok: { type: "boolean" },
            currentTurnProof: { type: "boolean" },
            requiredBeforeCoding: { type: "boolean" },
            proceedOnlyIfOk: { type: "boolean" },
            noToolResultMeansNoLocalWork: { type: "boolean" },
            instruction: { type: "string" },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["ok", "error"],
          properties: {
            ok: { type: "boolean" },
            error: { type: "string" },
          },
        },
      },
    },
  };
}

export function registerActionRoutes(
  app: Express,
  ctx: ToolContext,
  publicUrl: URL,
  oauthVerifier?: ActionAccessTokenVerifier,
  requiredScope = "chatgpt2codex",
): void {
  const publicOrigin = publicUrl.origin;

  app.get("/actions/health", (_req, res) => {
    res.json({
      ok: true,
      name: "chatgpt2codex-actions",
      actions: ACTION_ROUTES.length,
      openApiOperations: openApiActionRoutes().length + 2,
      openApiToolNames: openApiActionRoutes().map((route) => route.tool),
      toolAvailabilityGate: TOOL_AVAILABILITY_GATE,
    });
  });

  app.get("/actions/openapi.json", (_req, res) => {
    res.json(openApiSpec(publicOrigin));
  });

  app.get("/actions/e2e-screenshot-inline/:token/:filename", async (req, res) => {
    const share = await readE2eScreenshotShare(ctx.stateDir, String(req.params.token ?? ""));
    if (!share) {
      res.status(404).type("text/plain").send("Screenshot link expired or not found.");
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(share.bytes));
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Disposition", `inline; filename="${String(req.params.filename ?? "e2e-screenshot.png").replace(/"/g, "")}"`);
    res.send(await fs.readFile(share.path));
  });

  app.post("/actions/call-tool", async (req, res) => {
    if (!(await requireActionBearer(ctx, oauthVerifier, requiredScope, req, res))) return;
    const { toolName, input } = genericToolInput(req.body);
    if (!toolName) {
      res.status(400).json({ ok: false, error: "Missing toolName" });
      return;
    }
    const result = await callRegisteredTool(ctx, toolName, input);
    res.json(await actionResponse(ctx, publicOrigin, toolName, result));
  });

  for (const route of ACTION_ROUTES) {
    app.post(route.path, async (req, res) => {
      if (!(await requireActionBearer(ctx, oauthVerifier, requiredScope, req, res))) return;
      const result = await callRegisteredTool(ctx, route.tool, actionInputForRoute(route, req.body));
      res.json(await actionResponse(ctx, publicOrigin, route.tool, result));
    });
  }
}
