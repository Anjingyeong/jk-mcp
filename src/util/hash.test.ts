import { describe, expect, it } from "vitest";
import { lineHashes, rangeHash, sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("hashes strings deterministically", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("hashes buffers the same as their string content", () => {
    expect(sha256Hex(Buffer.from("hello"))).toBe(sha256Hex("hello"));
  });
});

describe("lineHashes", () => {
  it("returns one hash per line", () => {
    const hashes = lineHashes("a\nb\nc");
    expect(hashes).toHaveLength(3);
    expect(hashes[0]).toBe(sha256Hex("a"));
    expect(hashes[1]).toBe(sha256Hex("b"));
    expect(hashes[2]).toBe(sha256Hex("c"));
  });

  it("normalizes CRLF before hashing", () => {
    expect(lineHashes("a\r\nb")).toEqual(lineHashes("a\nb"));
  });
});

describe("rangeHash", () => {
  it("is stable across CRLF/LF", () => {
    expect(rangeHash("a\r\nb\r\n")).toBe(rangeHash("a\nb\n"));
  });

  it("changes when content changes", () => {
    expect(rangeHash("a")).not.toBe(rangeHash("b"));
  });
});
