import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import { assertInWorkspace, resolveInProject } from "./paths.js";

describe("resolveInProject", () => {
  let tmpRoot: string;
  let projectRoot: string;
  let outside: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-paths-"));
    projectRoot = path.join(tmpRoot, "project");
    outside = path.join(tmpRoot, "outside");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "file.txt"), "hello");
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "a.ts"), "export {}");
    await fs.writeFile(path.join(outside, "secret.txt"), "outside-content");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("resolves a plain nested relative path inside the project", async () => {
    const resolved = await resolveInProject(projectRoot, "src/a.ts");
    const realRoot = await fs.realpath(projectRoot);
    expect(resolved).toBe(path.join(realRoot, "src", "a.ts"));
  });

  it("resolves the root itself for '.' or empty string", async () => {
    const realRoot = await fs.realpath(projectRoot);
    expect(await resolveInProject(projectRoot, ".")).toBe(realRoot);
    expect(await resolveInProject(projectRoot, "")).toBe(realRoot);
  });

  it("rejects a naive '../' escape via string traversal", async () => {
    await expect(resolveInProject(projectRoot, "../outside/secret.txt")).rejects.toMatchObject({
      code: ErrorCode.PATH_OUTSIDE_PROJECT,
    });
  });

  it("rejects an absolute path pointing outside the root", async () => {
    await expect(
      resolveInProject(projectRoot, path.join(outside, "secret.txt")),
    ).rejects.toMatchObject({ code: ErrorCode.PATH_OUTSIDE_PROJECT });
  });

  it("rejects a symlinked directory component that escapes the project root", async () => {
    // Create a symlink inside the project that points outside it, then try
    // to resolve a path that traverses through the symlink.
    const linkPath = path.join(projectRoot, "escape-link");
    await fs.symlink(outside, linkPath, "dir");

    await expect(resolveInProject(projectRoot, "escape-link/secret.txt")).rejects.toThrow(
      DomainError,
    );
    await expect(resolveInProject(projectRoot, "escape-link/secret.txt")).rejects.toMatchObject({
      code: ErrorCode.PATH_OUTSIDE_PROJECT,
    });
  });

  it("rejects a symlinked leaf file that escapes the project root by default", async () => {
    const linkPath = path.join(projectRoot, "leaf-link.txt");
    await fs.symlink(path.join(outside, "secret.txt"), linkPath, "file");

    await expect(resolveInProject(projectRoot, "leaf-link.txt")).rejects.toMatchObject({
      code: ErrorCode.PATH_OUTSIDE_PROJECT,
    });
  });

  it("allows an explicitly trusted leaf symlink when the target stays inside the project", async () => {
    const actual = path.join(projectRoot, "src", "AGENTS.actual.md");
    const linkPath = path.join(projectRoot, "AGENTS.md");
    await fs.writeFile(actual, "rules");
    await fs.symlink(actual, linkPath, "file");

    await expect(resolveInProject(projectRoot, "AGENTS.md", { allowSymlink: true })).resolves.toBe(
      await fs.realpath(actual),
    );
  });

  it("rejects an explicitly trusted leaf symlink when the target escapes the project", async () => {
    const linkPath = path.join(projectRoot, "AGENTS.md");
    await fs.symlink(path.join(outside, "secret.txt"), linkPath, "file");

    await expect(resolveInProject(projectRoot, "AGENTS.md", { allowSymlink: true })).rejects.toMatchObject({
      code: ErrorCode.PATH_OUTSIDE_WORKSPACE,
    });
  });

  it("rejects nullbyte-containing paths", async () => {
    await expect(resolveInProject(projectRoot, "src/a.ts\0.png")).rejects.toMatchObject({
      code: ErrorCode.NULLBYTE_REJECTED,
    });
  });

  it("allows resolution of a not-yet-existing file for creation", async () => {
    const resolved = await resolveInProject(projectRoot, "new-file.txt");
    const realRoot = await fs.realpath(projectRoot);
    expect(resolved).toBe(path.join(realRoot, "new-file.txt"));
  });
});

describe("assertInWorkspace", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-ws-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("passes for a path inside the workspace", () => {
    const ws = path.join(tmpRoot, "workspace");
    const abs = path.join(ws, "proj", "file.txt");
    expect(() => assertInWorkspace(abs, ws)).not.toThrow();
  });

  it("passes for the workspace root itself", () => {
    const ws = path.join(tmpRoot, "workspace");
    expect(() => assertInWorkspace(ws, ws)).not.toThrow();
  });

  it("throws PATH_OUTSIDE_WORKSPACE for a sibling directory", () => {
    const ws = path.join(tmpRoot, "workspace");
    const sibling = path.join(tmpRoot, "other", "file.txt");
    expect(() => assertInWorkspace(sibling, ws)).toThrow(DomainError);
    try {
      assertInWorkspace(sibling, ws);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as DomainError).code).toBe(ErrorCode.PATH_OUTSIDE_WORKSPACE);
    }
  });

  it("throws NULLBYTE_REJECTED for nullbyte input", () => {
    const ws = path.join(tmpRoot, "workspace");
    expect(() => assertInWorkspace(`${ws}/a\0b`, ws)).toThrow(DomainError);
  });
});
