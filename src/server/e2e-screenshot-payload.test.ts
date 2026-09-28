import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lease, ToolContext } from "../types.js";

vi.mock("../e2e/local-e2e.js", async () => {
  const actual = await vi.importActual<typeof import("../e2e/local-e2e.js")>("../e2e/local-e2e.js");
  return {
    ...actual,
    captureE2eScreenshot: vi.fn(),
    createE2eScreenshotPreview: vi.fn(async () => null),
  };
});

const localE2e = await import("../e2e/local-e2e.js");
const { createServer } = await import("./mcp-server.js");

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    content?: Array<{ type?: string; data?: string }>;
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

function makeCtx(stateDir: string, projectRoot: string, publicUrl?: string): ToolContext {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  const lease: Lease = {
    projectId: "proj",
    leaseId: "lease",
    projectRoot,
    preset: "tests-only",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => ({ activeProjectId: "proj", mode: "verify", lease }),
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
      ...(publicUrl ? { publicUrl } : {}),
    },
  };
}

async function registeredTools(ctx: ToolContext): Promise<Record<string, RegisteredToolLike>> {
  const server = await createServer(ctx);
  return (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
}

describe("E2E screenshot delivery payload", () => {
  let stateDir: string;
  let projectRoot: string;
  let screenshotPath: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "jk-e2e-payload-state-"));
    projectRoot = await mkdtemp(path.join(os.tmpdir(), "jk-e2e-payload-project-"));
    const screenshotDir = path.join(projectRoot, ".jk", "e2e", "screenshots");
    screenshotPath = path.join(screenshotDir, "large.png");
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(screenshotPath, Buffer.alloc(1024 * 1024, 0x41));
    vi.mocked(localE2e.captureE2eScreenshot).mockResolvedValue({
      path: screenshotPath,
      bytes: 1024 * 1024,
      opened: false,
      captureMode: "screen",
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(stateDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("uses only the short-lived URL when WebGPT widget delivery is available", async () => {
    // Given an HTTP/WebGPT context with a large captured image.
    const tools = await registeredTools(makeCtx(stateDir, projectRoot, "https://jk.example.test"));

    // When the capture result is prepared for delivery.
    const result = await tools.e2e_screenshot?.handler?.({ projectId: "proj" });

    // Then no image bytes are duplicated into either result channel.
    expect(result?.isError).not.toBe(true);
    expect(result?.content?.filter((item) => item.type === "image")).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("data:image/");
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
    expect(result?._meta?.["chatgpt2codex/screenshots"]).toEqual([
      expect.objectContaining({ url: expect.stringMatching(/^https:\/\/jk\.example\.test\/actions\/e2e-screenshot-inline\//u) }),
    ]);
  });
});
