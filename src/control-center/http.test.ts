import { createServer as createNodeServer, type Server } from "node:http";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "../server/http.js";
import { consumeLocalShellApprovalGrant, requestLocalShellApproval, resolveLocalShellApproval } from "../policy/local-approvals.js";
import { queueLocalShellJob, readLocalShellJob, updateLocalShellJob } from "../policy/local-shell-jobs.js";
import { storeOwnerToken } from "../auth/owner-token.js";
import { TaskWorkspaceStore } from "../workspace/task-workspaces.js";
import { git } from "../orchestration/mass-ulw-workspace-repository.js";
import { deriveLocalExecutionTarget } from "../executors/target-protocol.js";
import { createRuntimeIdentity } from "../executors/target-protocol.js";
import { issueExecutorToken } from "../executors/auth.js";
import { CONTROL_CENTER_HTML } from "./ui.js";

const jobEvents = new EventEmitter();

const OWNER_TOKEN = "unit-test-remote-owner-token-1234567890";

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function makeCtx(stateDir: string, projectRoot: string): ToolContext {
  const registry = [{ projectId: "proj", name: "example-service", root: projectRoot, aliases: ["example-service"] }];
  let currentSession: any = {
    version: 5,
    updatedAt: Date.now(),
    activeProjectId: "proj",
    mode: "edit",
    lease: {
      projectId: "proj",
      leaseId: "lease-control-center-test",
      projectRoot,
      preset: "full-write",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
    workContext: null,
    workContexts: {
      proj: {
        projectId: "proj",
        workSessionId: null,
        activeArtifact: null,
        recentFiles: [],
        lastCheckpointId: null,
        lastMutation: null,
        lastVerification: null,
        taskState: {
          goalId: "goal-1",
          loopId: "loop-1",
          currentGoal: "Finish dashboard",
          currentTask: "QA",
          lastProgressSummary: "UI implemented",
          completed: ["backend"],
          pending: ["e2e"],
          decisions: [],
          updatedAt: Date.now(),
        },
        lastActivityAt: Date.now(),
      },
    },
    workSessions: {},
  };
  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    ledger: { append: async (event) => { jobEvents.emit(String(event.type), event); } },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => currentSession,
      setSession: async (next) => { currentSession = next; },
      updateSession: async (mutator) => { currentSession = await mutator(currentSession); return currentSession; },
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

async function startApp(ctx: ToolContext, managementRoutesEnabled = true): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = await getFreePort();
  const running = createHttpServer(ctx, defaultHttpServerConfig({
    host: "127.0.0.1",
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    managementRoutesEnabled,
  }));
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

let tempRoot = "";
let stateDir = "";
let projectRoot = "";
let app: Awaited<ReturnType<typeof startApp>> | null = null;

beforeEach(async () => {
  delete process.env.JK_REMOTE_MANAGEMENT_HOST;
  delete process.env.JK_REMOTE_MANAGEMENT_CF_ACCESS_REQUIRED;
  delete process.env.JK_DEPLOYMENT_PROJECT_ROOT;
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "jk-control-center-"));
  stateDir = path.join(tempRoot, "state");
  projectRoot = path.join(tempRoot, "example-service");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await storeOwnerToken(stateDir, OWNER_TOKEN);
  await writeFile(path.join(stateDir, "audit.jsonl"), JSON.stringify({ type: "tool.call", toolName: "code_search", projectId: "proj", ts: Date.now() }) + "\n");
  app = await startApp(makeCtx(stateDir, projectRoot));
});

afterEach(async () => {
  if (app) await app.stop();
  app = null;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  delete process.env.JK_REMOTE_MANAGEMENT_HOST;
  delete process.env.JK_REMOTE_MANAGEMENT_CF_ACCESS_REQUIRED;
  delete process.env.JK_DEPLOYMENT_PROJECT_ROOT;
});

