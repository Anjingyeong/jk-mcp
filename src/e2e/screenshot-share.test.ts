import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createE2eScreenshotShare, readE2eScreenshotShare } from "./screenshot-share.js";

describe("E2E screenshot inline shares", () => {
  it("creates a short-lived public image URL for an E2E screenshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-e2e-share-"));
    const stateDir = path.join(root, "state");
    const screenshotDir = path.join(root, "project", ".chatgpt2codex", "e2e", "screenshots");
    const screenshotPath = path.join(screenshotDir, "screen.png");
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(screenshotPath, Buffer.from("png"));

    const share = await createE2eScreenshotShare(stateDir, screenshotPath, "https://example.test");
    const read = await readE2eScreenshotShare(stateDir, share.token);

    expect(share.url).toMatch(/^https:\/\/example\.test\/actions\/e2e-screenshot-inline\//);
    expect(share.markdown).toBe(`![E2E screenshot](${share.url})`);
    expect(read?.path).toBe(await realpath(screenshotPath));
    expect(read?.bytes).toBe(3);
  });
});
