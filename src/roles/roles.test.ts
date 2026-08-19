import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import {
  BUILT_IN_ROLES,
  autoSelectRoleForTask,
  buildActiveRoleContext,
  computeEffectivePermission,
  deleteCustomRole,
  enforceActiveRoleToolAccess,
  exportRoleBundle,
  getActiveRoleForProject,
  importRoleBundle,
  listRoles,
  saveCustomRole,
  selectRoleForProject,
  setDefaultRoleForProject,
} from "./roles.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "jk-roles-"));
});

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

function fakeContext(projectPreset: "read-only" | "tests-only" | "full-write" | "image-only" | "control" = "full-write") {
  const lease = {
    projectId: "alpha",
    leaseId: "lease-test",
    projectRoot: "/tmp/alpha",
    preset: projectPreset,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  return {
    stateDir,
    registry: [{ projectId: "alpha", name: "Alpha", root: "/tmp/alpha", aliases: ["alpha"] }],
    store: {
      getSession: async () => ({ activeProjectId: "alpha", lease }),
    },
  } as unknown as ToolContext;
}

function aliasContext() {
  const ctx = fakeContext();
  ctx.registry = [{
    projectId: "llm-wiki-strange",
    name: "llm_wiki_strange",
    root: "/tmp/alpha",
    aliases: ["llm_wiki_strange", "llm-wiki-strange"],
  }];
  return ctx;
}

describe("Roles v1 defaults", () => {
  it("ships the expected built-in roles", async () => {
    expect(BUILT_IN_ROLES.map((role) => role.name)).toEqual([
      "Default",
      "Builder",
      "Reviewer",
      "QA Engineer",
      "Researcher",
      "Planner",
    ]);
    const roles = await listRoles(stateDir);
    expect(roles).toHaveLength(6);
    expect(roles[0]?.permissionPreset).toBe("inherit");
  });
});

describe("effective permission intersection", () => {
  it("keeps legacy behavior for Default/inherit", () => {
    expect(computeEffectivePermission("full-write", "inherit")).toBe("full-write");
    expect(computeEffectivePermission("control", "inherit")).toBe("control");
  });

  it("never lets a role expand the project permission", () => {
    expect(computeEffectivePermission("read-only", "full-write")).toBe("read-only");
    expect(computeEffectivePermission("tests-only", "full-write")).toBe("tests-only");
    expect(computeEffectivePermission("full-write", "read-only")).toBe("read-only");
    expect(computeEffectivePermission("full-write", "tests-only")).toBe("tests-only");
    expect(computeEffectivePermission("tests-only", "image-only")).toBe("read-only");
  });
});

describe("role persistence and active project selection", () => {
  it("saves a custom role and selects it per project", async () => {
    const custom = await saveCustomRole(stateDir, {
      name: "Backend Reviewer Custom",
      description: "prod review",
      instructions: "Review security first.",
      permissionPreset: "read-only",
      tools: ["code_search", "file_read"],
      skills: ["Backend", "Security"],
      workflowPreference: "Evidence first",
    });
    expect(custom.builtIn).toBe(false);

    await selectRoleForProject(stateDir, "alpha", custom.id);
    const active = await getActiveRoleForProject(stateDir, "alpha");
    expect(active.id).toBe(custom.id);

    const context = await buildActiveRoleContext(fakeContext(), "alpha", "full-write");
    expect(context.role.name).toBe("Backend Reviewer Custom");
    expect(context.effectivePermission).toBe("read-only");
    expect(context.contextText).toContain("ACTIVE ROLE\nBackend Reviewer Custom");
    expect(context.contextText).toContain("EFFECTIVE PERMISSION\nread-only");
  });

  it("canonicalizes a fuzzy legacy project key and migrates its active role", async () => {
    await selectRoleForProject(stateDir, "llm-wiki", "reviewer");
    const context = await buildActiveRoleContext(aliasContext(), "llm-wiki", "full-write");

    expect(context.projectId).toBe("llm-wiki-strange");
    expect(context.projectName).toBe("llm_wiki_strange");
    expect(context.role.id).toBe("reviewer");
    expect(await getActiveRoleForProject(stateDir, "llm-wiki-strange")).toMatchObject({ id: "reviewer" });
    expect(await getActiveRoleForProject(stateDir, "llm-wiki")).toMatchObject({ id: "default" });
  });

  it("uses a project default when no last-used role exists, then prefers last-used", async () => {
    await setDefaultRoleForProject(stateDir, "alpha", "reviewer");
    const defaultContext = await buildActiveRoleContext(fakeContext(), "alpha", "full-write");
    expect(defaultContext.role.id).toBe("reviewer");
    expect(defaultContext.defaultRoleId).toBe("reviewer");
    expect(defaultContext.selectionSource).toBe("project-default");

    await selectRoleForProject(stateDir, "alpha", "builder");
    const lastUsedContext = await buildActiveRoleContext(fakeContext(), "alpha", "full-write");
    expect(lastUsedContext.role.id).toBe("builder");
    expect(lastUsedContext.defaultRoleId).toBe("reviewer");
    expect(lastUsedContext.selectionSource).toBe("last-used");
  });

  it("auto-selects a built-in role from task intent until the user manually overrides it", async () => {
    const ctx = fakeContext("full-write");

    await autoSelectRoleForTask(ctx, "alpha", { mode: "review", goal: "코드 리뷰해줘" });
    const reviewContext = await buildActiveRoleContext(ctx, "alpha", "full-write");
    expect(reviewContext.role.id).toBe("reviewer");
    expect(reviewContext.selectionSource).toBe("auto");

    await autoSelectRoleForTask(ctx, "alpha", { mode: "implement", goal: "기능 구현해줘" });
    const buildContext = await buildActiveRoleContext(ctx, "alpha", "full-write");
    expect(buildContext.role.id).toBe("builder");
    expect(buildContext.selectionSource).toBe("auto");

    await selectRoleForProject(stateDir, "alpha", "reviewer");
    await autoSelectRoleForTask(ctx, "alpha", { mode: "implement", goal: "기능 구현해줘" });
    const manualContext = await buildActiveRoleContext(ctx, "alpha", "full-write");
    expect(manualContext.role.id).toBe("reviewer");
    expect(manualContext.selectionSource).toBe("last-used");
  });

  it("recognizes QA-only requests without hijacking implementation requests that also mention QA", async () => {
    const ctx = fakeContext("full-write");

    await autoSelectRoleForTask(ctx, "alpha", { mode: "implement", goal: "QA 해줘" });
    expect((await buildActiveRoleContext(ctx, "alpha", "full-write")).role.id).toBe("qa-engineer");

    await autoSelectRoleForTask(ctx, "alpha", { mode: "implement", goal: "기능 구현하고 QA까지 진행" });
    expect((await buildActiveRoleContext(ctx, "alpha", "full-write")).role.id).toBe("builder");
  });

  it("exports/imports custom roles and cleans selections when deleting one", async () => {
    const custom = await saveCustomRole(stateDir, {
      name: "Portable QA",
      permissionPreset: "tests-only",
      tools: ["code_search", "file_read", "tests"],
      skills: ["QA"],
    });
    await selectRoleForProject(stateDir, "alpha", custom.id);
    await setDefaultRoleForProject(stateDir, "alpha", custom.id);
    const bundle = await exportRoleBundle(stateDir);
    expect(bundle.roles.map((role) => role.id)).toContain(custom.id);

    const otherStateDir = await mkdtemp(path.join(os.tmpdir(), "jk-roles-import-"));
    try {
      const imported = await importRoleBundle(otherStateDir, bundle);
      expect(imported.imported).toBe(1);
      expect((await listRoles(otherStateDir)).some((role) => role.id === custom.id)).toBe(true);
    } finally {
      await rm(otherStateDir, { recursive: true, force: true });
    }

    expect(await deleteCustomRole(stateDir, custom.id)).toBe(true);
    expect((await getActiveRoleForProject(stateDir, "alpha")).id).toBe("default");
  });
});

describe("runtime role enforcement", () => {
  it("blocks write capability when project is full-write but active role is Reviewer", async () => {
    await selectRoleForProject(stateDir, "alpha", "reviewer");
    const ctx = fakeContext("full-write");

    await expect(requireProjectLease(ctx, "alpha", "read")).resolves.toMatchObject({ preset: "full-write" });
    await expect(requireProjectLease(ctx, "alpha", "write")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("blocks a Role tool category even when the project lease could write", async () => {
    await selectRoleForProject(stateDir, "alpha", "reviewer");
    const ctx = fakeContext("full-write");

    await expect(enforceActiveRoleToolAccess(ctx, "code_search", { projectId: "alpha" })).resolves.toBeUndefined();
    await expect(enforceActiveRoleToolAccess(ctx, "file_apply_patch", { projectId: "alpha" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("does not expand a read-only project when Builder is active", async () => {
    await selectRoleForProject(stateDir, "alpha", "builder");
    const ctx = fakeContext("read-only");
    await expect(requireProjectLease(ctx, "alpha", "write")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
