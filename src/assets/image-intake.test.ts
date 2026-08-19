import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import { intakeFromPath } from "./image-intake.js";

/**
 * intakeFromPath reads from anywhere on disk by design (that's its stated
 * purpose — importing a local image from outside the project), unconfined
 * by resolveInProject. There was previously no test coverage for this
 * module at all. These tests lock in: (1) the secret-classified-path
 * defense-in-depth guard, and (2) that the external source path is
 * surfaced on the result (so the tools.ts caller can — and now does — log
 * it to the audit ledger, letting an external read be distinguished from an
 * in-project copy).
 */

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let projectRoot: string;
let outsideDir: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-image-intake-project-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-image-intake-outside-"));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

describe("intakeFromPath", () => {
  it("copies a valid image from an arbitrary external path into the project and reports the source path", async () => {
    const sourcePath = path.join(outsideDir, "screenshot.png");
    await fs.writeFile(sourcePath, PNG_BYTES);

    const result = await intakeFromPath(projectRoot, "proj", sourcePath, path.join(".chatgpt2codex", "images", "in.png"));

    expect(result.source).toBe("path");
    // The external source path must be surfaced on the result so callers
    // (src/server/tools.ts save_image_from_path/save_chatgpt_image) can
    // record it in the audit ledger — distinguishing an external-disk read
    // from an in-project copy.
    expect(result.sourcePath).toBe(sourcePath);
    await expect(fs.readFile(path.join(projectRoot, ".chatgpt2codex", "images", "in.png"))).resolves.toEqual(PNG_BYTES);
  });

  it("refuses a secret-classified source path (defense in depth) instead of copying it into the project", async () => {
    const sourcePath = path.join(outsideDir, ".env");
    await fs.writeFile(sourcePath, "SECRET=1");

    await expect(
      intakeFromPath(projectRoot, "proj", sourcePath, path.join(".chatgpt2codex", "images", "in.png")),
    ).rejects.toMatchObject({ code: ErrorCode.SECRET_BLOCKED });
  });

  it("rejects a non-image file even outside any secret-path pattern (magic-byte validation)", async () => {
    const sourcePath = path.join(outsideDir, "notes.txt");
    await fs.writeFile(sourcePath, "just some text, not an image");

    await expect(
      intakeFromPath(projectRoot, "proj", sourcePath, path.join(".chatgpt2codex", "images", "in.png")),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects a source path that does not exist", async () => {
    const sourcePath = path.join(outsideDir, "does-not-exist.png");
    await expect(
      intakeFromPath(projectRoot, "proj", sourcePath, path.join(".chatgpt2codex", "images", "in.png")),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_A_FILE });
  });

  it("expands a leading ~ to the home directory", async () => {
    // Doesn't require a real file under $HOME: NOT_A_FILE for a
    // nonexistent expanded path still proves expansion happened (a raw,
    // unexpanded "~/..." would resolve relative to cwd instead and fail
    // identically, so we assert the error mentions the expanded absolute
    // form under the real home directory rather than a literal "~").
    const home = os.homedir();
    await expect(
      intakeFromPath(projectRoot, "proj", "~/chatgpt2codex-does-not-exist.png", path.join(".chatgpt2codex", "images", "in.png")),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_A_FILE, details: { path: path.join(home, "chatgpt2codex-does-not-exist.png") } });
  });
});
