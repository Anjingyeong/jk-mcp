import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { ToolContext } from "../types.js";

/**
 * code_search filtered matches only by isSecretPath (a path-pattern denylist
 * for dotenv, key, token, and .aws-style paths, among others); it never
 * redact()ed the matched snippet text itself, unlike its sibling read tools
 * code_context_pack and file_read_slice, which both redact() their content
 * before returning it. A hardcoded secret in an ordinary file (src/config.ts,
 * a log, ...) would pass the path check and be returned to the model
 * verbatim — an unredacted side-channel for the exact secrets those other
 * tools mask.
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
  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => ({ activeProjectId: "proj", mode: "read", lease: null }),
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

describe("code_search snippet redaction", () => {
  let stateDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-search-redact-state-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-search-redact-project-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("redacts a hardcoded AWS key from a matched snippet in an ordinary (non-secret-path) source file", async () => {
    // Ordinary path — isSecretPath's path-pattern denylist does not cover
    // this, so redaction of the snippet content is the only remaining gate.
    await fs.writeFile(
      path.join(projectRoot, "config.ts"),
      'export const AWS_ACCESS_KEY_ID = "AKIAABCDEFGHIJKLMNOP";\n',
      "utf8",
    );

    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.code_search?.handler?.({ projectId: "proj", query: "AKIA" });

    expect(result?.isError).toBeFalsy();
    const matches = result?.structuredContent?.matches as Array<{ path: string; snippet: string }> | undefined;
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(matches)).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(JSON.stringify(result)).not.toContain("AKIAABCDEFGHIJKLMNOP");
    // The path itself (not a secret) still comes through unredacted.
    expect(matches?.some((m) => m.path === "config.ts")).toBe(true);
  });

  it("still returns a non-secret match's snippet verbatim (no over-redaction of ordinary code)", async () => {
    await fs.writeFile(path.join(projectRoot, "plain.ts"), "const needle = 42;\n", "utf8");

    const ctx = makeCtx(stateDir, projectRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.code_search?.handler?.({ projectId: "proj", query: "needle" });
    const matches = result?.structuredContent?.matches as Array<{ path: string; snippet: string }> | undefined;
    const match = matches?.find((m) => m.path === "plain.ts");

    expect(match?.snippet).toContain("needle");
  });
});
