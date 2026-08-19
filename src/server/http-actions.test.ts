import { createServer as createNodeServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeOwnerToken } from "../auth/owner-token.js";
import type { Lease, ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "./http.js";

const OWNER_TOKEN = "unit-test-owner-token-123456";

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomPkceVerifier(): string {
  return base64Url(randomBytes(32));
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

async function startApp(ctx: ToolContext): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = await getFreePort();
  const running = createHttpServer(
    ctx,
    defaultHttpServerConfig({
      host: "127.0.0.1",
      port,
      publicUrl: `http://127.0.0.1:${port}`,
    }),
  );
  const server: Server = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      running.close();
    },
  };
}

function makeCtx(
  stateDir: string,
  projectRoot: string,
  extraProjects: Array<{ projectId: string; name: string; root: string }> = [],
): ToolContext {
  const registry = [
    {
      projectId: "proj",
      name: "proj",
      root: projectRoot,
      aliases: [],
    },
    ...extraProjects.map((project) => ({ ...project, aliases: [] })),
  ];
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

async function postAction(baseUrl: string, pathName: string, body: unknown, token = OWNER_TOKEN): Promise<Response> {
  return fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function registerOAuthClient(baseUrl: string): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUri = "https://chatgpt.com/aip/gpt/oauth/callback";
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT",
    }),
  });
  const body = (await res.json()) as { client_id?: string };

  expect(res.status).toBe(201);
  expect(body.client_id).toBeTruthy();
  return { clientId: String(body.client_id), redirectUri };
}

function authorizeUrl(baseUrl: string, clientId: string, redirectUri: string): URL {
  const url = new URL("/authorize", baseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", "unit-test-code-challenge");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "chatgpt2codex");
  url.searchParams.set("state", "unit-test-state");
  url.searchParams.set("resource", `${baseUrl}/mcp`);
  return url;
}

async function authorizeWithOwnerToken(
  baseUrl: string,
  client: { clientId: string; redirectUri: string },
  codeChallenge: string,
): Promise<string> {
  const url = authorizeUrl(baseUrl, client.clientId, client.redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
  const page = await pageRes.text();
  const csrfToken = page.match(/name="csrf_token" value="([^"]+)"/u)?.[1];

  expect(pageRes.status).toBe(200);
  expect(csrfToken).toBeTruthy();

  const body = new URLSearchParams(url.searchParams);
  body.set("csrf_token", String(csrfToken));
  body.set("owner_token", OWNER_TOKEN);

  const res = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: {
      origin: "https://chatgpt.com",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    redirect: "manual",
  });
  const location = res.headers.get("location");
  const redirectUrl = new URL(location ?? "http://missing.invalid");

  expect(res.status).toBe(302);
  expect(redirectUrl.origin).toBe("https://chatgpt.com");
  expect(redirectUrl.searchParams.get("state")).toBe("unit-test-state");
  const code = redirectUrl.searchParams.get("code");
  expect(code).toMatch(/^code-/u);
  return String(code);
}

