import { describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import { CHATGPT_IMAGES_APP_URL, prepareChatGptImagesApp, type ExecFileLike } from "./chatgpt-images-app.js";

function captureExecCalls() {
  const calls: Array<{ file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const execFileImpl: ExecFileLike = async (file, args, options) => {
    calls.push({ file, args, env: options?.env });
    return { stdout: "", stderr: "" };
  };
  return { calls, execFileImpl };
}

describe("prepareChatGptImagesApp", () => {
  it("opens ChatGPT Images in Chrome without OS automation", async () => {
    const { calls, execFileImpl } = captureExecCalls();

    const result = await prepareChatGptImagesApp(
      { prompt: "make a clean SaaS banner", browser: "chrome" },
      { execFileImpl, sleepMs: async () => undefined },
    );

    expect(result).toMatchObject({
      openedUrl: CHATGPT_IMAGES_APP_URL,
      browser: "chrome",
      promptCopied: false,
      pasteAttempted: false,
      submitAttempted: false,
    });
    expect(calls[0]).toMatchObject({
      file: "/usr/bin/open",
      args: ["-a", "Google Chrome", CHATGPT_IMAGES_APP_URL],
    });
    expect(calls).toHaveLength(1);
  });

  it("requires explicit confirmation before submitting to ChatGPT", async () => {
    const { execFileImpl } = captureExecCalls();

    await expect(
      prepareChatGptImagesApp({ prompt: "send this", submitPrompt: true }, { execFileImpl, sleepMs: async () => undefined }),
    ).rejects.toMatchObject({ code: ErrorCode.APPROVAL_REQUIRED });
  });

  it("rejects paste automation", async () => {
    const { execFileImpl } = captureExecCalls();

    await expect(
      prepareChatGptImagesApp({ prompt: "paste", browser: "chrome", pastePrompt: true }, { execFileImpl }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_IMAGE_DATA });
  });
});
