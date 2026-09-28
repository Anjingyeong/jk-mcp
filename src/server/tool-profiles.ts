/**
 * Tool profiles control which registered tools are *listed* to MCP clients
 * (tools/list). Every tool stays registered and callable through the Actions
 * bridge / direct handlers, so hiding a profile never breaks existing callers;
 * it only shrinks the context a model pays for the tool catalog.
 *
 * Configure with JK_TOOL_PROFILES (comma-separated). Special values:
 *   - unset/empty  -> DEFAULT_TOOL_PROFILES
 *   - "all"        -> every profile (including legacy aliases)
 *   - "+name"      -> default profiles plus `name` (e.g. "+legacy,+web")
 *   - "-name"      -> default profiles minus `name` (e.g. "-image")
 * The `core` profile is always included. Control tools are classified as
 * `control` but are listed solely by their own opt-in gate
 * (CHATGPT2CODEX_CONTROL_CHATGPT / control lease), independent of profiles.
 * Tools not assigned to any profile are treated as `core` so a newly added
 * tool is never silently hidden. Public (jk-mcp) builds use
 * PUBLIC_DEFAULT_TOOL_PROFILES, which omits `impulse`.
 */

import { isPublicDistribution } from "../distribution.js";

export const TOOL_PROFILE_NAMES = ["core", "e2e", "image", "release", "control", "web", "impulse", "legacy", "debug"] as const;
export type ToolProfileName = (typeof TOOL_PROFILE_NAMES)[number];

const PROFILE_TOOLS: Record<Exclude<ToolProfileName, "core">, readonly string[]> = {
  e2e: [
    "e2e_test_and_show_screenshot",
    "e2e_start_server",
    "e2e_run_command",
    "e2e_screenshot",
    "e2e_open_url_screenshot",
    "e2e_open_target",
  ],
  image: [
    "gpt_image_2_workflow",
    "open_chatgpt_images_app",
    "save_chatgpt_image",
    "save_chatgpt_image_from_url",
    "save_image",
    "save_image_from_url",
    "save_image_from_download",
    "save_image_from_clipboard",
    "save_image_from_path",
    "list_images",
    "retrieve_image",
  ],
  release: ["git_sync_start", "git_sync_finish", "executor_restart"],
  control: ["computer_screenshot", "computer_request_action", "computer_action_status", "computer_kill_switch"],
  web: ["seo_geo_audit"],
  // Impulse Director / Semantic Scout surface. Listed by default in internal
  // builds; public (jk-mcp) builds hide it unless JK_TOOL_PROFILES=+impulse.
  impulse: [
    "impulse_wake_queue",
    "impulse_director_decide",
    "impulse_director_policy",
    "impulse_semantic_review",
    "project_feedback_record",
  ],
  // Legacy aliases superseded by repo_status / repo_diff_summary.
  legacy: ["git_status", "git_diff_summary"],
  // Low-level Impulse Scout plumbing. goal_intake/goal_loop record checkpoints and run the
  // Scout automatically; enable with JK_TOOL_PROFILES=+debug for manual events/benchmarks.
  debug: ["impulse_event_record", "impulse_scout_run"],
};

export const DEFAULT_TOOL_PROFILES: readonly ToolProfileName[] = ["core", "e2e", "image", "release", "control", "impulse"];
/** Defaults for public (jk-mcp) builds: Impulse is opt-in via +impulse. */
export const PUBLIC_DEFAULT_TOOL_PROFILES: readonly ToolProfileName[] = DEFAULT_TOOL_PROFILES.filter(
  (profile) => profile !== "impulse",
);

export function defaultToolProfiles(env: NodeJS.ProcessEnv = process.env): readonly ToolProfileName[] {
  return isPublicDistribution(env) ? PUBLIC_DEFAULT_TOOL_PROFILES : DEFAULT_TOOL_PROFILES;
}

const TOOL_TO_PROFILE = new Map<string, ToolProfileName>();
for (const [profile, tools] of Object.entries(PROFILE_TOOLS) as Array<[ToolProfileName, readonly string[]]>) {
  for (const tool of tools) TOOL_TO_PROFILE.set(tool, profile);
}

export function toolProfileOf(toolName: string): ToolProfileName {
  return TOOL_TO_PROFILE.get(toolName) ?? "core";
}

function isProfileName(value: string): value is ToolProfileName {
  return (TOOL_PROFILE_NAMES as readonly string[]).includes(value);
}

export function resolveToolProfiles(raw: string | undefined = process.env.JK_TOOL_PROFILES): Set<ToolProfileName> {
  const defaults = defaultToolProfiles();
  const tokens = (raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return new Set(defaults);
  if (tokens.includes("all")) return new Set(TOOL_PROFILE_NAMES);
  const relative = tokens.every((t) => t.startsWith("+") || t.startsWith("-"));
  const result = new Set<ToolProfileName>(relative ? defaults : ["core"]);
  for (const token of tokens) {
    const op = token[0] === "-" ? "-" : "+";
    const name = token.replace(/^[+-]/, "");
    if (!isProfileName(name)) continue;
    if (op === "-") result.delete(name);
    else result.add(name);
  }
  result.add("core");
  return result;
}

export function isToolListedForProfiles(toolName: string, profiles: Set<ToolProfileName>): boolean {
  const profile = toolProfileOf(toolName);
  // Control tools are governed solely by their dedicated exposure gate.
  if (profile === "control") return true;
  return profiles.has(profile);
}
