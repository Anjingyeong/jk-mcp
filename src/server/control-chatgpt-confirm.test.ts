import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lease, ToolContext } from "../types.js";

/**
 * "ChatGPT confirm" model (CHATGPT2CODEX_CONTROL_CHATGPT): once the owner has
 * opted in, computer_request_action executes immediately through the exact
 * executor.ts path a local human approval would take, tagged
 * approvedVia:"chatgpt". mac-input is mocked throughout so no real synthetic
 * input / screen capture happens on the machine running this test.
 */

vi.mock("../control/mac-input.js", () => ({
  resolveFrontmostApp: vi.fn(async () => "TextEdit"),
  clickAtPoint: vi.fn(async () => undefined),
  clickAxElement: vi.fn(async () => undefined),
  resolveWindowPoint: vi.fn(async () => ({ x: 100, y: 100 })),
  typeText: vi.fn(async () => undefined),
  pressKey: vi.fn(async () => undefined),
  pressAxElement: vi.fn(async () => undefined),
  setAxValue: vi.fn(async () => undefined),
  resolveAxElement: vi.fn(async () => ({ found: false, reason: "not mocked" })),
  preflightPermissions: vi.fn(async () => ({ accessibilityTrusted: true, screenRecordingAllowed: true, source: "ax-helper" })),
}));

vi.mock("../e2e/local-e2e.js", () => ({
  captureE2eAppScreenshot: vi.fn(async () => ({ path: "/tmp/before-or-after.png", bytes: 1, opened: false, captureMode: "app-window" })),
  captureE2eScreenshot: vi.fn(async () => ({ path: "/tmp/screen.png", bytes: 1, opened: false, captureMode: "screen" })),
}));

const macInput = await import("../control/mac-input.js");
const { createServer } = await import("./mcp-server.js");

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  }>;
}

