import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeOwnerToken } from "../auth/owner-token.js";
import type { ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "./http.js";

/**
 * Non-negotiable gate #2: the generic action bridge (POST /actions/call-tool)
 * must never reach a desktop-control tool, even for the owner-bearer token,
 * even when the feature flag is on.
 */

const OWNER_TOKEN = "unit-test-owner-token-control-actions";

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function makeCtx(stateDir: string, projectRoot: string): ToolContext {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  let currentSession: unknown = { activeProjectId: null, mode: "observe", lease: null };
  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => currentSession,
      setSession: async (next) => {
        currentSession = next;
      },
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 10 * 1024 * 1024,
      maxPatchBytes: 10 * 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

async function startApp(ctx: ToolContext): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = await getFreePort();
  const running = createHttpServer(
    ctx,
    defaultHttpServerConfig({ host: "127.0.0.1", port, publicUrl: `http://127.0.0.1:${port}` }),
  );
  const server: Server = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      running.close();
    },
  };
}

async function postAction(baseUrl: string, pathName: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("control tool exclusion from the generic action bridge", () => {
  let stateDir: string;
  let projectRoot: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-actions-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-actions-proj-"));
    await storeOwnerToken(stateDir, OWNER_TOKEN);
    process.env.CHATGPT2CODEX_CONTROL = "1";
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_CONTROL;
    await stop?.();
    stop = undefined;
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("rejects computer_request_action via /actions/call-tool with PERMISSION_DENIED, even with a valid owner token and the feature flag on", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const res = await postAction(app.baseUrl, "/actions/call-tool", {
      toolName: "computer_request_action",
      input: { appName: "TextEdit", kind: "click", target: { windowPoint: { xRel: 0.5, yRel: 0.5 } }, reason: "test" },
    });
    const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string } };
    expect(body.ok).toBe(false);
    expect(body.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("rejects every one of the 4 control tool names via /actions/call-tool", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    for (const toolName of ["computer_screenshot", "computer_request_action", "computer_action_status", "computer_kill_switch"]) {
      const res = await postAction(app.baseUrl, "/actions/call-tool", { toolName, input: {} });
      const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string } };
      expect(body.ok, toolName).toBe(false);
      expect(body.structuredContent?.code, toolName).toBe("PERMISSION_DENIED");
    }
  });

  it("openapi.json never documents a route for any control tool", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const res = await fetch(`${app.baseUrl}/actions/openapi.json`);
    const body = (await res.json()) as { paths: Record<string, unknown> };
    for (const toolName of ["computer_screenshot", "computer_request_action", "computer_action_status", "computer_kill_switch"]) {
      const hit = Object.keys(body.paths).find((p) => p.includes(toolName.replace(/_/g, "-")));
      expect(hit, toolName).toBeUndefined();
    }
  });

  it("openapi.json's ProjectSelectInput.preset enum never advertises control to ChatGPT", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const res = await fetch(`${app.baseUrl}/actions/openapi.json`);
    const body = (await res.json()) as {
      components: { schemas: { ProjectSelectInput: { properties: { preset: { enum: string[] } } } } };
    };
    const presetEnum = body.components.schemas.ProjectSelectInput.properties.preset.enum;
    expect(presetEnum).not.toContain("control");
    expect(presetEnum).toEqual(["read-only", "tests-only", "full-write", "image-only"]);
  });
});
