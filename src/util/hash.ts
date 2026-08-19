import { createHash } from "node:crypto";

/** SHA-256 hex digest of a string or Buffer. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Per-line SHA-256 hashes for a block of text.
 *
 * Splits on `\n` (after normalizing `\r\n` -> `\n`) so callers get a stable
 * hash per logical line regardless of source EOL style. The hash is computed
 * over the line content without its trailing newline.
 */
export function lineHashes(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  return lines.map((line) => sha256Hex(line));
}

/** SHA-256 hash over an entire range/text blob, used as a precondition hash. */
export function rangeHash(text: string): string {
  return sha256Hex(text.replace(/\r\n/g, "\n"));
}
