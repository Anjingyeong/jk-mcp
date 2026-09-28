import { DomainError, ErrorCode, type ToolContext } from "../types.js";

/**
 * Option B (human-confirmed desktop control) policy primitives.
 *
 * Two independent gates must both be satisfied before any of the 4 control
 * tools can be reached at all:
 *  1. Feature flag `JK_CONTROL` (isControlEnabled) — enabled by
 *     default; set it to "0"/"false"/"off" (case-insensitive) to opt out.
 *  2. A `control` lease preset explicitly granted via project_select
 *     (enforced separately by src/workspace/lease-guard.ts).
 * Neither gate alone is sufficient. Gate 1 only controls whether the tools
 * are registered/reachable at all — even with it on, gate 2 (and the
 * ChatGPT tools/list hide + generic call-tool bridge block, which apply
 * unconditionally) still stand between ChatGPT and any control action.
 */

const CONTROL_ENV_FLAG = "CHATGPT2CODEX_CONTROL";
const CONTROL_ALLOWLIST_ENV_FLAG = "CHATGPT2CODEX_CONTROL_ALLOWLIST";
const CONTROL_CHATGPT_ENV_FLAG = "CHATGPT2CODEX_CONTROL_CHATGPT";

/** Names of the 4 desktop-control MCP tools. Shared denylist used by:
 *  - src/server/tools.ts installChatGptToolListHandler (hide from ChatGPT tools/list)
 *  - src/server/actions.ts callRegisteredTool (block the generic call-tool/action bridge) */
export const CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "computer_screenshot",
  "computer_request_action",
  "computer_action_status",
  "computer_kill_switch",
]);

/**
 * Whether the desktop-control feature surface is enabled at all.
 * Enabled by default (including when the env var is unset) so the control
 * tools and status-bar control menu work even when the app is launched via
 * `open` with no environment configured. Set JK_CONTROL to
 * "0"/"false"/"off" (case-insensitive) as an explicit opt-out safety valve.
 */
export function isControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.JK_CONTROL ?? env[CONTROL_ENV_FLAG];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

/**
 * Owner opt-in flag ("ChatGPT confirm" model): expose the 4 desktop-control
 * tools to ChatGPT's tools/list and the generic action bridge, and let a
 * confirmed `computer_request_action` call execute immediately through the
 * executor path (src/control/tools.ts handleComputerRequestAction) instead of
 * only ever queuing for local human approval. Disabled by default — this is
 * the public-product-safe default, identical to today's hide+block behavior
 * — until the owner explicitly sets JK_CONTROL_CHATGPT to
 * "1"/"true"/"on" (case-insensitive). Independent of `isControlEnabled`:
 * that flag controls whether the control surface exists at all (including
 * local-only use via stdio/status bar); this one only controls whether
 * ChatGPT specifically can see and call it.
 */
export function isControlChatGptExposed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.JK_CONTROL_CHATGPT ?? env[CONTROL_CHATGPT_ENV_FLAG];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

function controlChatGptExposureOverride(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const raw = env.JK_CONTROL_CHATGPT ?? env[CONTROL_CHATGPT_ENV_FLAG];
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

function parseControlSession(raw: unknown): {
  activeProjectId: string | null;
  lease: { projectId: string; preset: string; expiresAt: number } | null;
  controlAllowlist: string[];
} {
  if (!raw || typeof raw !== "object") return { activeProjectId: null, lease: null, controlAllowlist: [] };
  const session = raw as Record<string, unknown>;
  const activeProjectId = typeof session.activeProjectId === "string" ? session.activeProjectId : null;
  let lease: { projectId: string; preset: string; expiresAt: number } | null = null;
  if (session.lease && typeof session.lease === "object") {
    const value = session.lease as Record<string, unknown>;
    if (typeof value.projectId === "string" && typeof value.preset === "string" && typeof value.expiresAt === "number") {
      lease = { projectId: value.projectId, preset: value.preset, expiresAt: value.expiresAt };
    }
  }
  const controlAllowlist = Array.isArray(session.controlAllowlist)
    ? session.controlAllowlist
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  return { activeProjectId, lease, controlAllowlist };
}

export async function isControlChatGptExposedForContext(
  ctx: ToolContext,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<boolean> {
  const override = controlChatGptExposureOverride(env);
  if (override !== null) return override;
  const session = parseControlSession(await ctx.store.getSession());
  return session.lease?.preset === "control"
    && session.lease.projectId === session.activeProjectId
    && session.lease.expiresAt > now;
}

export async function controlAllowlistForContext(
  ctx: ToolContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (env.JK_CONTROL_ALLOWLIST !== undefined || env[CONTROL_ALLOWLIST_ENV_FLAG] !== undefined) {
    return controlAllowlist(env);
  }
  return parseControlSession(await ctx.store.getSession()).controlAllowlist;
}

/**
 * Case-insensitive substrings matched against app names/bundle-ish labels.
 * Any match blocks both synthetic input (click/type/key) and screenshot
 * capture, regardless of allowlist configuration.
 */
export const SENSITIVE_APP_DENYLIST: readonly string[] = [
  "1password",
  "bitwarden",
  "keepassxc",
  "passwords", // Apple Passwords.app
  "keychain access",
  "system settings",
  "system preferences",
  "authy",
  "google authenticator",
  "authenticator",
  "lastpass",
  "dashlane",
  "nordpass",
  "banking",
  "coinbase",
  "metamask",
  "crypto wallet",
];

export function isSensitiveApp(appName: string | undefined): boolean {
  if (!appName) return false;
  const norm = appName.trim().toLowerCase();
  return SENSITIVE_APP_DENYLIST.some((entry) => norm.includes(entry));
}

/** Explicit allowlist of app names control may target, configured via env
 * (comma-separated). Empty by default: no app is reachable until the
 * operator opts an app in, on top of the two gates above. */
export function controlAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.JK_CONTROL_ALLOWLIST ?? env[CONTROL_ALLOWLIST_ENV_FLAG];
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isAppAllowed(appName: string, allowlist: readonly string[]): boolean {
  const norm = appName.trim().toLowerCase();
  return allowlist.some((entry) => entry.trim().toLowerCase() === norm);
}

export interface AssertTargetInput {
  appName: string;
  frontmostAppName?: string;
  allowlist: readonly string[];
}

/**
 * Throws SENSITIVE_TARGET_BLOCKED unless the target app (and the frontmost
 * app, when known) is both absent from the sensitive denylist and present on
 * the explicit control allowlist. Called twice per action: once at
 * request-time (1st gate) and again immediately before execution using the
 * live frontmost app (2nd gate) — see src/control/tools.ts / executor.ts.
 */
export function assertAllowedTarget(input: AssertTargetInput): void {
  if (isSensitiveApp(input.appName)) {
    throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `Target app is blocked by the sensitive-app denylist: ${input.appName}`, {
      appName: input.appName,
    });
  }
  if (isSensitiveApp(input.frontmostAppName)) {
    throw new DomainError(
      ErrorCode.SENSITIVE_TARGET_BLOCKED,
      `Frontmost app is blocked by the sensitive-app denylist: ${input.frontmostAppName}`,
      { appName: input.frontmostAppName },
    );
  }
  if (!isAppAllowed(input.appName, input.allowlist)) {
    throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `App is not on the control allowlist: ${input.appName}`, {
      appName: input.appName,
    });
  }
}