describe("JK Control Center", () => {
  it("serves a worker-authenticated, project-scoped run view for the native JK app", async () => {
    const executorId = "windows-main";
    const workerToken = await issueExecutorToken(stateDir, executorId);
    const worker = {
      ...await createRuntimeIdentity("worker", path.dirname(projectRoot), executorId, ["execution-target-v1"]),
      platform: "win32/x64",
      projects: [{ projectId: "proj", name: "example-service", root: projectRoot, aliases: ["example-service"] }],
    };
    const heartbeat = await fetch(`${app!.baseUrl}/api/executors/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
      body: JSON.stringify(worker),
    });
    expect(heartbeat.status).toBe(200);

    const route = `${app!.baseUrl}/api/executors/${executorId}/run-view`;
    expect((await fetch(route, { headers: { authorization: "Bearer wrong-token" } })).status).toBe(401);
    const response = await fetch(route, { headers: { authorization: `Bearer ${workerToken}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ ok: true, approvalCount: 0 });
    expect(body.execution).toMatchObject({ projectId: "proj", goal: "Finish dashboard", task: "QA" });
    expect(body.logs[0]).toMatchObject({ type: "tool.call", projectId: "proj", detail: "code_search" });
  });

  it("does not project a completed historical goal as the native app's live DAG", async () => {
    await app!.stop();
    const ctx = makeCtx(stateDir, projectRoot);
    const session = await ctx.store.getSession();
    const taskState = (session.workContexts as any).proj.taskState;
    taskState.lifecycle = "succeeded";
    await ctx.store.setSession(session);
    app = await startApp(ctx);

    const execution = await (await fetch(`${app.baseUrl}/api/jk/control/execution`)).json() as any;
    expect(execution.execution).toMatchObject({ projectId: null, goal: null, task: null, massUlw: null });

    const executorId = "windows-main";
    const workerToken = await issueExecutorToken(stateDir, executorId);
    const worker = {
      ...await createRuntimeIdentity("worker", path.dirname(projectRoot), executorId, ["execution-target-v1"]),
      platform: "win32/x64",
      projects: [{ projectId: "proj", name: "example-service", root: projectRoot, aliases: ["example-service"] }],
    };
    const heartbeat = await fetch(`${app.baseUrl}/api/executors/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
      body: JSON.stringify(worker),
    });
    expect(heartbeat.status).toBe(200);
    const runView = await (await fetch(`${app.baseUrl}/api/executors/${executorId}/run-view`, {
      headers: { authorization: `Bearer ${workerToken}` },
    })).json() as any;
    expect(runView.execution).toMatchObject({ projectId: null, goal: null, task: null, massUlw: null });
  });

  it("keeps core HTTP health available when the optional management surface is headless", async () => {
    await app!.stop();
    app = await startApp(makeCtx(stateDir, projectRoot), false);

    expect((await fetch(`${app.baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${app.baseUrl}/`)).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/api/jk/roles`)).status).toBe(404);
  });

  it("surfaces sanitized goal_loop coordination telemetry in Control Center status", async () => {
    const telemetryDir = path.join(stateDir, "telemetry");
    await mkdir(telemetryDir, { recursive: true });
    const rows = [
      { schemaVersion: 1, at: new Date().toISOString(), coordinationMode: "standard", durationMs: 100, responseBytes: 10000, turn: 1, failureCount: 0, retryCount: 0, lifecycle: "yielded" },
      { schemaVersion: 1, at: new Date().toISOString(), coordinationMode: "dispatcher", durationMs: 120, responseBytes: 7500, turn: 2, failureCount: 1, retryCount: 0, lifecycle: "reasoning-needed" },
    ];
    await writeFile(path.join(telemetryDir, "goal-loop.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

    const response = await fetch(`${app!.baseUrl}/api/jk/control/status`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.goalLoopTelemetry).toMatchObject({
      samples: 2,
      standard: { samples: 1, avgResponseBytes: 10000, avgDurationMs: 100, failureRate: 0 },
      dispatcher: { samples: 1, avgResponseBytes: 7500, avgDurationMs: 120, failureRate: 1 },
      dispatcherVsStandard: { responseBytesDeltaPct: -25, durationDeltaPct: 20 },
    });
    expect(JSON.stringify(body.goalLoopTelemetry)).not.toContain(projectRoot);
  });

  it("serves the local dashboard and blocks forwarded non-loopback access", async () => {
    const local = await fetch(`${app!.baseUrl}/`);
    expect(local.status).toBe(200);
    expect(local.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await local.text();
    expect(html).toContain("JK Control Center");
    expect(html).toContain("JK 시작 가이드");
    expect(html).toContain("실행 단계");
    expect(html).toBe(CONTROL_CENTER_HTML);
    expect(html).toContain("Activity");
    expect(html).toContain("Settings");
    expect(html).toContain("Secure remote admin");
    expect(html).toContain("Authenticated remote");
    expect(html).not.toContain("Local admin only");
    expect(html).toContain("workflow-rail-root");
    expect(html).toContain('aria-label="MASS ULW 작업 그래프"');
    expect(html).toContain('aria-label="Lane status summary"');
    expect(html).toContain('aria-label="MASS ULW dependency graph viewport"');
    expect(html).toContain('class="run-dag-edge"');
    expect(html).toContain('data-lane-status=');
    expect(html).toContain('data-run-started-at=');
    expect(html).toContain("refreshSignals");
    expect(html).not.toContain("Live Office");
    expect(html).not.toContain("data:image/webp;base64,UklGR");
    expect(html).not.toContain("office-desk");
    expect(html).not.toContain("crew-sprite");

    const external = await fetch(`${app!.baseUrl}/`, { headers: { "x-forwarded-for": "203.0.113.4" } });
    expect(external.status).toBe(403);

    const externalAdminApi = await fetch(`${app!.baseUrl}/api/jk/control/status`, {
      headers: { "x-forwarded-for": "203.0.113.4" },
    });
    expect(externalAdminApi.status).toBe(403);

    const publicHealth = await fetch(`${app!.baseUrl}/healthz`, {
      headers: { "x-forwarded-for": "203.0.113.4" },
    });
    expect(publicHealth.status).toBe(200);
  });

  it("serves the latest project review package and only manifest-listed cards", async () => {
    const date = "2026-08-17";
    const outputRoot = path.join(projectRoot, "var", "output");
    const publishDir = path.join(outputRoot, date, "publish");
    await mkdir(publishDir, { recursive: true });
    await writeFile(path.join(outputRoot, "latest-ready.json"), JSON.stringify({ date }));
    await writeFile(path.join(publishDir, "manifest.json"), JSON.stringify({
      status: "ready",
      date,
      cards: ["01.png", "02.png"],
      caption: "caption.txt",
      design_system: "editorial-cobalt-v2",
      download_bundle: "instagram-package.zip",
      publisher: { target: "instagram-carousel", configured: false, action: "publish-disabled" },
      source_count: 3,
      design_qa_score: 100,
      design_qa_failures: [],
    }));
    await writeFile(path.join(publishDir, "caption.txt"), "저장해두고 신청 전에 다시 보기");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(path.join(publishDir, "01.png"), png);
    await writeFile(path.join(publishDir, "02.png"), png);
    await writeFile(path.join(publishDir, "instagram-package.zip"), Buffer.from("zip-fixture"));

    const review = await fetch(`${app!.baseUrl}/review/proj`);
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html).toContain("JK · Review Inbox");
    expect(html).toContain("저장해두고 신청 전에 다시 보기");
    expect(html).toContain("Design QA");
    expect(html).toContain("/review/proj/card/01.png");
    expect(html).toContain("/review/proj/download");
    expect(html).toContain("5장 ZIP 받기");
    expect(html).toContain("editorial-cobalt-v2");
    expect(html).toContain("Instagram 게시");
    expect(html).toContain('id="instagram-publish" disabled');

    const download = await fetch(`${app!.baseUrl}/review/proj/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/zip");
    expect(download.headers.get("content-disposition")).toContain("proj-2026-08-17.zip");
    expect(Buffer.from(await download.arrayBuffer()).toString()).toBe("zip-fixture");

    const card = await fetch(`${app!.baseUrl}/review/proj/card/01.png`);
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toContain("image/png");

    const unlisted = await fetch(`${app!.baseUrl}/review/proj/card/99.png`);
    expect(unlisted.status).toBe(404);
  });

  it("allows remote dashboard access only on the configured management host after owner login", async () => {
    await app!.stop();
    process.env.JK_REMOTE_MANAGEMENT_HOST = "jk.example.test";
    app = await startApp(makeCtx(stateDir, projectRoot));

    const remoteHeaders = {
      "x-forwarded-host": "jk.example.test",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
      origin: "https://jk.example.test",
    };

    const pageBeforeLogin = await fetch(`${app.baseUrl}/approvals`, { headers: remoteHeaders, redirect: "manual" });
    expect(pageBeforeLogin.status).toBe(302);
    expect(pageBeforeLogin.headers.get("location")).toBe("/login?return=%2Fapprovals");

    const loginPage = await fetch(`${app.baseUrl}/login`, { headers: remoteHeaders });
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("관리자 로그인");

    const apiBeforeLogin = await fetch(`${app.baseUrl}/api/jk/control/status`, { headers: remoteHeaders });
    expect(apiBeforeLogin.status).toBe(401);
    expect((await apiBeforeLogin.json() as any).code).toBe("OWNER_LOGIN_REQUIRED");

    const deniedLogin = await fetch(`${app.baseUrl}/api/jk/control/login`, {
      method: "POST",
      headers: { ...remoteHeaders, "content-type": "application/json" },
      body: JSON.stringify({ ownerToken: "wrong-token" }),
    });
    expect(deniedLogin.status).toBe(401);

    const acceptedLogin = await fetch(`${app.baseUrl}/api/jk/control/login`, {
      method: "POST",
      headers: { ...remoteHeaders, "content-type": "application/json" },
      body: JSON.stringify({ ownerToken: OWNER_TOKEN }),
    });
    expect(acceptedLogin.status).toBe(200);
    const setCookie = acceptedLogin.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("jk_owner_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=2592000");
    const cookie = setCookie.split(";", 1)[0];

    const apiAfterLogin = await fetch(`${app.baseUrl}/api/jk/control/status`, {
      headers: { ...remoteHeaders, cookie },
    });
    expect(apiAfterLogin.status).toBe(200);
    expect((await apiAfterLogin.json() as any).ok).toBe(true);

    const projectsAfterLogin = await fetch(`${app.baseUrl}/api/jk/projects`, {
      headers: { ...remoteHeaders, cookie },
    });
    expect(projectsAfterLogin.status).toBe(200);

    const rolesAfterLogin = await fetch(`${app.baseUrl}/api/jk/roles?projectId=alpha`, {
      headers: { ...remoteHeaders, cookie },
    });
    expect(rolesAfterLogin.status).toBe(200);

    const wrongHost = await fetch(`${app.baseUrl}/api/jk/control/status`, {
      headers: { ...remoteHeaders, "x-forwarded-host": "mcp.example.test", origin: "https://mcp.example.test", cookie },
    });
    expect(wrongHost.status).toBe(403);

    const logout = await fetch(`${app.baseUrl}/api/jk/control/logout`, {
      method: "POST",
      headers: { ...remoteHeaders, cookie },
    });
    expect(logout.status).toBe(200);

    const apiAfterLogout = await fetch(`${app.baseUrl}/api/jk/control/status`, {
      headers: { ...remoteHeaders, cookie },
    });
    expect(apiAfterLogout.status).toBe(401);
  });

  it("can require Cloudflare Access in addition to owner login", async () => {
    await app!.stop();
    process.env.JK_REMOTE_MANAGEMENT_HOST = "jk.example.test";
    process.env.JK_REMOTE_MANAGEMENT_CF_ACCESS_REQUIRED = "1";
    app = await startApp(makeCtx(stateDir, projectRoot));

    const baseHeaders = {
      "x-forwarded-host": "jk.example.test",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
      origin: "https://jk.example.test",
      "content-type": "application/json",
    };
    const blocked = await fetch(`${app.baseUrl}/api/jk/control/login`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({ ownerToken: OWNER_TOKEN }),
    });
    expect(blocked.status).toBe(403);

    const allowed = await fetch(`${app.baseUrl}/api/jk/control/login`, {
      method: "POST",
      headers: { ...baseHeaders, "cf-access-jwt-assertion": "unit-test-access-token" },
      body: JSON.stringify({ ownerToken: OWNER_TOKEN }),
    });
    expect(allowed.status).toBe(200);
  });

  it("returns status, persisted goals, and sanitized recent logs", async () => {
    const status = await (await fetch(`${app!.baseUrl}/api/jk/control/status`)).json() as any;
    expect(status.ok).toBe(true);
    expect(status.session.activeProjectId).toBe("proj");
    expect(status.runtime.name).toBe("JK");
    expect(status.deployment).toBeNull();

    const goals = await (await fetch(`${app!.baseUrl}/api/jk/control/goals`)).json() as any;
    expect(goals.goals[0]).toMatchObject({ projectId: "proj", currentGoal: "Finish dashboard", loopId: "loop-1" });

    const execution = await (await fetch(`${app!.baseUrl}/api/jk/control/execution`)).json() as any;
    expect(execution.execution.massUlw).toBeNull();

    const logs = await (await fetch(`${app!.baseUrl}/api/jk/control/logs`)).json() as any;
    expect(logs.logs[0]).toMatchObject({ type: "tool.call", projectId: "proj" });
    expect(logs.logs[0].detail).toContain("code_search");
  });

  it("returns persisted deployment status for the dashboard", async () => {
    const deployment = {
      state: "synced",
      deployedSha: "a".repeat(40),
      upstreamSha: "a".repeat(40),
      build: "pass",
      health: "pass",
      tunnel: "pass",
      lastSyncAtMs: Date.now(),
    };
    await writeFile(path.join(stateDir, "deploy-status.json"), `${JSON.stringify(deployment)}\n`);

    const status = await (await fetch(`${app!.baseUrl}/api/jk/control/status`)).json() as any;
    expect(status.deployment).toMatchObject(deployment);
  });

  it.skipIf(process.platform === "win32")("queues one fixed JK deployment sync approval and reuses it on repeated dashboard clicks", async () => {
    process.env.JK_DEPLOYMENT_PROJECT_ROOT = projectRoot;
    await mkdir(path.join(projectRoot, "src", "server"), { recursive: true });
    await mkdir(path.join(projectRoot, "scripts"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "server", "tools.ts"), "// marker\n");
    await writeFile(path.join(projectRoot, "scripts", "sync-jk-oci.sh"), "#!/usr/bin/env bash\n");
    await writeFile(path.join(projectRoot, "scripts", "reload-jk-runtime.sh"), "#!/usr/bin/env bash\n");

    const firstResponse = await fetch(`${app!.baseUrl}/api/jk/control/deployment/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "systemctl restart anything" }),
    });
    expect(firstResponse.status).toBe(202);
    const first = await firstResponse.json() as any;
    expect(first).toMatchObject({ ok: true, status: "pending", reused: false });
    expect(first.job.commandPreview).toBe("bash scripts/sync-jk-oci.sh --reload-current");
    expect(first.job.needsNetwork).toBe(true);
    expect(first.job.destructive).toBe(true);

    const secondResponse = await fetch(`${app!.baseUrl}/api/jk/control/deployment/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "rm -rf /" }),
    });
    expect(secondResponse.status).toBe(202);
    const second = await secondResponse.json() as any;
    expect(second).toMatchObject({ ok: true, status: "pending", reused: true, approvalId: first.approvalId });

    const approvals = await (await fetch(`${app!.baseUrl}/api/jk/control/approvals`)).json() as any;
    const deploymentApprovals = approvals.approvals.filter((item: any) => item.commandPreview === "bash scripts/sync-jk-oci.sh --reload-current");
    expect(deploymentApprovals).toHaveLength(1);
  });

  it("loads sanitized host-local quick links without hardcoding them in the public UI", async () => {
    const linksDir = path.join(stateDir, "control-center");
    await mkdir(linksDir, { recursive: true });
    await writeFile(path.join(linksDir, "quick-links.json"), `${JSON.stringify([
      { title: "Internal dashboard", href: "https://example.com/admin", note: "Private", badge: "Host", badgeClass: "ok" },
      { title: "Unsafe", href: "javascript:alert(1)" },
    ])}\n`);

    const status = await (await fetch(`${app!.baseUrl}/api/jk/control/status`)).json() as any;
    expect(status.quickLinks).toEqual([{
      title: "Internal dashboard",
      href: "https://example.com/admin",
      note: "Private",
      badge: "Host",
      badgeClass: "ok",
    }]);
  });

  it("activates a project with a fresh local lease", async () => {
    const response = await fetch(`${app!.baseUrl}/api/jk/control/projects/proj/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "read-only" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.lease.preset).toBe("read-only");
    expect(body.roleContext.effectivePermission).toBe("read-only");
  });

  it("arms a control lease from the owner Control Center", async () => {
    const response = await fetch(`${app!.baseUrl}/api/jk/control/projects/proj/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "control", controlApps: ["TextEdit", "Google Chrome", "TextEdit"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.lease.preset).toBe("control");
    expect(body.roleContext.effectivePermission).toBe("control");
    const status = await (await fetch(`${app!.baseUrl}/api/jk/control/status`)).json() as any;
    expect(status.session.controlAllowlist).toEqual(["TextEdit", "Google Chrome"]);
  });

  it("refuses empty or sensitive Computer Control allowlists", async () => {
    const empty = await fetch(`${app!.baseUrl}/api/jk/control/projects/proj/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "control", controlApps: [] }),
    });
    expect(empty.status).toBe(400);

    const sensitive = await fetch(`${app!.baseUrl}/api/jk/control/projects/proj/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "control", controlApps: ["1Password"] }),
    });
    expect(sensitive.status).toBe(400);
    expect(await sensitive.json()).toMatchObject({ code: "SENSITIVE_TARGET_BLOCKED" });
  });

  it("approving an old card does not authorize a later undeclared command", async () => {
    if (!app) throw new Error("test app missing");
    const input = { projectId: "proj", command: "qa-A", cwd: ".", taskIdentity: "goal:qa", workSessionId: "ws_qa",
      needsNetwork: false, destructive: true };
    const first = await requestLocalShellApproval(stateDir, input);
    const oldCard = await fetch(`${app.baseUrl}/api/jk/control/approvals`, { signal: AbortSignal.timeout(15000) });
    expect(oldCard.status).toBe(200);
    expect(await oldCard.json()).toMatchObject({ approvals: [first] });
    const retry = await requestLocalShellApproval(stateDir, { ...input, bundle: { label: "wider", entries: [input, { ...input, command: "qa-B" }] } });
    const response = await fetch(`${app.baseUrl}/api/jk/control/approvals/${first.id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
      signal: AbortSignal.timeout(15000),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(await consumeLocalShellApprovalGrant(stateDir, { ...input, command: "qa-B" })).toBeNull();
    expect(retry).toEqual(first);
    expect(result).toMatchObject({ ok: true, approval: { ...first, status: "approved" }, job: null });
    expect(await consumeLocalShellApprovalGrant(stateDir, input)).toMatchObject({ approvalId: first.id });
  });

  it.each(["approve", "supervise", "deny"] as const)("uses the stored %s decision for conflicting HTTP retries", async (decision) => {
    if (!app) throw new Error("test app missing");
    const input = { projectId: "proj", command: "node --version", cwd: ".", reason: "stored decision",
      taskIdentity: "goal:goal-1", needsNetwork: true, destructive: false };
    const requested = await requestLocalShellApproval(stateDir, input);
    const queued = await queueLocalShellJob(stateDir, requested, input);
    const storedStatus = decision === "deny" ? "denied" : "succeeded";
    await updateLocalShellJob(stateDir, queued.id, (current) => ({ ...current, status: storedStatus }));
    await resolveLocalShellApproval(stateDir, requested.id, decision);
    const resolved = once(jobEvents, "local.approval.resolved", { signal: AbortSignal.timeout(15000) });
    const response = await fetch(`${app.baseUrl}/api/jk/control/approvals/${requested.id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: decision === "deny" ? "approve" : "deny" }),
      signal: AbortSignal.timeout(15000),
    });
    const [audit] = await resolved;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approval: { status: decision === "deny" ? "denied" : "approved", resolvedDecision: decision },
      job: { id: queued.id, status: storedStatus },
    });
    expect(audit).toMatchObject({ approvalId: requested.id, decision });
    expect(await readLocalShellJob(stateDir, queued.id)).toMatchObject({ status: storedStatus });
  });

  it("surfaces shell approvals only on loopback and accepts supervised task approval", async () => {
    const requested = await requestLocalShellApproval(stateDir, {
      projectId: "proj",
      command: "git fetch origin",
      cwd: ".",
      reason: "refresh refs",
      needsNetwork: true,
      destructive: false,
    });

    const listResponse = await fetch(`${app!.baseUrl}/api/jk/control/approvals`);
    expect(listResponse.headers.get("cache-control")).toContain("no-store");
    const list = await listResponse.json() as any;
    expect(list.approvals).toHaveLength(1);
    expect(list.approvals[0]).toMatchObject({ id: requested.id, status: "pending", projectId: "proj", needsNetwork: true });

    const directPage = await fetch(`${app!.baseUrl}/approvals`);
    expect(directPage.status).toBe(200);
    const directHtml = await directPage.text();
    expect(directHtml).toContain('id="top-approvals"');
    expect(directHtml).toContain("location.pathname === '/approvals'");

    const external = await fetch(`${app!.baseUrl}/api/jk/control/approvals`, {
      headers: { "x-forwarded-for": "203.0.113.4" },
    });
    expect(external.status).toBe(403);

    const resolved = await fetch(`${app!.baseUrl}/api/jk/control/approvals/${requested.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "supervise" }),
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json() as any).approval.status).toBe("approved");

    const pendingAfter = await (await fetch(`${app!.baseUrl}/api/jk/control/approvals`)).json() as any;
    expect(pendingAfter.approvals).toHaveLength(0);
  });

  it("does not execute an approved pending job after its task workspace is archived", async () => {
    await git(projectRoot, ["init", "--quiet"]);
    await git(projectRoot, ["config", "user.name", "JK test"]);
    await git(projectRoot, ["config", "user.email", "test@localhost"]);
    await writeFile(path.join(projectRoot, "base.txt"), "source");
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "--quiet", "-m", "baseline"]);
    const tasks = new TaskWorkspaceStore(stateDir);
    const task = await tasks.create({ projectId: "proj", name: "example-service", root: projectRoot, aliases: [] }, "ws_pending", "Pending job");
    const approvalInput = {
      projectId: task.id, command: `node -e "require('node:fs').writeFileSync('must-not-run.txt','bad')"`,
      cwd: ".", reason: "pending workspace command", workSessionId: task.workSessionId,
      needsNetwork: true, destructive: false,
    };
    const requested = await requestLocalShellApproval(stateDir, approvalInput);
    await queueLocalShellJob(stateDir, requested, { ...approvalInput, writesWorkspace: true, timeoutSec: 10,
      executionTarget: await deriveLocalExecutionTarget(tempRoot, { projectId: task.id, root: tasks.root(task.id) }) });
    await tasks.locked(task.id, () => tasks.archive(task.id));
    const response = await fetch(`${app!.baseUrl}/api/jk/control/approvals/${requested.id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(200);
    expect((await readLocalShellJob(stateDir, requested.id))?.status).toBe("failed");
    await expect(readFile(path.join(tasks.root(task.id), "must-not-run.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(projectRoot, "must-not-run.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the exact queued shell job immediately after local approval without a caller retry", async () => {
    const command = `node -e "require('node:fs').writeFileSync('approved-job.txt','ok')"`;
    const approvalInput = {
      projectId: "proj",
      command,
      cwd: ".",
      reason: "test exact approval auto resume",
      taskIdentity: "goal:goal-1",
      needsNetwork: true,
      destructive: false,
    };
    const requested = await requestLocalShellApproval(stateDir, approvalInput);
    await queueLocalShellJob(stateDir, requested, {
      ...approvalInput,
      executionTarget: await deriveLocalExecutionTarget(tempRoot, { projectId: "proj", root: projectRoot }),
      timeoutSec: 10,
      writesWorkspace: true,
      continuation: { workSessionId: null, goalId: "goal-1", loopId: "loop-1" },
    });

    const finished = once(jobEvents, "local.job.finished", { signal: AbortSignal.timeout(15000) });
    const resolved = await fetch(`${app!.baseUrl}/api/jk/control/approvals/${requested.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json() as any).job.status).toBe("running");

    await finished;
    const job = await readLocalShellJob(stateDir, requested.id);
    expect(job).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(await readFile(path.join(projectRoot, "approved-job.txt"), "utf8")).toBe("ok");

    const after = await (await fetch(`${app!.baseUrl}/api/jk/control/approvals`)).json() as any;
    expect(after.approvals).toHaveLength(0);
    expect(after.jobs[0]).toMatchObject({ id: requested.id, status: "succeeded", commandPreview: command });

    const goals = await (await fetch(`${app!.baseUrl}/api/jk/control/goals`)).json() as any;
    expect(goals.goals[0].continuation).toMatchObject({
      jobId: requested.id,
      status: "ready-to-resume",
    });
  });

  it("resumes an already-authorized queued job even if the active lease changes while approval is pending", async () => {
    const command = `node -e "require('node:fs').writeFileSync('approved-after-lease-change.txt','ok')"`;
    const approvalInput = {
      projectId: "proj",
      command,
      cwd: ".",
      reason: "approval should resume the queued write",
      needsNetwork: true,
      destructive: false,
    };
    const requested = await requestLocalShellApproval(stateDir, approvalInput);
    await queueLocalShellJob(stateDir, requested, {
      ...approvalInput,
      executionTarget: await deriveLocalExecutionTarget(tempRoot, { projectId: "proj", root: projectRoot }),
      timeoutSec: 10,
      writesWorkspace: true,
      continuation: { workSessionId: null, goalId: "goal-1", loopId: "loop-1" },
    });

    const activate = await fetch(`${app!.baseUrl}/api/jk/control/projects/proj/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "read-only" }),
    });
    expect(activate.status).toBe(200);

    const finished = once(jobEvents, "local.job.finished", { signal: AbortSignal.timeout(15000) });
    const resolved = await fetch(`${app!.baseUrl}/api/jk/control/approvals/${requested.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json() as any).job.status).toBe("running");

    await finished;
    const job = await readLocalShellJob(stateDir, requested.id);
    expect(job).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(await readFile(path.join(projectRoot, "approved-after-lease-change.txt"), "utf8")).toBe("ok");

    const goals = await (await fetch(`${app!.baseUrl}/api/jk/control/goals`)).json() as any;
    expect(goals.goals[0].continuation).toMatchObject({
      jobId: requested.id,
      status: "ready-to-resume",
    });
  });
});
