import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSlice } from "./read-slice.js";
import { ErrorCode } from "../types.js";
import { rangeHash, lineHashes } from "../util/hash.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-read-slice-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("readSlice", () => {
  it.each([
    { name: "partial CRLF", bytes: Buffer.from("one\r\ntwo\r\nthree\r\n"), start: 2, end: 2,
      content: "2\ttwo", range: "two", hashes: lineHashes("two"), eol: "crlf" },
    { name: "empty file", bytes: Buffer.alloc(0), start: 1, end: 1,
      content: "1\t", range: "", hashes: lineHashes(""), eol: "lf" },
    { name: "out-of-range CRLF", bytes: Buffer.from("one\r\n"), start: 9, end: 10,
      content: "", range: "", hashes: [], eol: "crlf" },
    { name: "empty reversed range", bytes: Buffer.from("one\ntwo"), start: 2, end: 1,
      content: "", range: "", hashes: lineHashes(""), eol: "lf" },
    { name: "non-UTF8 bytes", bytes: Buffer.from([0x61, 0xff, 0x0d, 0x0a]), start: 1, end: 1,
      content: "1\ta\ufffd", range: "a\ufffd", hashes: lineHashes("a\ufffd"), eol: "crlf" },
  ])("native-evolution R3 hashes the exact read buffer after a controlled edit: $name", async (fixture) => {
    const abs = path.join(await fs.realpath(root), "same-buffer.txt");
    const replacement = Buffer.from("replacement\nbytes\n");
    await fs.writeFile(abs, fixture.bytes);
    const originalReadFile = fs.readFile.bind(fs);
    let reads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const bytes = await originalReadFile(...args);
      if (args[0] === abs) {
        reads += 1;
        if (reads === 1) await fs.writeFile(abs, replacement);
      }
      return bytes;
    });

    const result = await readSlice(root, "same-buffer.txt", fixture.start, fixture.end);

    expect(result.content).toBe(fixture.content);
    expect(await originalReadFile(abs)).toEqual(replacement);
    expect(result).toHaveProperty("fullFileHash", createHash("sha256").update(fixture.bytes).digest("hex"));
    expect(result.fileHash).toBe(rangeHash(fixture.range));
    expect(result.lineHashes).toEqual(fixture.hashes);
    expect(result.eol).toBe(fixture.eol);
    expect(reads).toBe(1);
  });

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
