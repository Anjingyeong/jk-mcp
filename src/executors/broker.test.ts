import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRegistryEntry } from "../types.js";
import {
  EXECUTOR_HEARTBEAT_TTL_MS,
  completeExecutorJob,
  dispatchExecutorJob,
  getExecutorProjectRegistry,
  listExecutorStatus,
  pollExecutorJob,
  recordExecutorHeartbeat,
  resolveRoutedLocalProject,
  setProjectExecutorRoute,
} from "./broker.js";

describe("executor broker", () => {
  let stateDir: string;
  const localProject: ProjectRegistryEntry = {
    projectId: "clean-app",
    name: "clean-app",
    root: "/opt/jk/workspace/clean-app",
    aliases: ["clean-app"],
  };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "jk-executors-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(stateDir, { recursive: true, force: true });
  });

  async function heartbeat(projectId = "clean-app"): Promise<void> {
    await recordExecutorHeartbeat(stateDir, {
      executorId: "windows-main",
      label: "Windows PC",
      platform: "win32/x64",
      workspaceRoot: "C:\\shakw",
      capabilities: ["code_search", "file_read_slice"],
      projects: [{
        projectId,
        name: projectId,
        root: `C:\\shakw\\${projectId}`,
        aliases: [projectId],
      }],
    });
  }

  it("exposes colliding remote projects with an executor-qualified id", async () => {
    await heartbeat();
    const remote = await getExecutorProjectRegistry(stateDir, [localProject]);

    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({
      projectId: "windows-main::clean-app",
      sourceProjectId: "clean-app",
      executorId: "windows-main",
      executorKind: "remote",
      executorOnline: true,
    });
  });

  it("routes a canonical project to Windows while online and falls back locally when stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T08:00:00Z"));
    await heartbeat();
    await setProjectExecutorRoute(stateDir, "clean-app", "windows-main");

    const routed = await resolveRoutedLocalProject(stateDir, localProject);
    expect(routed.executorId).toBe("windows-main");
    expect(routed.root).toBe("C:\\shakw\\clean-app");

    vi.setSystemTime(Date.now() + EXECUTOR_HEARTBEAT_TTL_MS + 1);
    const stale = await listExecutorStatus(stateDir);
    expect(stale[0]?.online).toBe(false);

    const fallback = await resolveRoutedLocalProject(stateDir, localProject);
    expect(fallback).toEqual(localProject);
  });

  it("treats a remote package-name alias as the same logical local project", async () => {
    const songsong: ProjectRegistryEntry = {
      projectId: "songsong",
      name: "songsong",
      root: "/opt/jk/workspace/songsong",
      aliases: ["songsong"],
    };
    await recordExecutorHeartbeat(stateDir, {
      executorId: "windows-main",
      label: "Windows PC",
      platform: "win32/x64",
      workspaceRoot: "C:\\shakw",
      capabilities: ["code_search"],
      projects: [{
        projectId: "shakw",
        name: "shakw",
        root: "C:\\shakw",
        aliases: ["shakw", "songsong"],
      }],
    });

    const registry = await getExecutorProjectRegistry(stateDir, [songsong]);
    expect(registry[0]?.projectId).toBe("windows-main::shakw");

    await setProjectExecutorRoute(stateDir, "songsong", "windows-main");
    const routed = await resolveRoutedLocalProject(stateDir, songsong);
    expect(routed.executorId).toBe("windows-main");
    expect(routed.sourceProjectId).toBe("shakw");
  });

  it("dispatches a job to a polling worker and resolves its result", async () => {
    await heartbeat();
    const resultPromise = dispatchExecutorJob<{ matches: string[] }>(
      stateDir,
      "windows-main",
      "code_search",
      { sourceProjectId: "clean-app", query: "seek" },
      5_000,
    );

    const job = await pollExecutorJob("windows-main", 1_000);
    expect(job).toMatchObject({
      executorId: "windows-main",
      tool: "code_search",
      payload: { sourceProjectId: "clean-app", query: "seek" },
    });
    expect(completeExecutorJob(job!.jobId, { matches: ["player.ts"] })).toBe(true);

    await expect(resultPromise).resolves.toEqual({ matches: ["player.ts"] });
  });

  it("does not expose stale worker projects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T08:00:00Z"));
    await heartbeat("windows-only");
    vi.setSystemTime(Date.now() + EXECUTOR_HEARTBEAT_TTL_MS + 1);

    await expect(getExecutorProjectRegistry(stateDir, [])).resolves.toEqual([]);
  });
});
