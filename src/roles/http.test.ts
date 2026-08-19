import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "../server/http.js";
import { recordExecutorHeartbeat } from "../executors/broker.js";

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function makeCtx(stateDir: string, projectRoot: string): ToolContext {
  const registry = [{ projectId: "proj", name: "example-service", root: projectRoot, aliases: ["example-service"] }];
  let currentSession: unknown = {
    activeProjectId: "proj",
    mode: "act",
    lease: {
      projectId: "proj",
      leaseId: "lease-role-http-test",
      projectRoot,
      preset: "full-write",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
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

let tempRoot = "";
let stateDir = "";
let projectRoot = "";
let app: Awaited<ReturnType<typeof startApp>> | null = null;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "jk-role-http-"));
  stateDir = path.join(tempRoot, "state");
  projectRoot = path.join(tempRoot, "example-service");
  await mkdir(projectRoot, { recursive: true });
  app = await startApp(makeCtx(stateDir, projectRoot));
});

afterEach(async () => {
  if (app) await app.stop();
  app = null;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe("local JK role management API", () => {
  it("collapses a remote executor mirror that aliases the same logical project", async () => {
    await recordExecutorHeartbeat(stateDir, {
      executorId: "windows-main",
      label: "Windows PC",
      platform: "win32/x64",
      workspaceRoot: "C:\\JK",
      capabilities: ["code_search"],
      projects: [{
        projectId: "workspace-root",
        name: "workspace-root",
        root: "C:\\workspace",
        aliases: ["workspace-root", "example-service"],
      }],
    });

    const response = await fetch(`${app!.baseUrl}/api/jk/projects`);
    expect(response.status).toBe(200);
    const body = await response.json() as { projects: Array<{ projectId: string }> };
    expect(body.projects.map((project) => project.projectId)).toEqual(["proj"]);
  });

  it("lists built-in roles and the active project context", async () => {
    const response = await fetch(`${app!.baseUrl}/api/jk/roles?projectId=proj`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.roles.map((role: any) => role.name)).toEqual([
      "Default",
      "Builder",
      "Reviewer",
      "QA Engineer",
      "Researcher",
      "Planner",
    ]);
    expect(body.activeRoleContext.projectName).toBe("example-service");
    expect(body.activeRoleContext.role.name).toBe("Default");
    expect(body.activeRoleContext.effectivePermission).toBe("full-write");
  });

  it("creates a custom role, selects it, and reports the reduced effective permission", async () => {
    const createResponse = await fetch(`${app!.baseUrl}/api/jk/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Backend Reviewer",
        description: "운영 백엔드 QA",
        instructions: "보안 → 동시성 → DB → 성능 순으로 검토한다.",
        permissionPreset: "read-only",
        tools: ["code_search", "file_read"],
        skills: ["Backend", "Security"],
        workflowPreference: "Evidence first",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as any;

    const selectResponse = await fetch(`${app!.baseUrl}/api/jk/projects/proj/role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: created.role.id }),
    });
    expect(selectResponse.status).toBe(200);
    const selected = (await selectResponse.json()) as any;
    expect(selected.context.role.name).toBe("Backend Reviewer");
    expect(selected.context.projectPermission).toBe("full-write");
    expect(selected.context.effectivePermission).toBe("read-only");
    expect(selected.context.contextText).toContain("ACTIVE ROLE\nBackend Reviewer");
  });

  it("supports project defaults plus export/import/delete lifecycle", async () => {
    const create = await fetch(`${app!.baseUrl}/api/jk/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Portable QA", permissionPreset: "tests-only", tools: ["code_search", "file_read", "tests"] }),
    });
    const created = (await create.json()) as any;

    const defaultResponse = await fetch(`${app!.baseUrl}/api/jk/projects/proj/default-role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: created.role.id }),
    });
    expect(defaultResponse.status).toBe(200);
    const defaulted = (await defaultResponse.json()) as any;
    expect(defaulted.context.defaultRoleId).toBe(created.role.id);
    expect(defaulted.context.selectionSource).toBe("project-default");

    const exportedResponse = await fetch(`${app!.baseUrl}/api/jk/roles/export`);
    expect(exportedResponse.status).toBe(200);
    const exported = (await exportedResponse.json()) as any;
    expect(exported.bundle.roles.map((role: any) => role.id)).toContain(created.role.id);

    const deleteResponse = await fetch(`${app!.baseUrl}/api/jk/roles/${created.role.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
    const afterDelete = (await (await fetch(`${app!.baseUrl}/api/jk/projects/proj/role`)).json()) as any;
    expect(afterDelete.context.role.id).toBe("default");

    const imported = await fetch(`${app!.baseUrl}/api/jk/roles/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exported.bundle),
    });
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as any).imported).toBe(1);
  });

  it("rejects role-management requests that arrive as non-loopback traffic", async () => {
    const response = await fetch(`${app!.baseUrl}/api/jk/roles`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    expect(response.status).toBe(403);
  });
});
