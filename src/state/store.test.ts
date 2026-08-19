import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";
import type { ProjectRegistryEntry } from "../types.js";

describe("Store", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-store-"));
    store = new Store(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty project list before anything is saved", async () => {
    const projects = await store.loadProjects();
    expect(projects).toEqual([]);
  });

  it("round-trips projects through save/load", async () => {
    const projects: ProjectRegistryEntry[] = [
      {
        projectId: "alpha-app",
        name: "alpha-app",
        root: "/workspace/alpha-app",
        aliases: ["alpha-app", "alpha"],
        branch: "develop",
        dirty: true,
        hasAgentsMd: true,
        hasCodeBrain: true,
        packageHints: ["flutter", "node"],
        lastSeenAt: "2026-07-03T00:00:00+09:00",
      },
      {
        projectId: "beta-app",
        name: "beta-app",
        root: "/workspace/beta-app",
        aliases: ["beta-app"],
      },
    ];

    await store.saveProjects(projects);
    const loaded = await store.loadProjects();
    expect(loaded).toEqual(projects);
  });

  it("overwrites the previous snapshot on subsequent saves", async () => {
    await store.saveProjects([
      { projectId: "a", name: "a", root: "/a", aliases: ["a"] },
    ]);
    await store.saveProjects([
      { projectId: "b", name: "b", root: "/b", aliases: ["b"] },
    ]);
    const loaded = await store.loadProjects();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.projectId).toBe("b");
  });

  it("creates the state directory with 0700 permissions", async () => {
    if (process.platform === "win32") return;
    await store.saveProjects([]);
    const dirStat = await stat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("writes projects.json with 0600 permissions", async () => {
    if (process.platform === "win32") return;
    await store.saveProjects([]);
    const fileStat = await stat(join(dir, "projects.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("leaves no leftover temp files after a save", async () => {
    await store.saveProjects([{ projectId: "x", name: "x", root: "/x", aliases: [] }]);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
  });

  it("rejects a corrupt projects.json instead of silently coercing it", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "projects.json"), JSON.stringify({ not: "valid" }), "utf8");
    await expect(store.loadProjects()).rejects.toThrow();
  });

  it("defaults session to observe mode with no active project", async () => {
    const session = await store.getSession();
    expect(session.mode).toBe("observe");
    expect(session.activeProjectId).toBeNull();
    expect(session.lease).toBeNull();
    expect(session.workContext).toBeNull();
    expect(session.workContexts).toEqual({});
  });

  it("round-trips a session with an active lease", async () => {
    await store.setSession({
      activeProjectId: "alpha-app",
      mode: "edit",
      lease: {
        projectId: "alpha-app",
        leaseId: "lease-1",
        projectRoot: "/workspace/alpha-app",
        preset: "full-write",
        issuedAt: 1000,
        expiresAt: 2000,
      },
    });
    const session = await store.getSession();
    expect(session.activeProjectId).toBe("alpha-app");
    expect(session.mode).toBe("edit");
    expect(session.lease?.leaseId).toBe("lease-1");
  });

  it("migrates a legacy single workContext write into session schema v4", async () => {
    await store.setSession({
      version: 1,
      activeProjectId: "alpha-app",
      mode: "read",
      lease: null,
      workContext: {
        projectId: "alpha-app",
        activeArtifact: "portfolio.html",
        recentFiles: [
          {
            path: "portfolio.html",
            fileHash: "abc123",
            lastAction: "read",
            lastTouchedAt: 1234,
            start: 100,
            end: 140,
          },
        ],
        lastCheckpointId: "cp_1",
        lastActivityAt: 1234,
      },
    });

    const session = await store.getSession();
    expect(session.version).toBe(5);
    expect(session.workContext).toBeNull();
    expect(session.workContexts["alpha-app"]?.activeArtifact).toBe("portfolio.html");
    expect(session.workContexts["alpha-app"]?.recentFiles[0]).toMatchObject({
      path: "portfolio.html",
      fileHash: "abc123",
      start: 100,
      end: 140,
    });
    expect(session.workContexts["alpha-app"]?.lastMutation).toBeNull();
    expect(session.workContexts["alpha-app"]?.lastVerification).toBeNull();
    expect(session.workContexts["alpha-app"]?.taskState).toMatchObject({
      goalId: null,
      loopId: null,
      currentGoal: null,
      currentTask: null,
      completed: [],
      pending: [],
      decisions: [],
    });
  });

  it("round-trips structured task state for a project work context", async () => {
    await store.setSession({
      activeProjectId: "alpha-app",
      mode: "read",
      lease: null,
      workContexts: {
        "alpha-app": {
          projectId: "alpha-app",
          activeArtifact: "src/app.ts",
          recentFiles: [],
          lastCheckpointId: null,
          lastMutation: null,
          lastVerification: null,
          taskState: {
            goalId: "goal-1",
            loopId: "loop-1",
            currentGoal: "Improve session persistence",
            currentTask: "Persist semantic progress",
            lastProgressSummary: "Schema added",
            completed: ["Add schema"],
            pending: ["Wire resume"],
            decisions: [
              {
                summary: "Use structured progress",
                rationale: "Avoid parsing arbitrary prose",
                at: 1234,
              },
            ],
            updatedAt: 1234,
          },
          lastActivityAt: 1234,
        },
      },
    });

    const session = await store.getSession();
    expect(session.version).toBe(5);
    expect(session.workContexts["alpha-app"]?.taskState).toMatchObject({
      goalId: "goal-1",
      loopId: "loop-1",
      currentGoal: "Improve session persistence",
      currentTask: "Persist semantic progress",
      completed: ["Add schema"],
      pending: ["Wire resume"],
    });
    expect(session.workContexts["alpha-app"]?.taskState.decisions[0]).toMatchObject({
      summary: "Use structured progress",
      rationale: "Avoid parsing arbitrary prose",
    });
  });

  it("round-trips isolated workSessions alongside the legacy project-default context", async () => {
    await store.setSession({
      activeProjectId: "alpha-app",
      mode: "read",
      lease: null,
      workContexts: {},
      workSessions: {
        "alpha-app": {
          ws_alpha: {
            projectId: "alpha-app",
            workSessionId: "ws_alpha",
            activeArtifact: "alpha.html",
            recentFiles: [],
            lastCheckpointId: null,
            lastMutation: null,
            lastVerification: null,
            taskState: {
              currentGoal: "Alpha goal",
              currentTask: "Alpha task",
              pending: ["Alpha pending"],
            },
            lastActivityAt: 1234,
          },
          ws_beta: {
            projectId: "alpha-app",
            workSessionId: "ws_beta",
            activeArtifact: "beta.html",
            recentFiles: [],
            lastCheckpointId: null,
            lastMutation: null,
            lastVerification: null,
            taskState: {
              currentGoal: "Beta goal",
              currentTask: "Beta task",
              pending: ["Beta pending"],
            },
            lastActivityAt: 2345,
          },
        },
      },
    });

    const session = await store.getSession();
    expect(session.version).toBe(5);
    expect(session.workSessions["alpha-app"]?.ws_alpha).toMatchObject({
      workSessionId: "ws_alpha",
      activeArtifact: "alpha.html",
      taskState: { currentGoal: "Alpha goal", currentTask: "Alpha task" },
    });
    expect(session.workSessions["alpha-app"]?.ws_beta).toMatchObject({
      workSessionId: "ws_beta",
      activeArtifact: "beta.html",
      taskState: { currentGoal: "Beta goal", currentTask: "Beta task" },
    });
  });

  it("serializes concurrent updateSession calls across Store instances sharing one stateDir", async () => {
    const secondStore = new Store(dir);
    await store.setSession({
      activeProjectId: null,
      mode: "observe",
      lease: null,
      workContexts: {},
    });

    await Promise.all([
      store.updateSession(async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { ...current, activeProjectId: "alpha-app" };
      }),
      secondStore.updateSession(async (current) => ({ ...current, mode: "edit" })),
    ]);

    const session = await store.getSession();
    expect(session.activeProjectId).toBe("alpha-app");
    expect(session.mode).toBe("edit");
  });

  it("keeps the session update queue usable after a mutator fails", async () => {
    await store.setSession({
      activeProjectId: null,
      mode: "observe",
      lease: null,
      workContexts: {},
    });

    await expect(
      store.updateSession(async () => {
        throw new Error("intentional update failure");
      }),
    ).rejects.toThrow("intentional update failure");

    await store.updateSession(async (current) => ({ ...current, activeProjectId: "recovered-project" }));
    const session = await store.getSession();
    expect(session.activeProjectId).toBe("recovered-project");
  });

  it("loads legacy v1 sessions that do not contain workContext", async () => {
    await fsWriteLegacySession(dir);
    const session = await store.getSession();
    expect(session.version).toBe(1);
    expect(session.activeProjectId).toBe("legacy-project");
    expect(session.workContext).toBeNull();
    expect(session.workContexts).toEqual({});
  });

  it("loads a persisted v2 single workContext through the per-project map", async () => {
    await fsWriteLegacyV2Session(dir);
    const session = await store.getSession();
    expect(session.version).toBe(2);
    expect(session.workContexts["legacy-v2"]?.activeArtifact).toBe("legacy.html");
    expect(session.workContexts["legacy-v2"]?.lastCheckpointId).toBe("cp_legacy");
  });

  it("stamps setSession's updatedAt with an integer epoch-ms value, ignoring caller input", async () => {
    await store.setSession({ updatedAt: 1 });
    const raw = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
    expect(Number.isInteger(raw.updatedAt)).toBe(true);
    expect(raw.updatedAt).toBeGreaterThan(1000);
  });
});

async function fsWriteLegacySession(dir: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, "sessions.json"),
    JSON.stringify({
      version: 1,
      updatedAt: 1,
      activeProjectId: "legacy-project",
      mode: "read",
      lease: null,
    }),
    "utf8",
  );
}

async function fsWriteLegacyV2Session(dir: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, "sessions.json"),
    JSON.stringify({
      version: 2,
      updatedAt: 2,
      activeProjectId: "legacy-v2",
      mode: "read",
      lease: null,
      workContext: {
        projectId: "legacy-v2",
        activeArtifact: "legacy.html",
        recentFiles: [],
        lastCheckpointId: "cp_legacy",
        lastActivityAt: 2,
      },
    }),
    "utf8",
  );
}
