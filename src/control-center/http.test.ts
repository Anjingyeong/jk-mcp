import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "../server/http.js";
import { requestLocalShellApproval } from "../policy/local-approvals.js";
import { queueLocalShellJob, readLocalShellJob } from "../policy/local-shell-jobs.js";
import { storeOwnerToken } from "../auth/owner-token.js";

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
    ledger: { append: async () => undefined },
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
});

describe("JK Control Center", () => {
  it("keeps core HTTP health available when the optional management surface is headless", async () => {
    await app!.stop();
    app = await startApp(makeCtx(stateDir, projectRoot), false);

    expect((await fetch(`${app.baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${app.baseUrl}/`)).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/api/jk/roles`)).status).toBe(404);
  });

  it("serves the local dashboard and blocks forwarded non-loopback access", async () => {
    const local = await fetch(`${app!.baseUrl}/`);
    expect(local.status).toBe(200);
    expect(local.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await local.text();
    expect(html).toContain("JK Control Center");
    expect(html).toContain("JK 시작 가이드");
    expect(html).toContain("실행 단계");
    expect(html).toContain("AUTO ORCHESTRATION");
    expect(html).toContain("Activity");
    expect(html).toContain("Settings");
    expect(html).toContain("Secure remote admin");
    expect(html).toContain("Authenticated remote");
    expect(html).not.toContain("Local admin only");
    expect(html).toContain("workflow-rail-root");
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

  it("returns status, persisted goals, and sanitized recent logs", async () => {
    const status = await (await fetch(`${app!.baseUrl}/api/jk/control/status`)).json() as any;
    expect(status.ok).toBe(true);
    expect(status.session.activeProjectId).toBe("proj");
    expect(status.runtime.name).toBe("JK");
    expect(status.deployment).toBeNull();

    const goals = await (await fetch(`${app!.baseUrl}/api/jk/control/goals`)).json() as any;
    expect(goals.goals[0]).toMatchObject({ projectId: "proj", currentGoal: "Finish dashboard", loopId: "loop-1" });

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

  it("runs the exact queued shell job immediately after local approval without a caller retry", async () => {
    const command = `node -e "require('node:fs').writeFileSync('approved-job.txt','ok')"`;
    const approvalInput = {
      projectId: "proj",
      command,
      cwd: ".",
      reason: "test exact approval auto resume",
      needsNetwork: true,
      destructive: false,
    };
    const requested = await requestLocalShellApproval(stateDir, approvalInput);
    await queueLocalShellJob(stateDir, requested, {
      ...approvalInput,
      timeoutSec: 10,
      writesWorkspace: true,
      continuation: { workSessionId: null, goalId: "goal-1", loopId: "loop-1" },
    });

    const resolved = await fetch(`${app!.baseUrl}/api/jk/control/approvals/${requested.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json() as any).job.status).toBe("running");

    let job = await readLocalShellJob(stateDir, requested.id);
    for (let i = 0; i < 50 && job?.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = await readLocalShellJob(stateDir, requested.id);
    }
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

  it("rechecks the project lease before starting an approved queued job", async () => {
    const command = `node -e "require('node:fs').writeFileSync('must-not-run.txt','no')"`;
    const approvalInput = {
      projectId: "proj",
      command,
      cwd: ".",
      reason: "lease must still allow the approved write",
      needsNetwork: true,
      destructive: false,
    };
    const requested = await requestLocalShellApproval(stateDir, approvalInput);
    await queueLocalShellJob(stateDir, requested, {
      ...approvalInput,
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

    const resolved = await fetch(`${app!.baseUrl}/api/jk/control/approvals/${requested.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json() as any).job.status).toBe("failed");
    await expect(readFile(path.join(projectRoot, "must-not-run.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const goals = await (await fetch(`${app!.baseUrl}/api/jk/control/goals`)).json() as any;
    expect(goals.goals[0].continuation).toMatchObject({
      jobId: requested.id,
      status: "blocked",
    });
  });
});
