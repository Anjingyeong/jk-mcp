import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveImage } from "./images.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("image metadata", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-images-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stores metadata away from the visible image folder", async () => {
    const saved = await saveImage(root, "proj", PNG_1X1, "banner.png", { loop: true });

    await expect(fs.access(path.join(root, `${saved.filePath}.json`))).rejects.toThrow();
    const metadataFiles = await fs.readdir(path.join(root, ".chatgpt2codex", "image-metadata"));
    expect(metadataFiles).toHaveLength(1);
  });
});