describe("Custom GPT action bridge", () => {
  let stateDir: string;
  let projectRoot: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-actions-state-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-actions-project-"));
    await storeOwnerToken(stateDir, OWNER_TOKEN);
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = undefined;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("serves an OpenAPI schema for GPT Actions", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/actions/openapi.json`);
    const body = (await res.json()) as {
      openapi: string;
      info: {
        version: string;
        description: string;
        "x-chatgpt2codex-tool-proof"?: { namespace?: string };
        "x-chatgpt2codex-openapi-operation-count"?: number;
        "x-chatgpt2codex-tool-names"?: string[];
      };
      servers: Array<{ url: string }>;
      paths: Record<string, { get?: { operationId?: string }; post?: { summary?: string; description?: string; operationId?: string } } | unknown>;
      components: {
        securitySchemes: {
          oauth2?: {
            flows?: {
              authorizationCode?: { authorizationUrl?: string; tokenUrl?: string; scopes?: Record<string, string> };
            };
          };
          ownerBearer?: Record<string, unknown>;
        };
        schemas: {
          CallToolInput: { properties: Record<string, unknown> };
          GoalIntakeInput: Record<string, unknown>;
          GoalLoopInput: Record<string, unknown>;
          SessionResumeInput: Record<string, unknown>;
          E2eRunCommandInput: Record<string, unknown>;
          E2eTestAndShowScreenshotInput: Record<string, unknown>;
          E2eScreenshotInput: Record<string, unknown>;
          E2eStartServerInput: Record<string, unknown>;
          FileApplyPatchInput: { properties: Record<string, unknown> };
          FileCreateInput: { properties: Record<string, unknown> };
          ActionToolResponse: { required?: string[]; properties: Record<string, unknown> };
          ToolCallProof: Record<string, unknown>;
          ToolAvailabilityGate: Record<string, unknown>;
        };
      };
    };

    expect(res.status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.version).toBe("0.1.6");
    expect(body.info.description).toContain("source editing");
    expect(body.info.description).toContain("cannot write /Users/");
    expect(body.info.description).toContain("30 operations");
    expect(body.info.description).toContain("workspace_list_projects");
    expect(body.info.description).toContain("save_chatgpt_image/save_chatgpt_image_from_url");
    expect(body.info["x-chatgpt2codex-tool-proof"]?.namespace).toBe("ChatGPT_To_Codex");
    expect(body.info["x-chatgpt2codex-openapi-operation-count"]).toBeLessThanOrEqual(30);
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("workspace_list_projects");
    expect(body.info["x-chatgpt2codex-tool-names"]).toContain("e2e_test_and_show_screenshot");
    expect(body.info["x-chatgpt2codex-tool-names"]).not.toContain("code_context_pack");
    expect(body.info.description).toContain("toolCall.namespace=ChatGPT_To_Codex");
    expect(body.components.securitySchemes.oauth2?.flows?.authorizationCode?.authorizationUrl).toBe(`${server.baseUrl}/authorize`);
    expect(body.components.securitySchemes.oauth2?.flows?.authorizationCode?.tokenUrl).toBe(`${server.baseUrl}/token`);
    expect(body.components.securitySchemes.oauth2?.flows?.authorizationCode?.scopes?.chatgpt2codex).toBeTruthy();
    expect(body.components.securitySchemes.ownerBearer).toBeDefined();
    expect(body.servers[0]?.url).toBe(server.baseUrl);
    expect(body.paths["/actions/call-tool"]).toBeDefined();
    expect((body.paths["/actions/call-tool"] as { post: { operationId: string } }).post.operationId).toBe("call_tool");
    expect(body.paths["/actions/file-apply-patch"]).toBeDefined();
    expect((body.paths["/actions/file-apply-patch"] as { post: { operationId: string } }).post.operationId).toBe("file_apply_patch");
    expect(body.paths["/actions/file-create"]).toBeDefined();
    expect(body.paths["/actions/local-shell-run"]).toBeDefined();
    expect((body.paths["/actions/local-shell-run"] as { post: { operationId: string } }).post.operationId).toBe("local_shell_run");
    expect(body.paths["/actions/omo-run"]).toBeDefined();
    expect((body.paths["/actions/omo-run"] as { post: { operationId: string } }).post.operationId).toBe("omo_run");
    expect(body.paths["/actions/goal-intake"]).toBeDefined();
    expect(body.paths["/actions/goal-loop"]).toBeDefined();
    expect(body.paths["/actions/e2e-start-server"]).toBeDefined();
    expect(body.paths["/actions/e2e-run-command"]).toBeDefined();
    expect(body.paths["/actions/e2e-test-and-show-screenshot"]).toBeDefined();
    expect((body.paths["/actions/e2e-test-and-show-screenshot"] as { post: { operationId: string } }).post.operationId).toBe(
      "e2e_test_and_show_screenshot",
    );
    expect(body.paths["/actions/e2e-screenshot"]).toBeDefined();
    expect(body.paths["/actions/e2e-open-url-screenshot"]).toBeDefined();
    expect(body.paths["/actions/code-context-pack"]).toBeUndefined();
    expect(body.info.description).toContain("goal_intake");
    expect(body.info.description).toContain("goal_loop");
    expect(body.info.description).toContain("code_search followed by narrow file_read_slice");
    expect(body.info.description).toContain("E2E server/app launch plus screenshot capture");
    expect(body.paths["/actions/save-visible-chatgpt-images"]).toBeUndefined();
    expect(body.paths["/actions/chatgpt-image-loop"]).toBeUndefined();
    expect(body.paths["/actions/generate-chatgpt-image"]).toBeUndefined();
    expect(body.paths["/actions/workspace-refresh-index"]).toBeUndefined();
    expect(body.paths["/actions/checkpoint-list"]).toBeUndefined();
    expect(body.paths["/actions/project-select"]).toBeDefined();
    expect((body.paths["/actions/project-select"] as { post: { operationId: string } }).post.operationId).toBe("project_select");
    expect(body.paths["/actions/session-resume"]).toBeDefined();
    expect((body.paths["/actions/session-resume"] as { post: { operationId: string } }).post.operationId).toBe("session_resume");
    expect(body.components.schemas.GoalIntakeInput).toBeDefined();
    expect(body.components.schemas.GoalLoopInput).toBeDefined();
    expect(body.components.schemas.SessionResumeInput).toBeDefined();
    expect((body.components.schemas.GoalIntakeInput as { properties?: Record<string, unknown> }).properties?.workSessionId).toBeDefined();
    expect((body.components.schemas.GoalLoopInput as { properties?: Record<string, unknown> }).properties?.workSessionId).toBeDefined();
    expect((body.components.schemas.GoalLoopInput as { properties?: Record<string, unknown> }).properties?.newLoop).toBeDefined();
    expect((body.components.schemas.GoalLoopInput as { properties?: Record<string, unknown> }).properties?.phase).toBeDefined();
    expect((body.components.schemas.GoalLoopInput as { properties?: Record<string, unknown> }).properties?.verificationStatus).toBeDefined();
    expect((body.components.schemas.GoalLoopInput as { properties?: Record<string, unknown> }).properties?.failureCount).toBeDefined();
    expect((body.components.schemas.SessionResumeInput as { properties?: Record<string, unknown> }).properties?.workSessionId).toBeDefined();
    expect((body.components.schemas.SessionResumeInput as { properties?: Record<string, unknown> }).properties?.includeActiveSlice).toBeDefined();
    expect((body.components.schemas.SessionResumeInput as { properties?: Record<string, unknown> }).properties?.maxActiveSliceLines).toBeDefined();
    expect((body.components.schemas.SessionResumeInput as { properties?: Record<string, unknown> }).properties?.validationScope).toBeDefined();
    expect((body.components.schemas.ProjectSelectInput as { properties?: Record<string, unknown> }).properties?.resumeHint).toBeDefined();
    expect((body.components.schemas.ProjectSelectInput as { properties?: Record<string, unknown> }).properties?.includeResumeContext).toBeDefined();
    expect((body.components.schemas.ProjectSelectInput as { properties?: Record<string, unknown> }).properties?.includeResumeSlice).toBeDefined();
    expect((body.components.schemas.ProjectSelectInput as { properties?: Record<string, unknown> }).properties?.maxResumeSliceLines).toBeDefined();
    expect((body.components.schemas.ProjectSelectInput as { properties?: Record<string, unknown> }).properties?.resumeValidationScope).toBeDefined();
    const localShellIntent = (
      body.components.schemas.LocalShellRunInput as {
        properties?: { intent?: { properties?: Record<string, unknown> } };
      }
    ).properties?.intent;
    expect(localShellIntent?.properties?.approvedByHuman).toBeUndefined();
    expect(body.paths["/actions/work-session-list"]).toBeUndefined();
    expect(body.components.schemas.E2eRunCommandInput).toBeDefined();
    expect(body.components.schemas.E2eTestAndShowScreenshotInput).toBeDefined();
    expect((body.components.schemas.E2eTestAndShowScreenshotInput as { properties?: Record<string, unknown> }).properties?.serverCommand).toBeUndefined();
    expect((body.components.schemas.E2eTestAndShowScreenshotInput as { properties?: Record<string, unknown> }).properties?.testCommand).toBeUndefined();
    expect((body.components.schemas.E2eTestAndShowScreenshotInput as { properties?: Record<string, unknown> }).properties?.waitUrl).toBeUndefined();
    expect(body.components.schemas.E2eScreenshotInput).toBeDefined();
    expect(body.components.schemas.E2eStartServerInput).toBeDefined();
    expect((body.components.schemas.E2eStartServerInput as { properties?: Record<string, unknown> }).properties?.workSessionId).toBeDefined();
    expect((body.components.schemas.E2eStartServerInput as { properties?: Record<string, unknown> }).properties?.instanceKey).toBeDefined();
    expect(body.components.schemas.OmoRunInput).toBeDefined();
    expect((body.components.schemas.OmoRunInput as { required?: string[] }).required).toEqual(["projectId", "message"]);
    expect((body.components.schemas.OmoRunInput as { properties?: Record<string, unknown> }).properties?.sessionId).toBeDefined();
    expect((body.components.schemas.OmoRunInput as { properties?: Record<string, unknown> }).properties?.timeoutSec).toBeDefined();
    expect(body.components.schemas.CallToolInput.properties.toolName).toBeDefined();
    expect(body.components.schemas.FileApplyPatchInput.properties.patch).toBeDefined();
    expect(body.components.schemas.FileCreateInput.properties.content).toBeDefined();
    expect(body.components.schemas.ActionToolResponse.required).toContain("toolCall");
    expect(body.components.schemas.ActionToolResponse.properties.toolCall).toBeDefined();
    expect(body.components.schemas.ToolCallProof).toBeDefined();
    expect(body.components.schemas.ToolAvailabilityGate).toBeDefined();
    expect((body.paths["/actions/import-chatgpt-image-url"] as { post: { description: string } }).post.description).toContain(
      "Device-agnostic",
    );
    expect((body.paths["/actions/import-chatgpt-image-url"] as { post: { description: string } }).post.description).toContain(
      "chatgpt.com/s/m_...",
    );
  });

  it("exposes the tool-call gate on action health", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/actions/health`);
    const body = (await res.json()) as {
      ok: boolean;
      name: string;
      actions?: number;
      openApiOperations?: number;
      openApiToolNames?: string[];
      toolAvailabilityGate?: { namespace?: string; noResultMeans?: string; wrongSurfaceExamples?: string[] };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.name).toBe("chatgpt2codex-actions");
    expect(body.actions).toBeGreaterThan(body.openApiOperations ?? 0);
    expect(body.openApiOperations).toBeLessThanOrEqual(30);
    expect(body.openApiToolNames).toContain("workspace_list_projects");
    expect(body.openApiToolNames).toContain("project_select");
    expect(body.openApiToolNames).toContain("session_resume");
    expect(body.openApiToolNames).toContain("file_apply_patch");
    expect(body.openApiToolNames).toContain("local_shell_run");
    expect(body.openApiToolNames).toContain("omo_run");
    expect(body.openApiToolNames).toContain("e2e_test_and_show_screenshot");
    expect(body.openApiToolNames).not.toContain("code_context_pack");
    expect(body.toolAvailabilityGate?.namespace).toBe("ChatGPT_To_Codex");
    expect(body.toolAvailabilityGate?.noResultMeans).toContain("No local project work happened");
    expect(body.toolAvailabilityGate?.wrongSurfaceExamples).toContain("image_gen");
  });

  it("requires the owner bearer token for action calls", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/actions/agent-guide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Bearer token");
  });

  it("serves a public privacy notice for GPT Actions", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/privacy`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("chatgpt2codex privacy notice");
    expect(text).toContain("Custom GPT Actions");
  });

  it("serves the OAuth owner-token prompt inside ChatGPT without frame blocking", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);

    const res = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' https://chatgpt.com https://chat.openai.com",
    );
    expect(res.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://chatgpt.com https://chat.openai.com",
    );
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(text).toContain("Connect JK");
    expect(text).toContain("Local approval");
    expect(text).toContain("Connector URL");
    expect(text).toContain("Owner token");
    expect(text).toContain('<form method="post" action="/authorize">');
    expect(text).toContain('name="owner_token" type="password"');
    expect(text).toContain('autocomplete="one-time-code"');
    expect(text).toContain('id="owner_token_toggle"');
    expect(text).toContain('aria-label="Show owner token"');
    expect(text).toContain('src="/assets/owner-token-toggle.js"');
    expect(text).not.toMatch(/Owner passw[o]rd/);
    expect(text).not.toContain("current-password");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");

    const scriptRes = await fetch(`${server.baseUrl}/assets/owner-token-toggle.js`);
    const script = await scriptRes.text();
    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get("content-type")).toContain("application/javascript");
    expect(script).toContain('input.type = visible ? "text" : "password"');
  });

  it("serves OpenID discovery as an OAuth metadata compatibility alias", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/.well-known/openid-configuration`);
    const body = (await res.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      token_endpoint_auth_methods_supported?: string[];
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.issuer).toBe(`${server.baseUrl}/`);
    expect(body.authorization_endpoint).toBe(`${server.baseUrl}/authorize`);
    expect(body.token_endpoint).toBe(`${server.baseUrl}/token`);
    expect(body.registration_endpoint).toBe(`${server.baseUrl}/register`);
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("does not reject OAuth authorization pages with Origin not allowed", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);

    const res = await fetch(url, { headers: { origin: "chrome-extension://codex-test" } });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("Owner token");
    expect(text).not.toContain("Origin not allowed");
  });

  it("localizes OAuth authorization pages from ui_locales", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);
    url.searchParams.set("ui_locales", "ko-KR en");

    const res = await fetch(url, { headers: { origin: "chrome-extension://codex-test" } });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('lang="ko"');
    expect(text).toContain("로컬 승인");
    expect(text).toContain("소유자 토큰");
    expect(text).toContain("JK 승인");
  });

  it("accepts ChatGPT-origin OAuth form posts instead of blocking token entry", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);
    const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
    const page = await pageRes.text();
    const csrfToken = page.match(/name="csrf_token" value="([^"]+)"/)?.[1];

    expect(pageRes.status).toBe(200);
    expect(csrfToken).toBeTruthy();

    const body = new URLSearchParams(url.searchParams);
    body.set("csrf_token", String(csrfToken));
    body.set("owner_token", "wrong-owner-token");

    const res = await fetch(`${server.baseUrl}/authorize`, {
      method: "POST",
      headers: {
        origin: "https://chatgpt.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "manual",
    });
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(text).toContain("The owner token was not accepted.");
  });

  it("accepts a valid owner token when the OAuth approval form csrf is stale", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);

    const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
    await pageRes.text();

    expect(pageRes.status).toBe(200);

    const body = new URLSearchParams(url.searchParams);
    body.set("csrf_token", "stale-csrf-token-after-app-restart");
    body.set("owner_token", OWNER_TOKEN);

    const res = await fetch(`${server.baseUrl}/authorize`, {
      method: "POST",
      headers: {
        origin: "https://chatgpt.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "manual",
    });
    const location = res.headers.get("location");
    const redirectUrl = new URL(location ?? "http://missing.invalid");

    expect(res.status).toBe(302);
    expect(redirectUrl.origin).toBe("https://chatgpt.com");
    expect(redirectUrl.searchParams.get("code")).toMatch(/^code-/);
    expect(redirectUrl.searchParams.get("state")).toBe("unit-test-state");
  });

  it("exchanges OAuth codes for public clients without a client_secret", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const verifier = randomPkceVerifier();
    const code = await authorizeWithOwnerToken(server.baseUrl, client, pkceChallenge(verifier));
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code,
      code_verifier: verifier,
      resource: `${server.baseUrl}/mcp`,
    });

    const res = await fetch(`${server.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const body = (await res.json()) as { access_token?: string; token_type?: string };

    expect(res.status).toBe(200);
    expect(body.token_type?.toLowerCase()).toBe("bearer");
    expect(body.access_token).toBeTruthy();

    const actionRes = await postAction(server.baseUrl, "/actions/agent-guide", {}, String(body.access_token));
    const actionBody = (await actionRes.json()) as { ok?: boolean; tool?: string };
    expect(actionRes.status).toBe(200);
    expect(actionBody.ok).toBe(true);
    expect(actionBody.tool).toBe("agent_guide");
  });

  it("rejects OAuth token exchange when the PKCE verifier does not match", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const client = await registerOAuthClient(server.baseUrl);
    const verifier = randomPkceVerifier();
    const code = await authorizeWithOwnerToken(server.baseUrl, client, pkceChallenge(verifier));
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code,
      code_verifier: randomPkceVerifier(),
      resource: `${server.baseUrl}/mcp`,
    });

    const res = await fetch(`${server.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    expect(res.status).toBe(400);
  });

  it("still rejects untrusted browser origins for the MCP endpoint", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: "https://not-chatgpt.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const body = (await res.json()) as { error?: { message?: string } };

    expect(res.status).toBe(403);
    expect(body.error?.message).toBe("Origin not allowed");
  });

  it("fires idle shutdown callback when no MCP session is active", async () => {
    const port = await getFreePort();
    let idleCount = 0;
    const ctx = makeCtx(stateDir, projectRoot);
    const idlePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("idle shutdown did not fire")), 500);
      const running = createHttpServer(
        ctx,
        defaultHttpServerConfig({
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          idleShutdownMs: 20,
          onIdleTimeout: () => {
            idleCount++;
            clearTimeout(timeout);
            resolve();
          },
        }),
      );
      const server: Server = running.app.listen(port, "127.0.0.1");
      stop = async () => {
        await new Promise<void>((done, fail) => {
          server.close((err) => (err ? fail(err) : done()));
        });
        running.close();
      };
    });

    await idlePromise;
    expect(idleCount).toBe(1);
  });

  it("bridges action requests to registered MCP tools", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const guideRes = await postAction(server.baseUrl, "/actions/agent-guide", {});
    const guide = (await guideRes.json()) as {
      ok: boolean;
      text: string;
      toolCall?: { namespace?: string; ok?: boolean; requiredBeforeCoding?: boolean };
      structuredContent: { workflow?: string[]; toolAvailabilityGate?: { namespace?: string } };
    };

    expect(guideRes.status).toBe(200);
    expect(guide.ok).toBe(true);
    expect(guide.toolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      ok: true,
      requiredBeforeCoding: true,
    });
    expect(guide.structuredContent.toolAvailabilityGate?.namespace).toBe("ChatGPT_To_Codex");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("no chatgpt2codex work happened");
    expect(guide.text).toContain("chatgpt2codex can operate");
    expect(guide.structuredContent.workflow).toContain("workspace_list_projects or workspace_refresh_index");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("device-agnostic/mobile");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("goal_intake immediately");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("goal_loop");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("Avoid broad context-pack calls");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("e2e_test_and_show_screenshot");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("e2e_start_server");
    expect(guide.structuredContent.workflow?.join(" ")).toContain("Automatic visible-image capture");

    const selectRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "unit test",
    });
    const selected = (await selectRes.json()) as { ok: boolean; structuredContent: { lease?: Lease } };

    expect(selectRes.status).toBe(200);
    expect(selected.ok).toBe(true);
    expect(selected.structuredContent.lease?.projectId).toBe("proj");
    expect(selected.structuredContent.lease?.preset).toBe("full-write");

    const createRes = await postAction(server.baseUrl, "/actions/file-create", {
      projectId: "proj",
      path: "direct-action.txt",
      content: "written by action\n",
    });
    const created = (await createRes.json()) as { ok: boolean; structuredContent: { path?: string } };

    expect(createRes.status).toBe(200);
    expect(created.ok).toBe(true);
    expect(created.structuredContent.path).toBe("direct-action.txt");
    await expect(fs.readFile(path.join(projectRoot, "direct-action.txt"), "utf8")).resolves.toBe("written by action\n");

    const proxyRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "file_create",
      input: {
        projectId: "proj",
        path: "proxy-action.txt",
        content: "written by call-tool\n",
      },
    });
    const proxied = (await proxyRes.json()) as {
      ok: boolean;
      tool: string;
      toolCall?: { namespace?: string; tool?: string; ok?: boolean };
      structuredContent: { path?: string; chatgpt2codexToolCall?: { namespace?: string; tool?: string; ok?: boolean } };
    };

    expect(proxyRes.status).toBe(200);
    expect(proxied.ok).toBe(true);
    expect(proxied.tool).toBe("file_create");
    expect(proxied.toolCall).toMatchObject({ namespace: "ChatGPT_To_Codex", tool: "file_create", ok: true });
    expect(proxied.structuredContent.chatgpt2codexToolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "file_create",
      ok: true,
    });
    expect(proxied.structuredContent.path).toBe("proxy-action.txt");
    await expect(fs.readFile(path.join(projectRoot, "proxy-action.txt"), "utf8")).resolves.toBe("written by call-tool\n");
  });

  it("resumes recent work, preserves it on same-project reselect, and flags external edits as stale", async () => {
    await fs.writeFile(path.join(projectRoot, "portfolio.html"), "<html>v1</html>\n", "utf8");
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const selectRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "start portfolio work",
    });
    expect(selectRes.status).toBe(200);

    const readRes = await postAction(server.baseUrl, "/actions/file-read-slice", {
      projectId: "proj",
      path: "portfolio.html",
      start: 1,
      end: 1,
    });
    expect(readRes.status).toBe(200);

    const reselectRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "follow-up turn",
    });
    expect(reselectRes.status).toBe(200);

    const resumeRes = await postAction(server.baseUrl, "/actions/session-resume", { projectId: "proj" });
    const resumed = (await resumeRes.json()) as {
      ok: boolean;
      structuredContent: {
        hasContext?: boolean;
        activeArtifact?: string | null;
        activeArtifactStale?: boolean | null;
        recentFiles?: Array<{ path?: string; stale?: boolean; start?: number; end?: number }>;
      };
    };
    expect(resumeRes.status).toBe(200);
    expect(resumed.ok).toBe(true);
    expect(resumed.structuredContent.hasContext).toBe(true);
    expect(resumed.structuredContent.activeArtifact).toBe("portfolio.html");
    expect(resumed.structuredContent.activeArtifactStale).toBe(false);
    expect(resumed.structuredContent.recentFiles?.[0]).toMatchObject({
      path: "portfolio.html",
      stale: false,
      start: 1,
      end: 1,
    });

    await fs.writeFile(path.join(projectRoot, "portfolio.html"), "<html>externally changed</html>\n", "utf8");

    const staleRes = await postAction(server.baseUrl, "/actions/session-resume", { projectId: "proj" });
    const stale = (await staleRes.json()) as {
      ok: boolean;
      structuredContent: {
        activeArtifactStale?: boolean | null;
        recentFiles?: Array<{ path?: string; stale?: boolean }>;
      };
    };
    expect(staleRes.status).toBe(200);
    expect(stale.ok).toBe(true);
    expect(stale.structuredContent.activeArtifactStale).toBe(true);
    expect(stale.structuredContent.recentFiles?.[0]).toMatchObject({ path: "portfolio.html", stale: true });
  });

  it("hydrates the remembered active range in one resume call and preserves the range across edits", async () => {
    const initial = Array.from({ length: 8 }, (_, index) => `initial-${index + 1}`).join("\n") + "\n";
    await fs.writeFile(path.join(projectRoot, "hydration.html"), initial, "utf8");
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    expect((await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "hydrate remembered range",
    })).status).toBe(200);

    expect((await postAction(server.baseUrl, "/actions/file-read-slice", {
      projectId: "proj",
      path: "hydration.html",
      start: 2,
      end: 5,
    })).status).toBe(200);

    const edited = Array.from({ length: 8 }, (_, index) => `edited-${index + 1}`).join("\n") + "\n";
    expect((await postAction(server.baseUrl, "/actions/file-create", {
      projectId: "proj",
      path: "hydration.html",
      content: edited,
      overwrite: true,
    })).status).toBe(200);

    const hydratedRes = await postAction(server.baseUrl, "/actions/session-resume", {
      projectId: "proj",
      includeActiveSlice: true,
    });
    const hydrated = (await hydratedRes.json()) as {
      ok: boolean;
      structuredContent: {
        activeArtifactStale?: boolean | null;
        activePatchPreconditionHashes?: Record<string, string> | null;
        recentFiles?: Array<{ path?: string; start?: number; end?: number }>;
        activeSlice?: {
          path?: string;
          start?: number;
          end?: number;
          rememberedStart?: number;
          rememberedEnd?: number;
          content?: string;
          staleAtResume?: boolean;
          truncated?: boolean;
        } | null;
      };
    };
    expect(hydratedRes.status).toBe(200);
    expect(hydrated.ok).toBe(true);
    expect(hydrated.structuredContent.activeArtifactStale).toBe(false);
    expect(hydrated.structuredContent.recentFiles?.[0]).toMatchObject({
      path: "hydration.html",
      start: 2,
      end: 5,
    });
    expect(hydrated.structuredContent.activeSlice).toMatchObject({
      path: "hydration.html",
      start: 2,
      end: 5,
      rememberedStart: 2,
      rememberedEnd: 5,
      staleAtResume: false,
      truncated: false,
    });
    expect(hydrated.structuredContent.activeSlice?.content).toContain("edited-2");
    expect(hydrated.structuredContent.activeSlice?.content).toContain("edited-5");

    const external = Array.from({ length: 8 }, (_, index) => `external-${index + 1}`).join("\n") + "\n";
    await fs.writeFile(path.join(projectRoot, "hydration.html"), external, "utf8");

    const staleHydratedRes = await postAction(server.baseUrl, "/actions/session-resume", {
      projectId: "proj",
      includeActiveSlice: true,
      maxActiveSliceLines: 2,
    });
    const staleHydrated = (await staleHydratedRes.json()) as typeof hydrated;
    expect(staleHydratedRes.status).toBe(200);
    expect(staleHydrated.ok).toBe(true);
    expect(staleHydrated.structuredContent.activeArtifactStale).toBe(true);
    expect(staleHydrated.structuredContent.activeSlice).toMatchObject({
      start: 2,
      end: 3,
      rememberedStart: 2,
      rememberedEnd: 5,
      staleAtResume: true,
      truncated: true,
    });
    expect(staleHydrated.structuredContent.activeSlice?.content).toContain("external-2");
    expect(staleHydrated.structuredContent.activeSlice?.content).toContain("external-3");
    expect(staleHydrated.structuredContent.activeSlice?.content).not.toContain("external-4");

    const resumePreconditions = staleHydrated.structuredContent.activePatchPreconditionHashes;
    expect(resumePreconditions?.["hydration.html"]).toMatch(/^[a-f0-9]{64}$/);
    const casPatchRes = await postAction(server.baseUrl, "/actions/file-apply-patch", {
      projectId: "proj",
      patch: [
        "*** Begin Patch",
        "*** Update File: hydration.html",
        "@@",
        "-external-2",
        "+cas-patched-2",
        "*** End Patch",
      ].join("\n"),
      preconditionHashes: resumePreconditions,
    });
    const casPatch = (await casPatchRes.json()) as { ok: boolean };
    expect(casPatchRes.status).toBe(200);
    expect(casPatch.ok).toBe(true);
    await expect(fs.readFile(path.join(projectRoot, "hydration.html"), "utf8")).resolves.toContain("cas-patched-2");

    const postPatchResumeRes = await postAction(server.baseUrl, "/actions/session-resume", {
      projectId: "proj",
      includeActiveSlice: true,
    });
    const postPatchResume = (await postPatchResumeRes.json()) as typeof hydrated;
    const stalePreconditions = postPatchResume.structuredContent.activePatchPreconditionHashes;
    expect(stalePreconditions?.["hydration.html"]).toMatch(/^[a-f0-9]{64}$/);

    const raced = Array.from({ length: 8 }, (_, index) => `raced-${index + 1}`).join("\n") + "\n";
    await fs.writeFile(path.join(projectRoot, "hydration.html"), raced, "utf8");
    const rejectedPatchRes = await postAction(server.baseUrl, "/actions/file-apply-patch", {
      projectId: "proj",
      patch: [
        "*** Begin Patch",
        "*** Update File: hydration.html",
        "@@",
        "-cas-patched-2",
        "+should-not-apply",
        "*** End Patch",
      ].join("\n"),
      preconditionHashes: stalePreconditions,
    });
    const rejectedPatch = (await rejectedPatchRes.json()) as {
      ok: boolean;
      structuredContent: { code?: string };
    };
    expect(rejectedPatchRes.status).toBe(200);
    expect(rejectedPatch.ok).toBe(false);
    expect(rejectedPatch.structuredContent.code).toBe("HASH_MISMATCH");
    await expect(fs.readFile(path.join(projectRoot, "hydration.html"), "utf8")).resolves.not.toContain("should-not-apply");
  });

  it("keeps recent-file order and stale semantics while resume hashes are bounded-parallel", async () => {
    for (let i = 1; i <= 6; i += 1) {
      await fs.writeFile(path.join(projectRoot, `resume-${i}.txt`), `v1-${i}\n`, "utf8");
    }
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    expect((await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "parallel resume hash ordering",
    })).status).toBe(200);

    for (let i = 1; i <= 6; i += 1) {
      const read = await postAction(server.baseUrl, "/actions/file-read-slice", {
        projectId: "proj",
        path: `resume-${i}.txt`,
        start: 1,
        end: 1,
      });
      expect(read.status).toBe(200);
    }

    await fs.writeFile(path.join(projectRoot, "resume-3.txt"), "external-3\n", "utf8");

    const fastResumeRes = await postAction(server.baseUrl, "/actions/session-resume", {
      projectId: "proj",
      validationScope: "active",
    });
    const fastResumed = (await fastResumeRes.json()) as {
      ok: boolean;
      structuredContent: {
        validationScope?: "active" | "recent";
        validatedRecentFileCount?: number;
        recentFiles?: Array<{
          path?: string;
          validated?: boolean;
          stale?: boolean | null;
          exists?: boolean | null;
          currentHash?: string | null;
        }>;
      };
    };
    expect(fastResumeRes.status).toBe(200);
    expect(fastResumed.ok).toBe(true);
    expect(fastResumed.structuredContent.validationScope).toBe("active");
    expect(fastResumed.structuredContent.validatedRecentFileCount).toBe(1);
    const fastRecent = fastResumed.structuredContent.recentFiles ?? [];
    expect(fastRecent.find((file) => file.path === "resume-6.txt")).toMatchObject({
      validated: true,
      stale: false,
      exists: true,
    });
    expect(fastRecent.find((file) => file.path === "resume-3.txt")).toMatchObject({
      validated: false,
      stale: null,
      exists: null,
      currentHash: null,
    });

    const resumeRes = await postAction(server.baseUrl, "/actions/session-resume", { projectId: "proj" });
    const resumed = (await resumeRes.json()) as {
      ok: boolean;
      structuredContent: {
        validationScope?: "active" | "recent";
        validatedRecentFileCount?: number;
        recentFiles?: Array<{ path?: string; validated?: boolean; stale?: boolean | null; exists?: boolean | null; currentHash?: string | null }>;
      };
    };
    expect(resumeRes.status).toBe(200);
    expect(resumed.ok).toBe(true);
    expect(resumed.structuredContent.validationScope).toBe("recent");
    expect(resumed.structuredContent.validatedRecentFileCount).toBe(6);
    const recent = resumed.structuredContent.recentFiles ?? [];
    expect(recent.map((file) => file.path)).toEqual([
      "resume-6.txt",
      "resume-5.txt",
      "resume-4.txt",
      "resume-3.txt",
      "resume-2.txt",
      "resume-1.txt",
    ]);
    expect(recent.find((file) => file.path === "resume-3.txt")?.stale).toBe(true);
    expect(recent.filter((file) => file.path !== "resume-3.txt").every((file) => file.stale === false)).toBe(true);
    expect(recent.every((file) => file.validated === true && file.exists === true && typeof file.currentHash === "string")).toBe(true);
  });

  it("preserves per-project work context with last mutation and verification across project switches", async () => {
    const secondProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-actions-project-two-"));
    await fs.writeFile(path.join(projectRoot, "portfolio.html"), "<html>project one</html>\n", "utf8");
    await fs.writeFile(path.join(secondProjectRoot, "other.html"), "<html>project two</html>\n", "utf8");

    try {
      const server = await startApp(
        makeCtx(stateDir, projectRoot, [{ projectId: "proj2", name: "proj2", root: secondProjectRoot }]),
      );
      stop = server.stop;

      expect((await postAction(server.baseUrl, "/actions/project-select", {
        projectId: "proj",
        reason: "phase2 project one",
      })).status).toBe(200);

      expect((await postAction(server.baseUrl, "/actions/file-read-slice", {
        projectId: "proj",
        path: "portfolio.html",
        start: 1,
        end: 1,
      })).status).toBe(200);

      const verifyRes = await postAction(server.baseUrl, "/actions/local-shell-run", {
        projectId: "proj",
        command: "node --version",
        intent: { writesWorkspace: false },
      });
      expect(verifyRes.status).toBe(200);

      const createRes = await postAction(server.baseUrl, "/actions/file-create", {
        projectId: "proj",
        path: "phase2.txt",
        content: "phase2\n",
      });
      expect(createRes.status).toBe(200);

      expect((await postAction(server.baseUrl, "/actions/project-select", {
        projectId: "proj2",
        reason: "switch to project two",
        confirmSwitch: true,
      })).status).toBe(200);
      expect((await postAction(server.baseUrl, "/actions/file-read-slice", {
        projectId: "proj2",
        path: "other.html",
        start: 1,
        end: 1,
      })).status).toBe(200);

      const returnToOneRes = await postAction(server.baseUrl, "/actions/project-select", {
        projectId: "proj",
        reason: "return to project one",
        confirmSwitch: true,
      });
      expect(returnToOneRes.status).toBe(200);
      const returnToOne = (await returnToOneRes.json()) as {
        structuredContent: { hasRecentContext?: boolean; instruction?: string };
      };
      expect(returnToOne.structuredContent.hasRecentContext).toBe(true);
      expect(returnToOne.structuredContent.instruction).toContain("session_resume");

      const resumeOneRes = await postAction(server.baseUrl, "/actions/session-resume", { projectId: "proj" });
      const resumeOne = (await resumeOneRes.json()) as {
        ok: boolean;
        structuredContent: {
          activeArtifact?: string | null;
          lastMutation?: { tool?: string; checkpointId?: string; files?: Array<{ path?: string; action?: string }> } | null;
          lastVerification?: { tool?: string; command?: string; success?: boolean; exitCode?: number | null } | null;
        };
      };
      expect(resumeOne.ok).toBe(true);
      expect(resumeOne.structuredContent.activeArtifact).toBe("phase2.txt");
      expect(resumeOne.structuredContent.lastMutation).toMatchObject({
        tool: "file_create",
        files: [{ path: "phase2.txt", action: "create" }],
      });
      expect(resumeOne.structuredContent.lastVerification).toMatchObject({
        tool: "local_shell_run",
        command: "node --version",
        success: true,
        exitCode: 0,
      });

      expect((await postAction(server.baseUrl, "/actions/project-select", {
        projectId: "proj2",
        reason: "verify project two context",
        confirmSwitch: true,
      })).status).toBe(200);
      const resumeTwoRes = await postAction(server.baseUrl, "/actions/session-resume", { projectId: "proj2" });
      const resumeTwo = (await resumeTwoRes.json()) as { structuredContent: { activeArtifact?: string | null } };
      expect(resumeTwo.structuredContent.activeArtifact).toBe("other.html");
    } finally {
      await fs.rm(secondProjectRoot, { recursive: true, force: true });
    }
  });

  it("rejects preset=control through the action bridge (non-blocking gap #2) on both call-tool and the project-select route", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const server = await startApp(ctx);
    stop = server.stop;

    const bridgeRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "project_select",
      input: { projectId: "proj", reason: "remote attempt", preset: "control" },
    });
    const bridgeBody = (await bridgeRes.json()) as { ok: boolean; structuredContent: { code?: string } };
    expect(bridgeRes.status).toBe(200);
    expect(bridgeBody.ok).toBe(false);
    expect(bridgeBody.structuredContent.code).toBe("PERMISSION_DENIED");

    const routeRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "remote attempt via route",
      preset: "control",
    });
    const routeBody = (await routeRes.json()) as { ok: boolean; structuredContent: { code?: string } };
    expect(routeRes.status).toBe(200);
    expect(routeBody.ok).toBe(false);
    expect(routeBody.structuredContent.code).toBe("PERMISSION_DENIED");

    // Neither attempt actually granted a control lease / cleared a kill.
    const session = (await ctx.store.getSession()) as { lease?: { preset?: string } | null } | null;
    expect(session?.lease?.preset ?? null).not.toBe("control");

    // Omitting preset (defaults to full-write) and explicitly requesting
    // full-write must both keep working through the same bridge.
    const defaultedRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "project_select",
      input: { projectId: "proj", reason: "default preset" },
    });
    const defaulted = (await defaultedRes.json()) as { ok: boolean; structuredContent: { lease?: Lease } };
    expect(defaulted.ok).toBe(true);
    expect(defaulted.structuredContent.lease?.preset).toBe("full-write");

    const explicitFullWriteRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "project_select",
      input: { projectId: "proj", reason: "explicit full-write", preset: "full-write" },
    });
    const explicitFullWrite = (await explicitFullWriteRes.json()) as { ok: boolean; structuredContent: { lease?: Lease } };
    expect(explicitFullWrite.ok).toBe(true);
    expect(explicitFullWrite.structuredContent.lease?.preset).toBe("full-write");
  });

  it("re-validates the registered tool's zod inputSchema on the generic call-tool bridge (bypasses the MCP SDK's normal validation otherwise)", async () => {
    // callRegisteredTool fetches the raw registered handler directly,
    // bypassing the MCP SDK's tools/call path where zod inputSchema (ranges,
    // enums, refine, min/max) is normally enforced. Without re-validating,
    // an out-of-schema numeric value — here e2e_open_url_screenshot's
    // waitMs: z.number().int().min(0).max(30_000) — would reach the tool
    // handler unchecked. This exercises the exact bridge/callRegisteredTool
    // codepath (not the tool's own internal logic), so no project lease or
    // real local URL needs to succeed for this assertion: rejection must
    // happen before the handler ever runs.
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "e2e_open_url_screenshot",
      input: {
        projectId: "proj",
        url: "http://127.0.0.1:1/",
        waitMs: 999_999, // exceeds max(30_000)
      },
    });
    const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string; error?: string } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.structuredContent?.code).toBe("INVALID_INPUT");
    expect(body.structuredContent?.error ?? "").toContain("waitMs");
  });

  it("re-validates zod inputSchema on the per-route action bridge too (not just /actions/call-tool)", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await postAction(server.baseUrl, "/actions/e2e-open-url-screenshot", {
      projectId: "proj",
      url: "http://127.0.0.1:1/",
      waitMs: 999_999,
    });
    const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.structuredContent?.code).toBe("INVALID_INPUT");
  });

  describe("owner-token brute-force lockout (SR-05) cannot be bypassed by omitting csrf_token", () => {
    it("counts a wrong owner_token toward the lockout even when csrf_token is omitted entirely", async () => {
      // Before the fix: with csrf_token omitted and owner_token wrong, the
      // handler took the (!csrfAccepted && !ownerTokenAccepted) branch and
      // returned 403 WITHOUT ever calling loginAttempts.recordFailure — so
      // this exact request shape could be repeated forever with no lockout
      // and no audit trail. After the fix, a *submitted* (not merely
      // omitted) wrong token is always accounted for. Prove it by tripping
      // the lockout purely with csrf-omitted wrong-token attempts, then
      // showing even the *correct* token is refused (429) once locked out.
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;
      const client = await registerOAuthClient(server.baseUrl);
      const url = authorizeUrl(server.baseUrl, client.clientId, client.redirectUri);

      const MAX_ATTEMPTS_BEFORE_BACKOFF = 5;
      for (let i = 0; i < MAX_ATTEMPTS_BEFORE_BACKOFF; i++) {
        const body = new URLSearchParams(url.searchParams);
        // csrf_token intentionally omitted.
        body.set("owner_token", `wrong-owner-token-${i}`);

        const res = await fetch(`${server.baseUrl}/authorize`, {
          method: "POST",
          headers: { origin: "https://chatgpt.com", "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          redirect: "manual",
        });
        // Not yet locked out — each of these is a plain rejected attempt.
        expect(res.status).toBe(403);
      }

      const finalBody = new URLSearchParams(url.searchParams);
      finalBody.set("csrf_token", "irrelevant-because-locked-out");
      finalBody.set("owner_token", OWNER_TOKEN); // the genuinely correct token
      const finalRes = await fetch(`${server.baseUrl}/authorize`, {
        method: "POST",
        headers: { origin: "https://chatgpt.com", "content-type": "application/x-www-form-urlencoded" },
        body: finalBody.toString(),
        redirect: "manual",
      });

      // If the csrf-omitted wrong-token attempts above had been silently
      // swallowed (the pre-fix bypass), the lockout counter would still be
      // at 0 and this correct-token request would succeed (302). Getting
      // 429 here proves those attempts were counted.
      expect(finalRes.status).toBe(429);
    });
  });

  describe("CHATGPT2CODEX_CONTROL_CHATGPT exposure on the generic action bridge", () => {
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    });

    it("still blocks control tools on /actions/call-tool by default (flag unset)", async () => {
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;

      const res = await postAction(server.baseUrl, "/actions/call-tool", {
        toolName: "computer_action_status",
        input: {},
      });
      const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string } };
      expect(body.ok).toBe(false);
      expect(body.structuredContent?.code).toBe("PERMISSION_DENIED");
    });

    it("allows control tools on /actions/call-tool once CHATGPT2CODEX_CONTROL_CHATGPT=1, but still rejects preset=control on project_select", async () => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
      const server = await startApp(makeCtx(stateDir, projectRoot));
      stop = server.stop;

      // A real control lease isn't granted through this bridge (preset=control
      // stays blocked below), so this reaches the tool handler and fails on
      // the lease check itself — proof it's no longer blocked by
      // CONTROL_TOOL_NAMES specifically.
      const res = await postAction(server.baseUrl, "/actions/call-tool", {
        toolName: "computer_action_status",
        input: {},
      });
      const body = (await res.json()) as { ok: boolean; structuredContent?: { code?: string } };
      expect(body.ok).toBe(false);
      expect(body.structuredContent?.code).toBe("PROJECT_NOT_SELECTED");

      const bridgeRes = await postAction(server.baseUrl, "/actions/call-tool", {
        toolName: "project_select",
        input: { projectId: "proj", reason: "remote attempt while exposed", preset: "control" },
      });
      const bridgeBody = (await bridgeRes.json()) as { ok: boolean; structuredContent: { code?: string } };
      expect(bridgeBody.ok).toBe(false);
      expect(bridgeBody.structuredContent.code).toBe("PERMISSION_DENIED");
    });
  });

  it("acknowledges broad goals quickly with next action guidance", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await postAction(server.baseUrl, "/actions/goal-intake", {
      goal: "/goal deep research and implement safely",
      projectId: "proj",
      urgency: "fast",
    });
    const body = (await res.json()) as {
      ok: boolean;
      text: string;
      structuredContent: {
        goalId?: string;
        loopId?: string;
        workSessionId?: string;
        taskState?: { goalId?: string | null; loopId?: string | null; currentGoal?: string | null };
        nextActions?: string[];
        timeoutGuidance?: string;
      };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.text).toContain("Continue with the next chatgpt2codex tool call now");
    expect(body.structuredContent.goalId).toMatch(/^goal-/);
    expect(body.structuredContent.loopId).toMatch(/^loop-/);
    expect(body.structuredContent.workSessionId).toMatch(/^ws_/);
    expect(body.structuredContent.taskState).toMatchObject({
      goalId: body.structuredContent.goalId,
      loopId: body.structuredContent.loopId,
      currentGoal: "/goal deep research and implement safely",
    });
    expect(body.structuredContent.nextActions?.join(" ")).toContain("project_select");
    expect(body.structuredContent.nextActions?.join(" ")).toContain(body.structuredContent.loopId);
    expect(body.structuredContent.timeoutGuidance).toContain("intentionally fast");
    await expect(fs.readdir(path.join(stateDir, "goals"))).resolves.toHaveLength(2);
  });

  it("continues the loop reserved by goal_intake instead of silently creating a replacement", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const intakeRes = await postAction(server.baseUrl, "/actions/goal-intake", {
      goal: "research harness continuity safely",
      projectId: "proj",
      mode: "research",
    });
    const intake = (await intakeRes.json()) as {
      structuredContent: {
        loopId?: string;
        workSessionId?: string;
        recommendedLeasePreset?: string;
        activeRoleContext?: { role?: { id?: string }; selectionSource?: string };
      };
    };
    expect(intake.structuredContent.loopId).toMatch(/^loop-/);
    expect(intake.structuredContent.workSessionId).toMatch(/^ws_/);
    expect(intake.structuredContent.recommendedLeasePreset).toBe("read-only");
    expect(intake.structuredContent.activeRoleContext).toMatchObject({
      role: { id: "researcher" },
      selectionSource: "auto",
    });

    const before = await fs.readdir(path.join(stateDir, "goals"));
    const loopRes = await postAction(server.baseUrl, "/actions/goal-loop", {
      projectId: "proj",
      maxTurns: 3,
      lastResult: "continued without repeating loop ids",
    });
    const loop = (await loopRes.json()) as {
      ok: boolean;
      structuredContent: {
        loopId?: string;
        workSessionId?: string;
        turn?: number;
        recommendedLeasePreset?: string;
        activeRoleContext?: { role?: { id?: string }; selectionSource?: string };
      };
    };
    expect(loop.ok).toBe(true);
    expect(loop.structuredContent.loopId).toBe(intake.structuredContent.loopId);
    expect(loop.structuredContent.workSessionId).toBe(intake.structuredContent.workSessionId);
    expect(loop.structuredContent.turn).toBe(1);
    expect(loop.structuredContent.recommendedLeasePreset).toBe("read-only");
    expect(loop.structuredContent.activeRoleContext).toMatchObject({
      role: { id: "researcher" },
      selectionSource: "auto",
    });
    await expect(fs.readdir(path.join(stateDir, "goals"))).resolves.toEqual(expect.arrayContaining(before));
    await expect(fs.readdir(path.join(stateDir, "goals"))).resolves.toHaveLength(before.length);
  });

  it("does not invent a generic loop when no active task exists", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const res = await postAction(server.baseUrl, "/actions/goal-loop", { projectId: "proj" });
    const body = (await res.json()) as {
      ok: boolean;
      structuredContent: { loopId?: string; needsGoalOrLoopId?: boolean; continueRequired?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.structuredContent.loopId).toBeUndefined();
    expect(body.structuredContent.needsGoalOrLoopId).toBe(true);
    expect(body.structuredContent.continueRequired).toBe(false);
    await expect(fs.readdir(path.join(stateDir, "goals"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a local coding loop moving across action turns", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const firstRes = await postAction(server.baseUrl, "/actions/goal-loop", {
      goal: "/goal implement and verify a focused change",
      projectId: "proj",
      maxTurns: 3,
      currentTask: "wire structured task state",
      pending: ["wire resume", "run focused tests"],
      decisions: [
        {
          summary: "Use structured progress fields",
          rationale: "Avoid parsing arbitrary lastResult prose",
        },
      ],
    });
    const first = (await firstRes.json()) as {
      ok: boolean;
      text: string;
      structuredContent: {
        loopId?: string;
        workSessionId?: string;
        turn?: number;
        remainingTurns?: number;
        nextActions?: string[];
        orchestration?: {
          engine?: string;
          externalModelRequired?: boolean;
          phase?: string;
          primaryStage?: string;
        };
      };
    };

    expect(firstRes.status).toBe(200);
    expect(first.ok).toBe(true);
    expect(first.text).toContain("Execute the next action batch now");
    expect(first.structuredContent.loopId).toMatch(/^loop-/);
    expect(first.structuredContent.workSessionId).toMatch(/^ws_/);
    expect(first.structuredContent.turn).toBe(1);
    expect(first.structuredContent.remainingTurns).toBe(2);
    expect(first.structuredContent.nextActions?.join(" ")).toContain("goal_loop again");
    expect(first.structuredContent.orchestration).toMatchObject({
      engine: "jk-native",
      externalModelRequired: false,
      phase: "discover",
      primaryStage: "explorer",
    });

    const secondRes = await postAction(server.baseUrl, "/actions/goal-loop", {
      loopId: first.structuredContent.loopId,
      projectId: "proj",
      maxTurns: 3,
      lastResult: "read rules and selected project",
      currentTask: "run focused tests",
      verificationStatus: "fail",
      failureCount: 3,
      completed: ["wire structured task state", "wire resume"],
      pending: ["run focused tests"],
    });
    const second = (await secondRes.json()) as {
      ok: boolean;
      structuredContent: {
        turn?: number;
        workSessionId?: string;
        nextActions?: string[];
        orchestration?: { phase?: string; primaryStage?: string; failureCount?: number };
      };
    };

    expect(secondRes.status).toBe(200);
    expect(second.ok).toBe(true);
    expect(second.structuredContent.turn).toBe(2);
    expect(second.structuredContent.workSessionId).toBe(first.structuredContent.workSessionId);
    expect(second.structuredContent.orchestration).toMatchObject({
      phase: "recovery",
      primaryStage: "recovery",
      failureCount: 3,
    });
    expect(second.structuredContent.nextActions?.join(" ")).toContain("Do not apply another patch");
    const loopFile = path.join(stateDir, "goals", `${first.structuredContent.loopId}.loop.json`);
    const loopState = JSON.parse(await fs.readFile(loopFile, "utf8")) as { turns?: unknown[] };
    expect(loopState.turns).toHaveLength(2);

    const terminalRes = await postAction(server.baseUrl, "/actions/goal-loop", {
      loopId: first.structuredContent.loopId,
      projectId: "proj",
      maxTurns: 5,
      lastResult: "focused tests and build passed",
      currentTask: "release complete",
      phase: "release",
      verificationStatus: "pass",
      failureCount: 0,
      completed: ["wire structured task state", "wire resume", "run focused tests"],
      pending: [],
    });
    const terminal = (await terminalRes.json()) as {
      ok: boolean;
      text: string;
      structuredContent: {
        terminal?: boolean;
        terminalStatus?: string | null;
        terminalPushResult?: string | null;
        continueRequired?: boolean;
      };
    };
    expect(terminalRes.status).toBe(200);
    expect(terminal.ok).toBe(true);
    expect(terminal.text).toContain("completed after verified release");
    expect(terminal.structuredContent).toMatchObject({
      terminal: true,
      terminalStatus: "succeeded",
      terminalPushResult: "failed",
      continueRequired: false,
    });

    const selectRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      workSessionId: first.structuredContent.workSessionId,
      reason: "resume semantic task state",
    });
    expect(selectRes.status).toBe(200);

    const resumeRes = await postAction(server.baseUrl, "/actions/session-resume", {
      projectId: "proj",
      workSessionId: first.structuredContent.workSessionId,
    });
    const resumed = (await resumeRes.json()) as {
      ok: boolean;
      structuredContent: {
        taskState?: {
          loopId?: string | null;
          currentGoal?: string | null;
          currentTask?: string | null;
          lastProgressSummary?: string | null;
          completed?: string[];
          pending?: string[];
          decisions?: Array<{ summary?: string; rationale?: string | null }>;
        };
      };
    };
    expect(resumeRes.status).toBe(200);
    expect(resumed.ok).toBe(true);
    expect(resumed.structuredContent.taskState).toMatchObject({
      loopId: first.structuredContent.loopId,
      currentGoal: "/goal implement and verify a focused change",
      currentTask: "release complete",
      lastProgressSummary: "focused tests and build passed",
      completed: ["wire structured task state", "wire resume", "run focused tests"],
      pending: [],
    });
    expect(resumed.structuredContent.taskState?.decisions?.[0]).toMatchObject({
      summary: "Use structured progress fields",
      rationale: "Avoid parsing arbitrary lastResult prose",
    });
  });

  it("isolates same-project work by workSessionId and lists resumable handles", async () => {
    await fs.writeFile(path.join(projectRoot, "alpha.html"), "<html>alpha</html>\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "beta.html"), "<html>beta</html>\n", "utf8");
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    const startGoal = async (goal: string) => {
      const res = await postAction(server.baseUrl, "/actions/goal-intake", { goal, projectId: "proj" });
      const body = (await res.json()) as { ok: boolean; structuredContent: { workSessionId?: string } };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.structuredContent.workSessionId).toMatch(/^ws_/);
      return body.structuredContent.workSessionId!;
    };

    const alphaId = await startGoal("Improve alpha portfolio layout");
    const betaId = await startGoal("Refactor beta harness code");
    expect(alphaId).not.toBe(betaId);

    const touchSession = async (
      workSessionId: string,
      file: string,
      goal: string,
      currentTask: string,
      verificationMarker: string,
    ) => {
      const selected = await postAction(server.baseUrl, "/actions/project-select", {
        projectId: "proj",
        workSessionId,
        reason: `select ${workSessionId}`,
      });
      expect(selected.status).toBe(200);
      const read = await postAction(server.baseUrl, "/actions/file-read-slice", {
        projectId: "proj",
        workSessionId,
        path: file,
        start: 1,
        end: 1,
      });
      expect(read.status).toBe(200);
      const write = await postAction(server.baseUrl, "/actions/file-create", {
        projectId: "proj",
        workSessionId,
        path: file,
        content: `<html>${verificationMarker} updated</html>\n`,
        overwrite: true,
      });
      expect(write.status).toBe(200);
      const verify = await postAction(server.baseUrl, "/actions/local-shell-run", {
        projectId: "proj",
        workSessionId,
        command: `node -e "console.log('${verificationMarker}-check')"`,
      });
      expect(verify.status).toBe(200);
      const loop = await postAction(server.baseUrl, "/actions/goal-loop", {
        goal,
        projectId: "proj",
        workSessionId,
        currentTask,
        pending: [`finish ${file}`],
        maxTurns: 3,
      });
      expect(loop.status).toBe(200);
    };

    await touchSession(alphaId, "alpha.html", "Improve alpha portfolio layout", "verify alpha layout", "alpha");
    await touchSession(betaId, "beta.html", "Refactor beta harness code", "run beta tests", "beta");

    const resume = async (workSessionId: string) => {
      const res = await postAction(server.baseUrl, "/actions/session-resume", { projectId: "proj", workSessionId });
      const body = (await res.json()) as {
        ok: boolean;
        structuredContent: {
          workSessionId?: string | null;
          activeArtifact?: string | null;
          lastMutation?: { tool?: string; files?: Array<{ path?: string }> } | null;
          lastVerification?: { tool?: string; command?: string; success?: boolean } | null;
          taskState?: { currentGoal?: string | null; currentTask?: string | null; pending?: string[] };
        };
      };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      return body.structuredContent;
    };

    const alpha = await resume(alphaId);
    const beta = await resume(betaId);
    expect(alpha).toMatchObject({ workSessionId: alphaId, activeArtifact: "alpha.html" });
    expect(alpha.taskState).toMatchObject({
      currentGoal: "Improve alpha portfolio layout",
      currentTask: "verify alpha layout",
      pending: ["finish alpha.html"],
    });
    expect(alpha.lastMutation).toMatchObject({ tool: "file_create", files: [expect.objectContaining({ path: "alpha.html" })] });
    expect(alpha.lastVerification).toMatchObject({ tool: "local_shell_run", success: true });
    expect(alpha.lastVerification?.command).toContain("alpha-check");
    expect(beta).toMatchObject({ workSessionId: betaId, activeArtifact: "beta.html" });
    expect(beta.taskState).toMatchObject({
      currentGoal: "Refactor beta harness code",
      currentTask: "run beta tests",
      pending: ["finish beta.html"],
    });
    expect(beta.lastMutation).toMatchObject({ tool: "file_create", files: [expect.objectContaining({ path: "beta.html" })] });
    expect(beta.lastVerification).toMatchObject({ tool: "local_shell_run", success: true });
    expect(beta.lastVerification?.command).toContain("beta-check");

    const fusedSelectRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "fused beta resume",
      resumeHint: "beta harness",
      includeResumeContext: true,
      includeResumeSlice: true,
    });
    const fusedSelect = (await fusedSelectRes.json()) as {
      ok: boolean;
      structuredContent: {
        workSessionId?: string | null;
        autoResumeApplied?: boolean;
        autoResumeAmbiguous?: boolean;
        autoResumeReason?: string;
        resumeContext?: {
          validationScope?: "active" | "recent";
          validatedRecentFileCount?: number;
          activeArtifact?: string | null;
          activeArtifactStale?: boolean | null;
          activeSlice?: { content?: string; start?: number; end?: number } | null;
          taskState?: { currentGoal?: string | null; currentTask?: string | null };
        } | null;
      };
    };
    expect(fusedSelectRes.status).toBe(200);
    expect(fusedSelect.ok).toBe(true);
    expect(fusedSelect.structuredContent).toMatchObject({
      workSessionId: betaId,
      autoResumeApplied: true,
      autoResumeAmbiguous: false,
      autoResumeReason: "confident-hint-match",
    });
    expect(fusedSelect.structuredContent.resumeContext).toMatchObject({
      validationScope: "active",
      validatedRecentFileCount: 1,
      activeArtifact: "beta.html",
      activeArtifactStale: false,
      taskState: {
        currentGoal: "Refactor beta harness code",
        currentTask: "run beta tests",
      },
      activeSlice: { start: 1, end: 1 },
    });
    expect(fusedSelect.structuredContent.resumeContext?.activeSlice?.content).toContain("beta updated");

    const listRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "work_session_list",
      input: { projectId: "proj", hint: "beta harness" },
    });
    const listed = (await listRes.json()) as {
      ok: boolean;
      structuredContent: {
        suggestedWorkSessionId?: string | null;
        hintApplied?: boolean;
        retentionLimit?: number;
        workSessions?: Array<{
          workSessionId?: string | null;
          activeArtifact?: string | null;
          matchScore?: number;
          matchReasons?: string[];
        }>;
      };
    };
    expect(listRes.status).toBe(200);
    expect(listed.ok).toBe(true);
    expect(listed.structuredContent.hintApplied).toBe(true);
    expect(listed.structuredContent.retentionLimit).toBe(20);
    expect(listed.structuredContent.suggestedWorkSessionId).toBe(betaId);
    expect(listed.structuredContent.workSessions?.[0]).toMatchObject({
      workSessionId: betaId,
      activeArtifact: "beta.html",
    });
    expect(listed.structuredContent.workSessions?.[0]?.matchReasons?.join(" ")).toContain("hint-token-match");
    expect(listed.structuredContent.workSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workSessionId: alphaId, activeArtifact: "alpha.html" }),
        expect.objectContaining({ workSessionId: betaId, activeArtifact: "beta.html" }),
      ]),
    );
  });

  it("attaches an approved job continuation to the next JK response exactly once", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    expect((await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      preset: "full-write",
      reason: "continuation delivery test",
    })).status).toBe(200);

    const loopRes = await postAction(server.baseUrl, "/actions/goal-loop", {
      goal: "finish the approved continuation flow",
      projectId: "proj",
      maxTurns: 3,
      currentTask: "run the approved job",
      pending: ["inspect approved result"],
    });
    const loop = (await loopRes.json()) as {
      structuredContent: { loopId?: string; workSessionId?: string };
    };
    expect(loop.structuredContent.loopId).toMatch(/^loop-/u);
    expect(loop.structuredContent.workSessionId).toMatch(/^ws_/u);

    const shellRes = await postAction(server.baseUrl, "/actions/local-shell-run", {
      projectId: "proj",
      workSessionId: loop.structuredContent.workSessionId,
      command: `node -e "console.log('continuation-ok')"`,
      intent: { needsNetwork: true, reason: "exercise exact approval continuation" },
    });
    const shell = (await shellRes.json()) as {
      structuredContent: {
        code?: string;
        approvalRequired?: boolean;
        approvalPending?: boolean;
        approvalInstruction?: string;
      };
    };
    expect(shell.structuredContent.code).toBe("APPROVAL_REQUIRED");
    expect(shell.structuredContent.approvalRequired).toBe(true);
    expect(shell.structuredContent.approvalPending).toBe(true);
    expect(shell.structuredContent.approvalInstruction).toContain("real JK Control Center approval");
    const pendingApprovals = (await (await fetch(`${server.baseUrl}/api/jk/control/approvals`)).json()) as {
      approvals?: Array<{ id?: string; projectId?: string }>;
    };
    const approvalId = pendingApprovals.approvals?.find((approval) => approval.projectId === "proj")?.id;
    expect(approvalId).toMatch(/^[a-f0-9]{64}$/u);

    const approveRes = await fetch(`${server.baseUrl}/api/jk/control/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(approveRes.status).toBe(200);

    let finished = false;
    for (let i = 0; i < 80 && !finished; i += 1) {
      const approvals = (await (await fetch(`${server.baseUrl}/api/jk/control/approvals`)).json()) as {
        jobs?: Array<{ id?: string; status?: string }>;
      };
      finished = approvals.jobs?.some((job) => job.id === approvalId && job.status === "succeeded") ?? false;
      if (!finished) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(finished).toBe(true);

    const firstRes = await postAction(server.baseUrl, "/actions/project-status", { projectId: "proj" });
    const first = (await firstRes.json()) as {
      text?: string;
      structuredContent: {
        taskContinuation?: {
          loopId?: string;
          workSessionId?: string;
          continuationStatus?: string;
          jobResult?: { status?: string; stdoutSummary?: string };
        };
      };
    };
    expect(first.structuredContent.taskContinuation).toMatchObject({
      loopId: loop.structuredContent.loopId,
      workSessionId: loop.structuredContent.workSessionId,
      continuationStatus: "ready-to-resume",
      jobResult: { status: "succeeded" },
    });
    expect(first.structuredContent.taskContinuation?.jobResult?.stdoutSummary).toContain("continuation-ok");
    expect(first.text).toContain("[JK task continuation]");

    const secondRes = await postAction(server.baseUrl, "/actions/project-status", { projectId: "proj" });
    const second = (await secondRes.json()) as { structuredContent: { taskContinuation?: unknown } };
    expect(second.structuredContent.taskContinuation).toBeUndefined();
  });

  it("runs server-verified cloud inventory reads without creating an approval", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    await fs.writeFile(path.join(projectRoot, "aws"), "#!/bin/sh\necho inventory-ok\n", { mode: 0o755 });

    expect((await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      preset: "full-write",
      reason: "cloud inventory auto-read test",
    })).status).toBe(200);

    const shellRes = await postAction(server.baseUrl, "/actions/local-shell-run", {
      projectId: "proj",
      command: "./aws sts get-caller-identity",
      intent: { reason: "read-only cloud inventory" },
    });
    expect(shellRes.status).toBe(200);
    const shell = (await shellRes.json()) as {
      structuredContent: { code?: string; exitCode?: number; stdoutSummary?: string };
    };
    expect(shell.structuredContent.code).not.toBe("APPROVAL_REQUIRED");
    expect(shell.structuredContent.exitCode).toBe(0);
    expect(shell.structuredContent.stdoutSummary).toContain("inventory-ok");

    const approvals = (await (await fetch(`${server.baseUrl}/api/jk/control/approvals`)).json()) as {
      approvals?: Array<{ projectId?: string }>;
    };
    expect(approvals.approvals?.filter((approval) => approval.projectId === "proj") ?? []).toHaveLength(0);
  });

  it("caps isolated work-session retention per project and keeps the newest session", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;
    const ids: string[] = [];

    for (let i = 0; i < 22; i += 1) {
      const res = await postAction(server.baseUrl, "/actions/goal-intake", {
        goal: `Retention test goal ${i}`,
        projectId: "proj",
      });
      const body = (await res.json()) as { ok: boolean; structuredContent: { workSessionId?: string } };
      expect(body.ok).toBe(true);
      ids.push(body.structuredContent.workSessionId!);
    }

    const listRes = await postAction(server.baseUrl, "/actions/call-tool", {
      toolName: "work_session_list",
      input: { projectId: "proj", limit: 50 },
    });
    const listed = (await listRes.json()) as {
      ok: boolean;
      structuredContent: {
        totalWorkSessions?: number;
        retentionLimit?: number;
        workSessions?: Array<{ workSessionId?: string | null }>;
      };
    };
    expect(listed.ok).toBe(true);
    expect(listed.structuredContent.retentionLimit).toBe(20);
    expect(listed.structuredContent.totalWorkSessions).toBe(20);
    expect(listed.structuredContent.workSessions).toHaveLength(20);
    const retainedIds = listed.structuredContent.workSessions?.map((session) => session.workSessionId) ?? [];
    expect(retainedIds).toContain(ids.at(-1));
    expect(retainedIds).not.toContain(ids[0]);
    expect(retainedIds).not.toContain(ids[1]);
  });

  it("does not auto-resume when two hint-matching work sessions are too close", async () => {
    const server = await startApp(makeCtx(stateDir, projectRoot));
    stop = server.stop;

    for (const goal of ["Shared dashboard alpha task", "Shared dashboard beta task"]) {
      const goalRes = await postAction(server.baseUrl, "/actions/goal-intake", {
        goal,
        projectId: "proj",
      });
      expect(goalRes.status).toBe(200);
    }

    const selectRes = await postAction(server.baseUrl, "/actions/project-select", {
      projectId: "proj",
      reason: "ambiguous fused resume",
      resumeHint: "shared dashboard",
      includeResumeContext: true,
      includeResumeSlice: true,
    });
    const selected = (await selectRes.json()) as {
      ok: boolean;
      structuredContent: {
        workSessionId?: string | null;
        autoResumeApplied?: boolean;
        autoResumeAmbiguous?: boolean;
        autoResumeReason?: string;
        resumeCandidates?: Array<{ workSessionId?: string | null; matchScore?: number; matchReasons?: string[] }>;
        resumeContext?: unknown;
      };
    };
    expect(selectRes.status).toBe(200);
    expect(selected.ok).toBe(true);
    expect(selected.structuredContent.workSessionId).toBeNull();
    expect(selected.structuredContent.autoResumeApplied).toBe(false);
    expect(selected.structuredContent.autoResumeAmbiguous).toBe(true);
    expect(selected.structuredContent.autoResumeReason).toBe("top-candidates-too-close");
    expect(selected.structuredContent.resumeContext).toBeNull();
    expect(selected.structuredContent.resumeCandidates).toHaveLength(2);
    expect(selected.structuredContent.resumeCandidates?.every((candidate) =>
      candidate.matchReasons?.includes("full-hint-match"),
    )).toBe(true);
  });
});