function makeCtx(
  stateDir: string,
  projectRoot: string,
  opts: { remote?: boolean } = {},
): { ctx: ToolContext; events: Array<Record<string, unknown>> } {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  let session: { activeProjectId: string | null; mode: string; lease: Lease | null } = {
    activeProjectId: "proj",
    mode: "read",
    lease: { projectId: "proj", leaseId: "l1", projectRoot, preset: "control", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
  };
  const events: Array<Record<string, unknown>> = [];
  const ctx: ToolContext = {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    remote: opts.remote,
    ledger: {
      append: async (event) => {
        events.push(event);
      },
    },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => {
        session = next as typeof session;
      },
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
  return { ctx, events };
}

async function registeredTools(ctx: ToolContext): Promise<Record<string, RegisteredToolLike>> {
  const server = await createServer(ctx);
  return (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
}

describe("computer_request_action immediate execution (CHATGPT2CODEX_CONTROL_CHATGPT=1)", () => {
  let stateDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-confirm-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-confirm-project-"));
    delete process.env.CHATGPT2CODEX_CONTROL;
    delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValue("TextEdit");
    vi.mocked(macInput.preflightPermissions).mockResolvedValue({
      accessibilityTrusted: true,
      screenRecordingAllowed: true,
      source: "ax-helper",
    });
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_CONTROL;
    delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
    vi.clearAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("executes immediately and returns status=done with approvedVia=chatgpt", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    const { ctx, events } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "chatgpt confirmed this",
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.status).toBe("done");
    expect(result?.structuredContent?.approvedVia).toBe("chatgpt");
    expect((result?.structuredContent?.result as { ok?: boolean } | undefined)?.ok).toBe(true);
    expect(macInput.clickAtPoint).toHaveBeenCalledWith("TextEdit", 100, 100);

    expect(events.some((e) => e.type === "control.action.requested")).toBe(true);
    const executed = events.find((e) => e.type === "control.action.executed");
    expect(executed).toMatchObject({ approvedVia: "chatgpt", ok: true });
    // Raw input text is never echoed back or audited.
    expect(JSON.stringify(events)).not.toContain("chatgpt confirmed this raw text");
  });

  it("still requires a control lease before the immediate-execution branch runs", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    const { ctx } = makeCtx(stateDir, projectRoot);
    await ctx.store.setSession({ activeProjectId: null, mode: "observe", lease: null });
    const tools = await registeredTools(ctx);

    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PROJECT_NOT_SELECTED");
    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
  });

  it("still blocks a sensitive-app target even when confirmed/exposed (hard floor #1)", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "1Password 7";
    const { ctx, events } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_request_action?.handler?.({
      appName: "1Password 7",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("SENSITIVE_TARGET_BLOCKED");
    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "control.action.blocked")).toBe(true);
    expect(events.some((e) => e.type === "control.action.executed")).toBe(false);
  });

  it("still blocks an app that is not on the allowlist even when confirmed/exposed", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "Notes";
    const { ctx } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("SENSITIVE_TARGET_BLOCKED");
    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
  });

  it("kill switch still stops immediate execution: a killed session rejects new requests with CONTROL_KILLED", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    const { ctx } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const killResult = await tools.computer_kill_switch?.handler?.({ reason: "stop" });
    expect(killResult?.isError).toBeFalsy();

    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("CONTROL_KILLED");
    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
  });

  it("blocks execution (marks done, ok=false) when the live frontmost app turns sensitive between request and execution", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    const { ctx, events } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    // Request-time frontmost check passes (TextEdit)...
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValueOnce("TextEdit");
    // ...but by execution time (executor.ts's own live re-check) something
    // sensitive has come to the front.
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValueOnce("1Password 7");

    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.status).toBe("done");
    expect((result?.structuredContent?.result as { ok?: boolean } | undefined)?.ok).toBe(false);
    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "control.action.blocked")).toBe(true);
  });

  it("falls back to pending (no immediate execution) when the flag is off", async () => {
    delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    const { ctx } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.status).toBe("pending");
    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
  });

  it("project_select rejects preset=control from a remote MCP session even when control is exposed to ChatGPT", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    const { ctx, events } = makeCtx(stateDir, projectRoot, { remote: true });
    await ctx.store.setSession({ activeProjectId: null, mode: "observe", lease: null });
    const tools = await registeredTools(ctx);

    const result = await tools.project_select?.handler?.({ projectId: "proj", reason: "remote self-grant attempt", preset: "control" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
    const session = (await ctx.store.getSession()) as { lease?: { preset?: string } | null } | null;
    expect(session?.lease?.preset ?? null).not.toBe("control");
    expect(events.some((e) => e.type === "control.bridge.rejected")).toBe(true);
  });

  it("caps how many actions can auto-execute in exposed mode, falling back to pending (local approval) once the rate limit is hit", async () => {
    // The server has no way to verify that each ChatGPT Confirm/Deny prompt
    // is a distinct, deliberate human tap rather than an auto-approve
    // client setting or a prompt-injected loop re-issuing the same request
    // — this is defense-in-depth against that gap, independent of the
    // sensitive-app/allowlist/kill-switch floors tested above.
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    const { ctx, events } = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const RATE_LIMIT_MAX = 20;
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const result = await tools.computer_request_action?.handler?.({
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: `bulk-${i}`,
      });
      expect(result?.structuredContent?.status).toBe("done");
    }

    const limited = await tools.computer_request_action?.handler?.({
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "should be rate-limited",
    });

    expect(limited?.isError).toBeFalsy();
    expect(limited?.structuredContent?.status).toBe("pending");
    expect(events.some((e) => e.type === "control.action.rate_limited")).toBe(true);
    // Rate limiting falls back to the normal queue — it never hard-fails or
    // silently drops the request.
    expect(macInput.clickAtPoint).toHaveBeenCalledTimes(RATE_LIMIT_MAX);
  }, 20_000);

  it("project_select still grants preset=control for a local (non-remote) session even when control is exposed to ChatGPT", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    const { ctx, events } = makeCtx(stateDir, projectRoot, { remote: false });
    await ctx.store.setSession({ activeProjectId: null, mode: "observe", lease: null });
    const tools = await registeredTools(ctx);

    const result = await tools.project_select?.handler?.({ projectId: "proj", reason: "local grant", preset: "control" });

    expect(result?.isError).toBeFalsy();
    expect((result?.structuredContent?.lease as { preset?: string } | undefined)?.preset).toBe("control");
    expect(events.some((e) => e.type === "control.granted")).toBe(true);
  });
});
