export const JK_APP_NAME = "jk";
export const JK_TOOL_NAMESPACE = "ChatGPT_To_Codex";

export const TOOL_AVAILABILITY_GATE = {
  namespace: JK_TOOL_NAMESPACE,
  app: JK_APP_NAME,
  rule: "Proceed with local coding only after a current-turn jk MCP tool or GPT Action returns ok=true.",
  noResultMeans:
    "No local project work happened. Stop and ask the user to select/reconnect jk or refresh the Custom GPT Action schema.",
  wrongSurfaceExamples: ["image_gen", "python_user_visible", "browser-only answer"],
} as const;

export function toolCallProof(tool: string, ok: boolean): Record<string, unknown> {
  return {
    namespace: JK_TOOL_NAMESPACE,
    app: JK_APP_NAME,
    tool,
    ok,
    currentTurnProof: true,
    requiredBeforeCoding: true,
    proceedOnlyIfOk: true,
    noToolResultMeansNoLocalWork: true,
    instruction: ok
      ? "This jk tool/action result is the proof that local-tool execution is available for this turn."
      : "Do not claim local coding happened. Fix the jk tool/action call before proceeding.",
  };
}

export function addToolCallProof<T extends Record<string, unknown>>(
  structured: T,
  tool: string,
  ok: boolean,
): T & { chatgpt2codexToolCall: Record<string, unknown> } {
  return {
    chatgpt2codexToolCall: toolCallProof(tool, ok),
    ...structured,
  };
}
