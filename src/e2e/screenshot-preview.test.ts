import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createE2eScreenshotPreview } from "./local-e2e.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const describeDarwin = process.platform === "darwin" ? describe : describe.skip;

describeDarwin("E2E screenshot previews", () => {
  it("creates a JPEG preview next to the screenshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "c2c-preview-"));
    const shot = path.join(dir, "shot.png");
    await writeFile(shot, PNG_1X1);

    const preview = await createE2eScreenshotPreview(shot);

    expect(preview).not.toBeNull();
    expect(preview?.path).toBe(path.join(dir, "shot-preview.jpg"));
    expect(preview?.mimeType).toBe("image/jpeg");
    expect(preview?.bytes).toBeGreaterThan(0);

    const again = await createE2eScreenshotPreview(shot);
    expect(again?.path).toBe(preview?.path);
  });

  it("returns null for non-PNG inputs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "c2c-preview-"));
    const file = path.join(dir, "shot.jpg");
    await writeFile(file, PNG_1X1);

    expect(await createE2eScreenshotPreview(file)).toBeNull();
  });

  it("returns null when the source is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "c2c-preview-"));

    expect(await createE2eScreenshotPreview(path.join(dir, "missing.png"))).toBeNull();
  });
});
