import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lease, ToolContext } from "../types.js";

/**
 * Full-screen computer_screenshot (appName omitted) must apply the same
 * sensitive-app gate as an app-targeted capture, checked against the *live*
 * frontmost app since a full-screen capture shows whatever is frontmost.
 * See src/control/screenshot-mask.ts assertScreenshotTargetAllowed and
 * src/control/tools.ts handleComputerScreenshot.
 */

vi.mock("../control/mac-input.js", () => ({
  resolveFrontmostApp: vi.fn(async () => "TextEdit"),
}));

vi.mock("../e2e/local-e2e.js", () => ({
  captureE2eScreenshot: vi.fn(async () => ({ path: "", bytes: 1, opened: false, captureMode: "screen" })),
  captureE2eAppScreenshot: vi.fn(async () => ({ path: "", bytes: 1, opened: false, captureMode: "app" })),
}));

const macInput = await import("../control/mac-input.js");
const localE2e = await import("../e2e/local-e2e.js");
const { createServer } = await import("./mcp-server.js");

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  }>;
}

function makeCtx(stateDir: string, projectRoot: string): ToolContext {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  let session: { activeProjectId: string | null; mode: string; lease: Lease | null } = {
    activeProjectId: "proj",
    mode: "read",
    lease: { projectId: "proj", leaseId: "l1", projectRoot, preset: "control", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
  };
  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
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
}

async function registeredTools(ctx: ToolContext): Promise<Record<string, RegisteredToolLike>> {
  const server = await createServer(ctx);
  return (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
}

describe("computer_screenshot full-screen sensitive-app gate", () => {
  let stateDir: string;
  let projectRoot: string;
  let fakePng: string;

  beforeEach(async () => {
    process.env.CHATGPT2CODEX_CONTROL = "1";
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-screenshot-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-screenshot-proj-"));
    fakePng = path.join(stateDir, "fake.png");
    await fs.writeFile(fakePng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    vi.mocked(macInput.resolveFrontmostApp).mockReset();
    vi.mocked(localE2e.captureE2eScreenshot).mockReset().mockResolvedValue({
      path: fakePng,
      bytes: 4,
      opened: false,
      captureMode: "screen",
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

  it("allows a full-screen capture when the live frontmost app is not sensitive", async () => {
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValue("TextEdit");
    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_screenshot?.handler?.({});

    expect(result?.isError).toBeFalsy();
    expect(localE2e.captureE2eScreenshot).toHaveBeenCalledTimes(1);
  });

  it("blocks a full-screen capture (SENSITIVE_TARGET_BLOCKED) when a sensitive app is frontmost", async () => {
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValue("1Password 7");
    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_screenshot?.handler?.({});

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("SENSITIVE_TARGET_BLOCKED");
    expect(localE2e.captureE2eScreenshot).not.toHaveBeenCalled();
  });

  // A full-screen capture (`screencapture -x`) captures every visible window
  // on the display, not just the frontmost one, so the frontmost-only
  // denylist/allowlist check above cannot see a background sensitive-app
  // window. In the ChatGPT-exposed (remotely reachable) mode, full-screen
  // capture is refused outright — only an explicit, allowlisted appName is
  // accepted — instead of trusting the frontmost app alone.
  it("blocks full-screen capture entirely when exposed to ChatGPT, even with a non-sensitive frontmost app (background-window leak guard)", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValue("TextEdit");
    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_screenshot?.handler?.({});

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("SENSITIVE_TARGET_BLOCKED");
    expect(localE2e.captureE2eScreenshot).not.toHaveBeenCalled();
    delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
  });

  it("still allows an app-targeted capture when exposed to ChatGPT and the app is allowlisted", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    vi.mocked(localE2e.captureE2eAppScreenshot).mockResolvedValueOnce({
      path: fakePng,
      bytes: 4,
      opened: false,
      captureMode: "app-window",
    });
    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_screenshot?.handler?.({ appName: "TextEdit" });

    expect(result?.isError).toBeFalsy();
    expect(localE2e.captureE2eAppScreenshot).toHaveBeenCalledTimes(1);
    delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
  });

  // computer_request_action (click/type/key) enforces both the sensitive-app
  // denylist AND the explicit control allowlist via assertAllowedTarget. The
  // screenshot path must apply the same allowlist gate, not just the
  // denylist, or any non-denylisted app (Mail, Messages, a private editor,
  // ...) could be captured even though it could never be clicked/typed into.
  it("blocks an app-targeted capture when the app is not on the control allowlist (even though it isn't sensitive)", async () => {
    // No CHATGPT2CODEX_CONTROL_ALLOWLIST set => allowlist is empty by default.
    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.computer_screenshot?.handler?.({ appName: "Mail" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("SENSITIVE_TARGET_BLOCKED");
    expect(localE2e.captureE2eAppScreenshot).not.toHaveBeenCalled();
  });

  it("mapControlError redacts a secret-looking underlying error before it reaches the ledger or the tool result", async () => {
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValue("TextEdit");
    vi.mocked(localE2e.captureE2eAppScreenshot).mockRejectedValueOnce(
      new Error("capture helper failed: leaked token AKIAABCDEFGHIJKLMNOP in subprocess output"),
    );
    const ctx = makeCtx(stateDir, projectRoot);
    const events: Array<Record<string, unknown>> = [];
    ctx.ledger = { append: async (event) => { events.push(event); } };
    const tools = await registeredTools(ctx);

    const result = await tools.computer_screenshot?.handler?.({ appName: "TextEdit" });

    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(JSON.stringify(events)).not.toContain("AKIAABCDEFGHIJKLMNOP");
    // A failed tool.call.failed event must still be recorded (redacted), not silently dropped.
    expect(events.some((e) => e.type === "tool.call.failed")).toBe(true);
  });
});
