import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch, createFile } from "./patch.js";
import { ErrorCode } from "../types.js";
import { rangeHash } from "../util/hash.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-patch-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("applyPatch", () => {
  it("rejects an Add File patch whose path resolves to the project root itself (would otherwise write into the parent directory)", async () => {
    // Before the rejectRoot guard: rel="." resolves to realRoot unchanged,
    // so the commit loop's `dir = path.dirname(abs)` is the project's
    // PARENT directory, and a temp file gets written there (then the final
    // rename fails with EISDIR, but the temp file is never rolled back
    // because it was never pushed to `committed`) — a confinement escape
    // that leaks attacker content into the parent directory.
    for (const rootLikePath of [".", ""]) {
      const patch = ["*** Begin Patch", `*** Add File: ${rootLikePath || "."}`, "+pwned-into-parent-dir", "*** End Patch"].join("\n");
      await expect(applyPatch(root, patch)).rejects.toMatchObject({ code: ErrorCode.PATH_OUTSIDE_PROJECT });
    }

    // Confirm nothing was actually written into the project's parent
    // directory (the temp-file naming pattern the commit loop uses).
    const parentEntries = await fs.readdir(path.dirname(root));
    expect(parentEntries.some((name) => name.startsWith(".chatgpt2codex.tmp."))).toBe(false);
  });

  it("applies an Add File operation, creating the new file", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hello",
      "+world",
      "*** End Patch",
    ].join("\n");

    const result = await applyPatch(root, patch);

    expect(result.applied).toEqual([{ path: "new.txt", action: "add", added: 2, removed: 0 }]);
    const written = await fs.readFile(path.join(root, "new.txt"), "utf8");
    expect(written).toBe("hello\nworld");
  });

  it("applies an Update File operation with a context+add/remove hunk", async () => {
    await fs.writeFile(path.join(root, "existing.txt"), "line1\nline2\nline3\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      " line1",
      "-line2",
      "+line2-changed",
      " line3",
      "*** End Patch",
    ].join("\n");

    const result = await applyPatch(root, patch);

    expect(result.applied[0]).toMatchObject({ path: "existing.txt", action: "update" });
    const written = await fs.readFile(path.join(root, "existing.txt"), "utf8");
    expect(written).toBe("line1\nline2-changed\nline3\n");
  });

  it("applies add and update together transactionally in a single patch", async () => {
    await fs.writeFile(path.join(root, "existing.txt"), "a\nb\nc\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Add File: another.txt",
      "+created",
      "*** Update File: existing.txt",
      "@@",
      " a",
      "-b",
      "+b2",
      " c",
      "*** End Patch",
    ].join("\n");

    const result = await applyPatch(root, patch);

    expect(result.applied).toHaveLength(2);
    expect(await fs.readFile(path.join(root, "another.txt"), "utf8")).toBe("created");
    expect(await fs.readFile(path.join(root, "existing.txt"), "utf8")).toBe("a\nb2\nc\n");
  });

  it("rejects an update when the precondition hash does not match (stale content)", async () => {
    await fs.writeFile(path.join(root, "existing.txt"), "a\nb\nc\n", "utf8");
    const staleHash = rangeHash("a\nSTALE\nc\n"); // deliberately wrong

    const patch = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      " a",
      "-b",
      "+b2",
      " c",
      "*** End Patch",
    ].join("\n");

    await expect(
      applyPatch(root, patch, { "existing.txt": staleHash }),
    ).rejects.toMatchObject({ code: ErrorCode.HASH_MISMATCH });

    // File must be untouched after rejection.
    expect(await fs.readFile(path.join(root, "existing.txt"), "utf8")).toBe("a\nb\nc\n");
  });

  it("accepts an update when the precondition hash matches current content", async () => {
    const original = "a\nb\nc\n";
    await fs.writeFile(path.join(root, "existing.txt"), original, "utf8");
    const goodHash = rangeHash(original);

    const patch = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      " a",
      "-b",
      "+b2",
      " c",
      "*** End Patch",
    ].join("\n");

    const result = await applyPatch(root, patch, { "existing.txt": goodHash });
    expect(result.applied).toHaveLength(1);
  });

  it("rejects a patch that targets a path outside the project root", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: ../escape.txt",
      "+nope",
      "*** End Patch",
    ].join("\n");

    await expect(applyPatch(root, patch)).rejects.toMatchObject({
      code: ErrorCode.PATH_OUTSIDE_PROJECT,
    });
    await expect(fs.readFile(path.join(root, "..", "escape.txt"))).rejects.toBeTruthy();
  });

  it("rejects patches containing a null byte", async () => {
    const patch = "*** Begin Patch\n*** Add File: bad.txt\n+has\0null\n*** End Patch";

    await expect(applyPatch(root, patch)).rejects.toMatchObject({
      code: ErrorCode.NULLBYTE_REJECTED,
    });
  });

  it("applies a Delete File operation", async () => {
    await fs.writeFile(path.join(root, "gone.txt"), "bye", "utf8");

    const patch = ["*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch"].join("\n");

    const result = await applyPatch(root, patch);
    expect(result.applied).toEqual([{ path: "gone.txt", action: "delete", added: 0, removed: 0 }]);
    await expect(fs.readFile(path.join(root, "gone.txt"))).rejects.toBeTruthy();
  });
});

describe("createFile", () => {
  it("rejects a root-equivalent rel path with overwrite=true instead of writing into the parent directory", async () => {
    // With overwrite=false the pre-existing fileExists(realRoot)=true check
    // already blocks this (FILE_EXISTS), but overwrite=true skips that
    // check entirely and would otherwise resolve straight to realRoot.
    await expect(createFile(root, ".", "pwned-into-parent-dir", true)).rejects.toMatchObject({
      code: ErrorCode.PATH_OUTSIDE_PROJECT,
    });
    await expect(createFile(root, "", "pwned-into-parent-dir", true)).rejects.toMatchObject({
      code: ErrorCode.PATH_OUTSIDE_PROJECT,
    });
  });

  it("creates a new file and returns its byte size", async () => {
    const result = await createFile(root, "made.txt", "hello");
    expect(result.path).toBe("made.txt");
    expect(result.bytes).toBe(5);
    expect(await fs.readFile(path.join(root, "made.txt"), "utf8")).toBe("hello");
  });

  it("rejects overwriting an existing file by default", async () => {
    await fs.writeFile(path.join(root, "made.txt"), "original", "utf8");

    await expect(createFile(root, "made.txt", "new content")).rejects.toMatchObject({
      code: ErrorCode.FILE_EXISTS,
    });
    expect(await fs.readFile(path.join(root, "made.txt"), "utf8")).toBe("original");
  });

  it("allows overwriting when overwrite=true", async () => {
    await fs.writeFile(path.join(root, "made.txt"), "original", "utf8");

    const result = await createFile(root, "made.txt", "new content", true);
    expect(result.bytes).toBe("new content".length);
    expect(await fs.readFile(path.join(root, "made.txt"), "utf8")).toBe("new content");
  });

  it("rejects paths outside the project root", async () => {
    await expect(createFile(root, "../escape.txt", "nope")).rejects.toMatchObject({
      code: ErrorCode.PATH_OUTSIDE_PROJECT,
    });
  });
});
