import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import { findProject, nestedProjectRoots, scanWorkspace, scanWorkspaceWithRuntimeSelf } from "./registry.js";
import type { ProjectRegistryEntry } from "../types.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
}

describe("scanWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-ws-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds git repos as project candidates and derives metadata", async () => {
    const projDir = path.join(root, "alpha-app");
    await mkdir(projDir, { recursive: true });
    await initGitRepo(projDir);
    await writeFile(path.join(projDir, "package.json"), "{}");
    await writeFile(path.join(projDir, "AGENTS.md"), "# rules");
    await writeFile(path.join(projDir, "untracked.txt"), "x");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    const entry = entries[0] as ProjectRegistryEntry;
    expect(entry.projectId).toBe("alpha-app");
    expect(entry.name).toBe("alpha-app");
    expect(entry.root).toBe(projDir);
    expect(entry.packageHints).toContain("node");
    expect(entry.hasAgentsMd).toBe(true);
    expect(entry.hasCodeBrain).toBe(false);
    expect(entry.dirty).toBe(true); // untracked.txt makes it dirty
    expect(entry.aliases).toContain("alpha-app");
  });

  it("detects project marker folders without .git (e.g. package.json only)", async () => {
    const projDir = path.join(root, "flutter-app");
    await mkdir(projDir, { recursive: true });
    await writeFile(path.join(projDir, "pubspec.yaml"), "name: flutter_app");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.packageHints).toContain("flutter");
    expect(entries[0]?.branch).toBeUndefined();
  });

  it("detects .chatgpt2codex project marker folders", async () => {
    const projDir = path.join(root, "chatgpt2codex-project");
    await mkdir(path.join(projDir, ".chatgpt2codex"), { recursive: true });

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.projectId).toBe("chatgpt2codex-project");
  });

  it("discovers standalone repos inside a project's projects container", async () => {
    const hostDir = path.join(root, "host-app");
    const nestedDir = path.join(hostDir, "projects", "nested-tool");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(hostDir, "package.json"), "{}");
    await initGitRepo(nestedDir);

    const entries = await scanWorkspace(root);

    expect(entries.map((entry) => entry.projectId)).toEqual(expect.arrayContaining(["host-app", "nested-tool"]));
    expect(entries.find((entry) => entry.projectId === "nested-tool")?.root).toBe(nestedDir);
  });

  it("includes the workspace root itself when it is a project folder", async () => {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "single-project" }));

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      projectId: path.basename(root).toLowerCase(),
      name: path.basename(root),
      root,
      packageHints: ["node"],
    });
  });

  it("keeps the folder id stable while exposing package.json name as a logical alias", async () => {
    const projDir = path.join(root, "workspace-root");
    await mkdir(projDir, { recursive: true });
    await writeFile(path.join(projDir, "package.json"), JSON.stringify({ name: "example-service" }));

    const entries = await scanWorkspace(root);
    const project = entries.find((entry) => entry.projectId === "workspace-root");

    expect(project?.projectId).toBe("workspace-root");
    expect(project?.aliases).toContain("example-service");
  });

  it("excludes plain folders with no project markers", async () => {
    await mkdir(path.join(root, "just-a-folder"), { recursive: true });
    await writeFile(path.join(root, "just-a-folder", "notes.txt"), "hi");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(0);
  });

  it("skips hidden directories", async () => {
    const hidden = path.join(root, ".config");
    await mkdir(hidden, { recursive: true });
    await initGitRepo(hidden);

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(0);
  });

  it("detects hasCodeBrain when .ai/bin/ai exists", async () => {
    const projDir = path.join(root, "go-service");
    await mkdir(path.join(projDir, ".ai", "bin"), { recursive: true });
    await writeFile(path.join(projDir, ".ai", "bin", "ai"), "#!/bin/sh\n");
    await writeFile(path.join(projDir, "go.mod"), "module go-service\n");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.hasCodeBrain).toBe(true);
    expect(entries[0]?.packageHints).toContain("go");
  });


  it("returns only minimal nested roots from the same execution location", () => {
    const parent: ProjectRegistryEntry = { projectId: "parent", name: "parent", root, aliases: ["parent"] };
    const childRoot = path.join(root, "child");
    const grandchildRoot = path.join(childRoot, "deep");
    const child: ProjectRegistryEntry = { projectId: "child", name: "child", root: childRoot, aliases: ["child"] };
    const grandchild: ProjectRegistryEntry = { projectId: "deep", name: "deep", root: grandchildRoot, aliases: ["deep"] };
    const remote: ProjectRegistryEntry = {
      projectId: "windows-main::child", name: "child", root: "C:\\workspace\\child", aliases: ["child"],
      executorKind: "remote", executorId: "windows-main", sourceProjectId: "child",
    };

    expect(nestedProjectRoots([parent, child, grandchild, remote], parent)).toEqual([path.resolve(childRoot)]);
  });

  it("throws WORKSPACE_NOT_READY when root does not exist", async () => {
    await expect(scanWorkspace(path.join(root, "does-not-exist"))).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_NOT_READY,
    });
  });

  it("keeps the development JK runtime registered when the selected workspace is another project", async () => {
    const selectedProject = path.join(root, "ExampleApp");
    const runtimeRoot = path.join(root, "chatgpt2codex-source");
    await mkdir(selectedProject, { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(path.join(selectedProject, "package.json"), JSON.stringify({ name: "example-app" }));
    await writeFile(path.join(runtimeRoot, "package.json"), JSON.stringify({ name: "chatgpt2codex" }));

    const entries = await scanWorkspaceWithRuntimeSelf(selectedProject, runtimeRoot, "development");

    expect(entries.map((entry) => path.resolve(entry.root))).toEqual(
      expect.arrayContaining([path.resolve(selectedProject), path.resolve(runtimeRoot)]),
    );
    expect(entries.find((entry) => path.resolve(entry.root) === path.resolve(runtimeRoot))?.projectId).toBe(
      "chatgpt2codex-source",
    );
  });

  it("does not widen the registry with the runtime root outside development mode", async () => {
    const selectedProject = path.join(root, "ExampleApp");
    const runtimeRoot = path.join(root, "portable-runtime");
    await mkdir(selectedProject, { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(path.join(selectedProject, "package.json"), "{}");
    await writeFile(path.join(runtimeRoot, "package.json"), "{}");

    const entries = await scanWorkspaceWithRuntimeSelf(selectedProject, runtimeRoot, "portable");

    expect(entries).toHaveLength(1);
    expect(path.resolve(entries[0]!.root)).toBe(path.resolve(selectedProject));
  });
});

describe("findProject", () => {
  const alpha: ProjectRegistryEntry = {
    projectId: "alpha-app",
    name: "alpha-app",
    root: "/workspace/alpha-app",
    aliases: ["alpha-app", "alpha"],
    branch: "develop",
    dirty: true,
  };
  const beta: ProjectRegistryEntry = {
    projectId: "beta-app",
    name: "beta-app",
    root: "/workspace/beta-app",
    aliases: ["beta-app", "beta"],
  };
  const gamma: ProjectRegistryEntry = {
    projectId: "gamma-app",
    name: "gamma-app",
    root: "/workspace/gamma-app",
    aliases: ["gamma-app"],
  };
  const entries = [alpha, beta, gamma];

  it("resolves exact match by projectId", () => {
    const result = findProject(entries, { projectId: "beta-app" });
    expect(result).toEqual({ ok: true, entry: beta });
  });

  it("returns not_found for unknown projectId", () => {
    const result = findProject(entries, { projectId: "nope" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("resolves exact single match by name", () => {
    const result = findProject(entries, { name: "alpha-app" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.projectId).toBe("alpha-app");
  });

  it("resolves exact single match by alias (case/hyphen/space insensitive)", () => {
    const result = findProject(entries, { name: "Beta" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.projectId).toBe("beta-app");
  });

  it("resolves alias exact match", () => {
    const result = findProject(entries, { name: "alpha" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.projectId).toBe("alpha-app");
  });

  it("returns ambiguous with candidates when multiple entries share a normalized name", () => {
    const dupA: ProjectRegistryEntry = {
      projectId: "shop-a",
      name: "shop",
      root: "/ws/shop-a",
      aliases: ["shop"],
    };
    const dupB: ProjectRegistryEntry = {
      projectId: "shop-b",
      name: "shop",
      root: "/ws/shop-b",
      aliases: ["shop"],
    };
    const result = findProject([dupA, dupB], { name: "shop" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("falls back to fuzzy match with a clear gap", () => {
    const result = findProject(entries, { name: "alpah-app" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.projectId).toBe("alpha-app");
  });

  it("returns ambiguous top3 when fuzzy match has no clear gap", () => {
    const close = [
      { ...alpha, projectId: "aaa", name: "aaa", aliases: ["aaa"] },
      { ...alpha, projectId: "aab", name: "aab", aliases: ["aab"] },
      { ...alpha, projectId: "aac", name: "aac", aliases: ["aac"] },
    ];
    const result = findProject(close, { name: "aad" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
      expect(result.candidates?.length).toBeGreaterThan(0);
    }
  });

  it("returns not_found when neither projectId nor name is given", () => {
    const result = findProject(entries, {});
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found on empty registry with a name query", () => {
    const result = findProject([], { name: "anything" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
