import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, ToolContext } from "../types.js";

/**
 * e2e_run_command's `screenshotUrl` input reached captureE2eUrlScreenshot
 * (which drives the owner's real, cookie-bearing Chrome via osascript) with
 * no isLocalHttpUrl-style validation anywhere on this path — unlike the
 * sibling tools e2e_open_target and e2e_open_url_screenshot, which both
 * validate the URL before ever calling in. This is the same SSRF/local-file-
 * read vector, reachable through a third, previously-unguarded tool input.
 * Exercises the actual tool handler end-to-end (real project + granted
 * lease + real shell command), not just the shared local-e2e.ts helper.
 */

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  }>;
}

function makeCtx(stateDir: string, projectRoot: string): ToolContext {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  const lease: Lease = {
    projectId: "proj",
    leaseId: "l1",
    projectRoot,
    preset: "full-write",
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
      getSession: async () => ({ activeProjectId: "proj", mode: "read", lease }),
      setSession: async () => undefined,
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

describe("e2e_run_command screenshotUrl guard", () => {
  let stateDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-e2e-url-guard-state-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-e2e-url-guard-project-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("rejects a non-local screenshotUrl instead of driving Chrome to it", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.e2e_run_command?.handler?.({
      projectId: "proj",
      command: "true",
      screenshotUrl: "file:///etc/passwd",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("APPROVAL_REQUIRED");
    expect(result?.structuredContent?.approvalRequired).toBe(true);
    expect(result?.structuredContent?.approvalPending).toBe(false);
    expect(result?.structuredContent?.approvalInstruction).toContain("Do not tell the user");
  }, 15_000);

  it("still allows a local loopback screenshotUrl to pass validation (no over-blocking)", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.e2e_run_command?.handler?.({
      projectId: "proj",
      command: "true",
      captureScreenshot: false, // avoid a real screencapture/Chrome call in CI
      screenshotUrl: "http://127.0.0.1:1/",
    });

    // captureScreenshot:false means the (validated) screenshotUrl is never
    // actually used to capture — this only proves the command itself ran
    // and wasn't rejected purely for having a loopback screenshotUrl set.
    expect(result?.isError).toBeFalsy();
    expect((result?.structuredContent as { exitCode?: number } | undefined)?.exitCode).toBe(0);
  }, 15_000);
});
