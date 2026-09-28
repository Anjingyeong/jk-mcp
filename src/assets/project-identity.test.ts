import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveImage, listImages, retrieveImage } from "./images.js";
import { intakeFromPath } from "./image-intake.js";
import { createCheckpoint, readCheckpoint, listCheckpoints, restoreCheckpoint } from "../state/checkpoints.js";
import { createE2eScreenshotShare, readE2eScreenshotShare } from "../e2e/screenshot-share.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const execFileAsync = promisify(execFile);
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "jk-project-identity-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("project identity compatibility", () => {
  it.each(["jk", "chatgpt2codex"])("retrieves %s image URIs only for their owning project", async (scheme) => {
    const directory = scheme === "jk" ? ".jk" : ".chatgpt2codex";
    const file = path.join(root, directory, "images", "old.png");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, PNG);
    const uri = `${scheme}://proj/images/old.png`;
    expect((await retrieveImage(root, uri, "proj")).data).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    await expect(retrieveImage(root, uri, "other-project")).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
  });

  it("writes new images and metadata under .jk while listing and retrieving old images unchanged", async () => {
    const legacy = path.join(".chatgpt2codex", "images", "old.png");
    await fs.mkdir(path.join(root, path.dirname(legacy)), { recursive: true });
    await fs.writeFile(path.join(root, legacy), PNG);
    const saved = await saveImage(root, "proj", PNG.toString("base64"), "new", { fixture: true });
    expect(saved.filePath.split(path.sep).slice(0, 2)).toEqual([".jk", "images"]);
    expect(saved.resourceUri).toMatch(/^jk:\/\/proj\/images\//);
    expect(await fs.readdir(path.join(root, ".jk", "image-metadata"))).toHaveLength(1);
    expect((await listImages(root)).map((image) => image.filePath)).toEqual(expect.arrayContaining([legacy, saved.filePath]));
    expect((await retrieveImage(root, legacy)).data).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(await fs.readFile(path.join(root, legacy))).toEqual(PNG);
  });

  it("defaults local image intake to .jk", async () => {
    const source = path.join(root, "source.png");
    await fs.writeFile(source, PNG);
    const saved = await intakeFromPath(root, "proj", source, "");
    expect(saved.filePath.split(path.sep).slice(0, 2)).toEqual([".jk", "images"]);
  });

  it.each([".jk", ".chatgpt2codex"])("authorizes screenshot shares in %s and preserves stored share targets", async (namespace) => {
    const file = path.join(root, namespace, "e2e", "screenshots", "proof.png");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, PNG);
    const state = path.join(root, "state");
    const share = await createE2eScreenshotShare(state, file, "https://example.test");
    expect((await readE2eScreenshotShare(state, share.token))?.path).toBe(await fs.realpath(file));
    expect(await fs.readFile(file)).toEqual(PNG);
  });

  it("writes new checkpoints to .jk and restores the same legacy diff without moving it", async () => {
    const git = (args: string[]) => execFileAsync("git", args, { cwd: root, windowsHide: true });
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "Identity Fixture"]);
    await git(["config", "user.email", "identity@example.invalid"]);
    await fs.writeFile(path.join(root, "file.txt"), "before\n");
    await git(["add", "file.txt"]);
    await git(["commit", "--quiet", "-m", "fixture"]);
    await fs.writeFile(path.join(root, "file.txt"), "after\n");
    const fresh = await createCheckpoint(root, "proj", "fixture");
    const legacy = { ...fresh, checkpointId: "cp_legacy", createdAt: 1 };
    const legacyPath = path.join(root, ".chatgpt2codex", "checkpoints", "cp_legacy.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    const bytes = JSON.stringify(legacy);
    await fs.writeFile(legacyPath, bytes);
    expect(await fs.readdir(path.join(root, ".jk", "checkpoints"))).toContain(`${fresh.checkpointId}.json`);
    expect((await listCheckpoints(root, "proj")).map((record) => record.checkpointId)).toEqual(expect.arrayContaining([fresh.checkpointId, "cp_legacy"]));
    expect(await readCheckpoint(root, "cp_legacy")).toEqual(legacy);
    expect((await restoreCheckpoint(root, "cp_legacy")).restored).toBe(true);
    expect((await fs.readFile(path.join(root, "file.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("before\n");
    expect(await fs.readFile(legacyPath, "utf8")).toBe(bytes);
  });
});
