import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTROL_TOOL_NAMES = ["computer_screenshot", "computer_request_action", "computer_action_status", "computer_kill_switch"];

function makeCtx(): ToolContext {
  const stateDir = "/tmp/chatgpt2codex-tools-catalog-test";
  return {
    workspaceRoot: "/tmp",
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
      workspaceRoot: "/tmp",
      stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

describe("tool catalog", () => {
  it("returns path-scoped project rules from root to leaf", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jk-project-rules-"));
    try {
      await fs.mkdir(path.join(root, ".codex"), { recursive: true });
      await fs.mkdir(path.join(root, "src", "feature"), { recursive: true });
      await fs.writeFile(path.join(root, ".codex", "config.toml"), "root-config = true\n");
      await fs.writeFile(path.join(root, "AGENTS.md"), "# root agents\n");
      await fs.writeFile(path.join(root, "src", "AGENTS.md"), "# src agents\n");
      await fs.writeFile(path.join(root, "src", "feature", "CLAUDE.md"), "# feature rules\n");
      await fs.writeFile(path.join(root, "src", "feature", "file.ts"), "export {};\n");

      const entry: ProjectRegistryEntry = {
        projectId: "rules-test",
        name: "rules-test",
        root,
        aliases: ["rules-test"],
      };
      const ctx = makeCtx();
      ctx.registry = [entry];
      ctx.store.loadProjects = async () => [entry];
      const server = await createServer(ctx);
      const tools = (server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      })._registeredTools;
      const result = (await tools?.project_rules?.handler?.({
        projectId: "rules-test",
        path: "src/feature/file.ts",
      })) as {
        structuredContent?: {
          scopePath?: string;
          hierarchical?: boolean;
          rules?: Array<{ file: string; summary: string }>;
        };
      };

      expect(result.structuredContent?.scopePath).toBe("src/feature/file.ts");
      expect(result.structuredContent?.hierarchical).toBe(true);
      expect(result.structuredContent?.rules?.map((rule) => rule.file)).toEqual([
        ".codex/config.toml",
        "AGENTS.md",
        "src/AGENTS.md",
        "src/feature/CLAUDE.md",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exposes structured semantic-progress fields on goal_loop", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
      }
    )._registeredTools;
    const shape = tools?.goal_loop?.inputSchema?.shape;

    expect(shape?.workSessionId).toBeDefined();
    expect(shape?.currentTask).toBeDefined();
    expect(shape?.completed).toBeDefined();
    expect(shape?.pending).toBeDefined();
    expect(shape?.decisions).toBeDefined();
    expect(shape?.phase).toBeDefined();
    expect(shape?.verificationStatus).toBeDefined();
    expect(shape?.failureCount).toBeDefined();
    expect(tools?.work_session_list).toBeDefined();
    expect(tools?.session_resume?.inputSchema?.shape?.workSessionId).toBeDefined();
    expect(tools?.session_resume?.inputSchema?.shape?.includeActiveSlice).toBeDefined();
    expect(tools?.session_resume?.inputSchema?.shape?.maxActiveSliceLines).toBeDefined();
    expect(tools?.session_resume?.inputSchema?.shape?.validationScope).toBeDefined();
    expect(tools?.file_read_slice?.inputSchema?.shape?.workSessionId).toBeDefined();
    expect(tools?.project_select?.inputSchema?.shape?.resumeHint).toBeDefined();
    expect(tools?.project_select?.inputSchema?.shape?.includeResumeContext).toBeDefined();
    expect(tools?.project_select?.inputSchema?.shape?.includeResumeSlice).toBeDefined();
    expect(tools?.project_select?.inputSchema?.shape?.maxResumeSliceLines).toBeDefined();
    expect(tools?.project_select?.inputSchema?.shape?.resumeValidationScope).toBeDefined();
    const localShellIntent = tools?.local_shell_run?.inputSchema?.shape?.intent as
      | { _def?: { innerType?: { shape?: Record<string, unknown> } } }
      | undefined;
    expect(localShellIntent?._def?.innerType?.shape?.approvedByHuman).toBeUndefined();
    expect(tools?.omo_run).toBeDefined();
    expect(tools?.omo_run?.inputSchema?.shape?.agent).toBeDefined();
    expect(tools?.omo_run?.inputSchema?.shape?.sessionId).toBeDefined();
  });

  it("keeps the one-shot E2E tool out of destructive/open-world routing", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { annotations?: Record<string, unknown>; inputSchema?: { shape?: Record<string, unknown> } }>;
      }
    )._registeredTools;
    const oneShot = tools?.e2e_test_and_show_screenshot;

    expect(oneShot?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(oneShot?.inputSchema?.shape?.serverCommand).toBeUndefined();
    expect(oneShot?.inputSchema?.shape?.testCommand).toBeUndefined();
    expect(oneShot?.inputSchema?.shape?.waitUrl).toBeUndefined();
  });

  it("declares the ChatGPT widget template for E2E screenshot tools", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { _meta?: Record<string, unknown> }>;
      }
    )._registeredTools;

    for (const name of ["e2e_test_and_show_screenshot", "e2e_screenshot", "e2e_open_url_screenshot", "e2e_run_command"]) {
      expect(tools?.[name]?._meta?.["openai/outputTemplate"], name).toBe("ui://widget/e2e-screenshots.html");
    }

    const resources = (
      server as unknown as {
        _registeredResources?: Record<
          string,
          {
            metadata?: { mimeType?: string; _meta?: Record<string, unknown> };
            readCallback?: (uri: URL) => Promise<{ contents: Array<{ mimeType?: string; text?: string }> }>;
          }
        >;
      }
    )._registeredResources;
    const widget = resources?.["ui://widget/e2e-screenshots.html"];
    expect(widget?.metadata?.mimeType).toBe("text/html+skybridge");
    expect(widget?.metadata?._meta?.["openai/widgetCSP"]).toBeDefined();

    const read = await widget?.readCallback?.(new URL("ui://widget/e2e-screenshots.html"));
    const content = read?.contents?.[0];
    expect(content?.mimeType).toBe("text/html+skybridge");
    expect(content?.text).toContain("chatgpt2codex/screenshots");
    expect(content?.text).toContain("openai:set_globals");
    expect(content?.text).toContain("dataUri");
  });

  it("exposes GPT Image 2 import routing and ChatGPT URL intake", async () => {
    const server = await createServer(makeCtx());
    const tools = (server as unknown as { _registeredTools?: Record<string, { description?: string; handler?: (input: unknown) => Promise<unknown> }> })
      ._registeredTools;

    expect(tools?.gpt_image_2_generate).toBeUndefined();
    expect(tools?.open_chatgpt_images_app?.description).toContain("ChatGPT Images app");
    expect(tools?.save_chatgpt_image?.description).toContain("Single app-friendly");
    expect(tools?.save_chatgpt_image_from_url?.description).toContain("ChatGPT-generated image");
    expect(tools?.save_chatgpt_image_from_url?.description).toContain("chatgpt.com/s/m_...");
    expect(tools?.save_chatgpt_screen_images).toBeUndefined();
    expect(tools?.generate_chatgpt_image).toBeUndefined();
    expect(tools?.chatgpt_image_loop).toBeUndefined();
    expect(tools?.list_pending_images).toBeUndefined();
    expect(tools?.save_image_from_pending).toBeUndefined();

    const guide = tools?.gpt_image_2_workflow;
    expect(guide?.description).toContain("import workflow");

    const result = (await guide?.handler?.({})) as {
      structuredContent?: {
        chatgpt2codexToolCall?: { namespace?: string; tool?: string; ok?: boolean };
        toolAvailabilityGate?: { namespace?: string };
        doThis?: string[];
        fallback?: string[];
        notThis?: string[];
        saveTools?: string[];
      };
      content?: Array<{ text: string }>;
    };
    expect(result.structuredContent?.chatgpt2codexToolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "gpt_image_2_workflow",
      ok: true,
    });
    expect(result.structuredContent?.toolAvailabilityGate?.namespace).toBe("ChatGPT_To_Codex");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("reselect ChatGPT To Codex");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("Generate with ChatGPT's native image surface");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("chatgpt.com/s/m_...");
    expect(result.structuredContent?.fallback?.join(" ")).toContain("Share/Copy Link");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("Do not call a separate Codex or OpenAI Images API");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("python_user_visible");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("automatic capture helpers");
    expect(result.structuredContent?.saveTools).toContain("open_chatgpt_images_app");
    expect(result.structuredContent?.saveTools).toContain("save_chatgpt_image");
    expect(result.structuredContent?.saveTools).toContain("save_chatgpt_image_from_url");
    expect(result.structuredContent?.saveTools).toContain("save_image_from_url");
    expect(result.content?.[0]?.text).toContain("native ChatGPT GPT Image 2 generation first");
  });

  it("keeps broad context-pack off the ChatGPT-visible tool list", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { description?: string }>;
      }
    )._registeredTools;

    expect(tools?.code_context_pack).toBeDefined();
    expect(tools?.code_context_pack?.description).toContain("ChatGPT should prefer code_search");

    const handler = (
      server.server as unknown as {
        _requestHandlers?: Map<
          string,
          (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
        >;
      }
    )._requestHandlers?.get("tools/list");
    const listed = await handler?.({ method: "tools/list", params: {} });
    expect(listed?.tools.map((tool) => tool.name)).not.toContain("code_context_pack");
  });

  it("agent_guide exposes Codex-grade loop, tool surface, and safety model", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;

    const result = (await tools?.agent_guide?.handler?.({})) as {
      structuredContent?: {
        codexGradeLoop?: string[];
        toolSurfaceMap?: Record<string, string[]>;
        securityModel?: string[];
        desktopControlModel?: string[];
      };
    };

    expect(result.structuredContent?.codexGradeLoop?.join(" ")).toContain("Discover");
    expect(result.structuredContent?.codexGradeLoop?.join(" ")).toContain("Verify");
    expect(result.structuredContent?.toolSurfaceMap?.modify).toEqual(
      expect.arrayContaining(["file_apply_patch", "file_create", "local_shell_run"]),
    );
    expect(result.structuredContent?.toolSurfaceMap?.verify).toEqual(
      expect.arrayContaining(["e2e_test_and_show_screenshot", "e2e_run_command"]),
    );
    expect(result.structuredContent?.securityModel?.join(" ")).toContain("current-turn ChatGPT_To_Codex tool proof");
    expect(result.structuredContent?.securityModel?.join(" ")).toContain("Prompt-injection posture");
    expect(result.structuredContent?.desktopControlModel?.join(" ")).toContain("kill switch");
    expect(result.structuredContent?.desktopControlModel?.join(" ")).toContain("sensitive apps");
  });

  describe("ChatGPT confirm-model exposure (CHATGPT2CODEX_CONTROL_CHATGPT)", () => {
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    });

    async function toolsListNames(): Promise<string[]> {
      const server = await createServer(makeCtx());
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{
              tools: Array<{ name: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }>;
            }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      return listed?.tools.map((t) => t.name) ?? [];
    }

    it("hides the 4 control tools from tools/list by default (flag unset)", async () => {
      const names = await toolsListNames();
      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }
    });

    it.each(["0", "false", "off"])("hides the 4 control tools from tools/list when explicitly opted out (%s)", async (value) => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = value;
      const names = await toolsListNames();
      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }
    });

    it("exposes all 4 control tools in tools/list once CHATGPT2CODEX_CONTROL_CHATGPT=1, with oauth2 securitySchemes and Confirm/Deny-driving annotations", async () => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
      const server = await createServer(makeCtx());
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{
              tools: Array<{
                name: string;
                annotations?: Record<string, unknown>;
                securitySchemes?: Array<{ type?: string; scopes?: string[] }>;
                _meta?: Record<string, unknown>;
              }>;
            }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      const byName = new Map((listed?.tools ?? []).map((t) => [t.name, t]));

      for (const name of CONTROL_TOOL_NAMES) {
        const tool = byName.get(name);
        expect(tool, name).toBeDefined();
        expect(tool?.securitySchemes, name).toMatchObject([{ type: "oauth2", scopes: ["chatgpt2codex"] }]);
        expect(tool?._meta?.["openai/visibility"], name).toBe("public");
      }

      // request_action / kill_switch / screenshot must drive ChatGPT's
      // client-side Confirm/Deny prompt (non-read-only, destructive);
      // action_status is a pure read and must not prompt.
      expect(byName.get("computer_request_action")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_kill_switch")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_screenshot")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_action_status")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });
  });
});
