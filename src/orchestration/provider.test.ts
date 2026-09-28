import { describe, expect, it } from "vitest";
import { resolveOrchestrationProvider } from "./provider.js";

const optIn = { JK_ORCHESTRATION_PROVIDER: "openai-agents", OPENAI_API_KEY: "sk-test-key", JK_OPENAI_AGENTS_MODEL: "gpt-test" };

describe("resolveOrchestrationProvider", () => {
  it("defaults to the existing chatgpt-web provider when nothing is configured", () => {
    expect(resolveOrchestrationProvider({})).toEqual({ provider: "chatgpt-web", openaiAgents: null, disabledReason: null });
    expect(resolveOrchestrationProvider({ OPENAI_API_KEY: "sk-test-key", JK_OPENAI_AGENTS_MODEL: "gpt-test" }).provider).toBe("chatgpt-web");
    expect(resolveOrchestrationProvider({ JK_ORCHESTRATION_PROVIDER: "chatgpt-web" }).provider).toBe("chatgpt-web");
  });

  it("enables openai-agents only on explicit opt-in with a key and model", () => {
    expect(resolveOrchestrationProvider(optIn)).toEqual({
      provider: "openai-agents",
      disabledReason: null,
      openaiAgents: { apiKey: "sk-test-key", model: "gpt-test", baseUrl: "https://api.openai.com/v1", maxToolCalls: 30, timeoutMs: 600_000 },
    });
  });

  it.each([
    [{ ...optIn, OPENAI_API_KEY: "" }, "OPENAI_API_KEY"],
    [{ ...optIn, JK_OPENAI_AGENTS_MODEL: undefined }, "JK_OPENAI_AGENTS_MODEL is not set"],
    [{ ...optIn, JK_OPENAI_AGENTS_MODEL: "bad model;rm" }, "valid model"],
    [{ ...optIn, JK_OPENAI_AGENTS_BASE_URL: "http://api.example.com/v1" }, "BASE_URL"],
    [{ ...optIn, JK_OPENAI_AGENTS_BASE_URL: "https://user:pw@api.example.com" }, "BASE_URL"],
    [{ ...optIn, JK_OPENAI_AGENTS_MAX_TOOL_CALLS: "0" }, "MAX_TOOL_CALLS"],
    [{ ...optIn, JK_OPENAI_AGENTS_TIMEOUT_MS: "abc" }, "TIMEOUT_MS"],
    [{ ...optIn, JK_ORCHESTRATION_PROVIDER: "openai-agent" }, "Unknown"],
  ])("falls back to chatgpt-web without throwing for invalid config %#", (env, reason) => {
    const resolution = resolveOrchestrationProvider(env);
    expect(resolution.provider).toBe("chatgpt-web");
    expect(resolution.openaiAgents).toBeNull();
    expect(resolution.disabledReason).toContain(reason);
    expect(resolution.disabledReason).not.toContain("sk-test-key");
  });
});
