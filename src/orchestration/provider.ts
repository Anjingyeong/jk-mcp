/**
 * Orchestration provider selection.
 *
 * `chatgpt-web` is JK's existing and default orchestration surface: ChatGPT
 * (web / MCP / Actions) reasons, JK executes through goal_intake, goal_loop,
 * mass_ulw_step and the rest of the tool catalog. Nothing in that path reads
 * this module.
 *
 * `openai-agents` is an opt-in EXPERIMENTAL provider used only by the
 * explicit experiment entry point (src/experimental/openai-agents/cli.ts).
 * It is never selected implicitly, and a missing key or invalid setting only
 * disables it; it never throws into JK startup.
 */

export type OrchestrationProvider = "chatgpt-web" | "openai-agents";

export const DEFAULT_ORCHESTRATION_PROVIDER: OrchestrationProvider = "chatgpt-web";

export const OPENAI_AGENTS_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIAgentsConfig {
  /** Secret. Never log, persist, or include in telemetry. */
  apiKey: string;
  model: string;
  baseUrl: string;
  maxToolCalls: number;
  timeoutMs: number;
}

export type ProviderResolution =
  | { provider: "chatgpt-web"; openaiAgents: null; disabledReason: string | null }
  | { provider: "openai-agents"; openaiAgents: OpenAIAgentsConfig; disabledReason: null };

type Env = Record<string, string | undefined>;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

function positiveInt(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

function validBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim() || OPENAI_AGENTS_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password) return null;
  return value.replace(/\/+$/u, "");
}

function disabled(reason: string | null): ProviderResolution {
  return { provider: "chatgpt-web", openaiAgents: null, disabledReason: reason };
}

/**
 * Resolve the orchestration provider from environment variables.
 *
 * - JK_ORCHESTRATION_PROVIDER: `chatgpt-web` (default) | `openai-agents`
 * - OPENAI_API_KEY: required for `openai-agents`
 * - JK_OPENAI_AGENTS_MODEL: required for `openai-agents` (explicit so benchmark runs record a deliberate model)
 * - JK_OPENAI_AGENTS_BASE_URL: optional, https (or loopback http) only
 * - JK_OPENAI_AGENTS_MAX_TOOL_CALLS: optional, default 30, max 200
 * - JK_OPENAI_AGENTS_TIMEOUT_MS: optional, default 600000, max 3600000
 *
 * Never throws. Invalid or incomplete opt-in falls back to `chatgpt-web`
 * with a non-secret `disabledReason`.
 */
export function resolveOrchestrationProvider(env: Env = process.env): ProviderResolution {
  const requested = env.JK_ORCHESTRATION_PROVIDER?.trim().toLowerCase() ?? "";
  if (requested === "" || requested === DEFAULT_ORCHESTRATION_PROVIDER) return disabled(null);
  if (requested !== "openai-agents") return disabled(`Unknown JK_ORCHESTRATION_PROVIDER; using ${DEFAULT_ORCHESTRATION_PROVIDER}`);

  const apiKey = env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) return disabled("openai-agents requested but OPENAI_API_KEY is not set");
  const model = env.JK_OPENAI_AGENTS_MODEL?.trim() ?? "";
  if (!model) return disabled("openai-agents requested but JK_OPENAI_AGENTS_MODEL is not set");
  if (!MODEL_RE.test(model)) return disabled("JK_OPENAI_AGENTS_MODEL is not a valid model identifier");
  const baseUrl = validBaseUrl(env.JK_OPENAI_AGENTS_BASE_URL);
  if (!baseUrl) return disabled("JK_OPENAI_AGENTS_BASE_URL must be an https URL (or loopback http) without credentials");
  const maxToolCalls = positiveInt(env.JK_OPENAI_AGENTS_MAX_TOOL_CALLS, 30, 200);
  if (maxToolCalls === null) return disabled("JK_OPENAI_AGENTS_MAX_TOOL_CALLS must be an integer between 1 and 200");
  const timeoutMs = positiveInt(env.JK_OPENAI_AGENTS_TIMEOUT_MS, 600_000, 3_600_000);
  if (timeoutMs === null) return disabled("JK_OPENAI_AGENTS_TIMEOUT_MS must be an integer between 1 and 3600000");

  return { provider: "openai-agents", openaiAgents: { apiKey, model, baseUrl, maxToolCalls, timeoutMs }, disabledReason: null };
}
