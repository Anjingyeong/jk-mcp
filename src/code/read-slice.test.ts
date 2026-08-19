import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSlice } from "./read-slice.js";
import { ErrorCode } from "../types.js";
import { rangeHash, lineHashes } from "../util/hash.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-read-slice-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("readSlice", () => {
  it("returns line-numbered content with stable per-line and range hashes", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "line1\nline2\nline3\n", "utf8");

    const result = await readSlice(root, "a.txt", 1, 2);

    expect(result.path).toBe("a.txt");
    expect(result.start).toBe(1);
    expect(result.end).toBe(2);
    expect(result.content).toBe("1\tline1\n2\tline2");
    expect(result.eol).toBe("lf");
    expect(result.lineHashes).toEqual(lineHashes("line1\nline2"));
    expect(result.fileHash).toBe(rangeHash("line1\nline2"));
  });

  it("produces the same hashes for repeated reads of unchanged content (stability)", async () => {
    await fs.writeFile(path.join(root, "b.txt"), "alpha\nbeta\ngamma\ndelta\n", "utf8");

    const first = await readSlice(root, "b.txt", 2, 3);
    const second = await readSlice(root, "b.txt", 2, 3);

    expect(second.fileHash).toBe(first.fileHash);
    expect(second.lineHashes).toEqual(first.lineHashes);
  });

  it("detects CRLF line endings", async () => {
    await fs.writeFile(path.join(root, "c.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");

    const result = await readSlice(root, "c.txt");

    expect(result.eol).toBe("crlf");
  });

  it("defaults to the full file when start/end are omitted", async () => {
    await fs.writeFile(path.join(root, "d.txt"), "x\ny\nz", "utf8");

    const result = await readSlice(root, "d.txt");

    expect(result.start).toBe(1);
    expect(result.end).toBe(3);
    expect(result.content).toBe("1\tx\n2\ty\n3\tz");
  });

  it("rejects paths outside the project root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "nope", "utf8");
      await expect(readSlice(root, "../" + path.basename(outside) + "/secret.txt")).rejects.toMatchObject(
        { code: ErrorCode.PATH_OUTSIDE_PROJECT },
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects files larger than 10MB", async () => {
    const bigPath = path.join(root, "big.txt");
    const chunk = Buffer.alloc(1024 * 1024, "a");
    const handle = await fs.open(bigPath, "w");
    try {
      for (let i = 0; i < 11; i++) {
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }

    await expect(readSlice(root, "big.txt")).rejects.toMatchObject({
      code: ErrorCode.FILE_TOO_LARGE,
    });
  });

  it("rejects directories with NOT_A_FILE", async () => {
    await fs.mkdir(path.join(root, "adir"));

    await expect(readSlice(root, "adir")).rejects.toMatchObject({ code: ErrorCode.NOT_A_FILE });
  });
});
