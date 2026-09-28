import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TOOL_PROFILES, isToolListedForProfiles, resolveToolProfiles, toolProfileOf } from "./tool-profiles.js";
import { createServer } from "./mcp-server.js";
import type { ToolContext } from "../types.js";

function makeCtx(): ToolContext {
  const stateDir = "/tmp/jk-tool-profiles-test";
  return {
    workspaceRoot: "/tmp",
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

async function listNames(): Promise<{ listed: string[]; registered: string[] }> {
  const server = await createServer(makeCtx());
  const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  const handler = (
    server.server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<{ tools: Array<{ name: string }> }>>;
    }
  )._requestHandlers.get("tools/list");
  const result = await handler!({ method: "tools/list", params: {} });
  return { listed: result.tools.map((t) => t.name), registered };
}

describe("tool profiles", () => {
  // Default-surface tests describe the internal build; public tests override.
  beforeEach(() => {
    process.env.JK_DISTRIBUTION = "internal";
  });
  afterEach(() => {
    delete process.env.JK_TOOL_PROFILES;
    delete process.env.JK_DISTRIBUTION;
  });

  const IMPULSE_TOOLS = [
    "impulse_wake_queue",
    "impulse_director_decide",
    "impulse_director_policy",
    "impulse_semantic_review",
    "project_feedback_record",
  ];

  it("public distribution hides Impulse tools by default but keeps them registered", async () => {
    process.env.JK_DISTRIBUTION = "public";
    const { listed, registered } = await listNames();
    for (const tool of [...IMPULSE_TOOLS, "impulse_event_record", "impulse_scout_run"]) {
      expect(listed).not.toContain(tool);
      expect(registered).toContain(tool);
    }
    // Public surface keeps the shipped workflow tools.
    expect(listed).toEqual(expect.arrayContaining(["goal_loop", "goal_intake", "task_workspace", "mass_ulw_step"]));
  });

  it("public distribution lists Impulse tools again with JK_TOOL_PROFILES=+impulse", async () => {
    process.env.JK_DISTRIBUTION = "public";
    process.env.JK_TOOL_PROFILES = "+impulse";
    const { listed } = await listNames();
    expect(listed).toEqual(expect.arrayContaining(IMPULSE_TOOLS));
    expect(listed).not.toContain("impulse_scout_run");
  });

  it("resolves defaults, all, absolute and relative lists", () => {
    expect([...resolveToolProfiles(undefined)].sort()).toEqual([...DEFAULT_TOOL_PROFILES].sort());
    expect(resolveToolProfiles("all").has("legacy")).toBe(true);
    expect([...resolveToolProfiles("e2e")].sort()).toEqual(["core", "e2e"]);
    const relative = resolveToolProfiles("+legacy,-image");
    expect(relative.has("legacy")).toBe(true);
    expect(relative.has("image")).toBe(false);
    expect(relative.has("e2e")).toBe(true);
    expect(resolveToolProfiles("-core").has("core")).toBe(true);
    expect([...resolveToolProfiles("bogus")]).toEqual(["core"]);
  });

  it("treats unknown tools as core and control as gate-only", () => {
    expect(toolProfileOf("brand_new_tool")).toBe("core");
    expect(isToolListedForProfiles("brand_new_tool", new Set(["core"]))).toBe(true);
    expect(isToolListedForProfiles("computer_screenshot", new Set(["core"]))).toBe(true);
    expect(isToolListedForProfiles("git_status", new Set(["core"]))).toBe(false);
  });

  it("hides legacy aliases from tools/list by default but keeps them registered", async () => {
    const { listed, registered } = await listNames();
    expect(listed).not.toContain("git_status");
    expect(listed).not.toContain("git_diff_summary");
    expect(listed).not.toContain("seo_geo_audit");
    expect(listed).toContain("repo_status");
    expect(listed).toContain("goal_loop");
    expect(listed).toContain("runtime_upgrade");
    expect(listed).toContain("e2e_test_and_show_screenshot");
    expect(registered).toContain("git_status");
    expect(registered).toContain("git_diff_summary");
    expect(listed).not.toContain("impulse_event_record");
    expect(listed).not.toContain("impulse_scout_run");
    expect(listed).toEqual(expect.arrayContaining(["impulse_wake_queue", "impulse_director_decide", "impulse_director_policy"]));
    expect(registered).toEqual(expect.arrayContaining(["impulse_event_record", "impulse_scout_run"]));
  });

  it("JK_TOOL_PROFILES=+debug lists the Impulse Scout plumbing tools", async () => {
    expect(toolProfileOf("impulse_event_record")).toBe("debug");
    expect(DEFAULT_TOOL_PROFILES).not.toContain("debug");
    process.env.JK_TOOL_PROFILES = "+debug";
    const { listed } = await listNames();
    expect(listed).toEqual(expect.arrayContaining(["impulse_event_record", "impulse_scout_run", "impulse_wake_queue"]));
  });

  it("JK_TOOL_PROFILES=core shrinks the listed surface; all restores legacy", async () => {
    process.env.JK_TOOL_PROFILES = "core";
    const core = await listNames();
    expect(core.listed).not.toContain("e2e_screenshot");
    expect(core.listed).not.toContain("save_image_from_url");
    expect(core.listed).toContain("file_apply_patch");
    expect(core.registered).toContain("e2e_screenshot");

    process.env.JK_TOOL_PROFILES = "all";
    const all = await listNames();
    expect(all.listed).toContain("git_status");
    expect(all.listed.length).toBeGreaterThan(core.listed.length);
  });
});
