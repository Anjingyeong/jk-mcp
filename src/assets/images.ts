import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_DIR = path.join(".chatgpt2codex", "images");
const METADATA_DIR = path.join(".chatgpt2codex", "image-metadata");

export interface SavedImage {
  filePath: string;
  resourceUri: string;
  sha256: string;
  bytes: number;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

function decodeImage(input: string): { bytes: Buffer; mimeHint?: string } {
  const dataUrl = input.match(/^data:([^;,]+);base64,(.*)$/s);
  const raw = dataUrl ? dataUrl[2] ?? "" : input;
  const mimeHint = dataUrl ? dataUrl[1] : undefined;
  let bytes: Buffer;
  try { bytes = Buffer.from(raw.replace(/\s+/g, ""), "base64"); }
  catch { throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, "Image data is not valid base64"); }
  if (bytes.length === 0) throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, "Image data is empty");
  if (bytes.length > MAX_IMAGE_BYTES) throw new DomainError(ErrorCode.QUOTA_EXCEEDED, "Image exceeds 10MB limit", { bytes: bytes.length });
  return { bytes, mimeHint };
}

/**
 * Detect image type from magic bytes. Shared by images.ts (base64 save path)
 * and image-intake.ts (local-file intake path) so validation logic lives in
 * exactly one place.
 *
 * @throws {DomainError} UNSUPPORTED_MEDIA_TYPE if bytes don't match a known
 *   PNG/JPEG/WebP/GIF signature.
 */
export function detect(bytes: Buffer): { mime: SavedImage["mime"]; ext: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { mime: "image/png", ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return { mime: "image/gif", ext: "gif" };
  throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Only PNG, JPEG, WebP, and GIF images are supported");
}

function slugify(name?: string): string {
  const base = (name ?? "image").replace(/\.[A-Za-z0-9]+$/, "").toLowerCase().replace(/[^a-z0-9가-힣_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return base || "image";
}

/**
 * Write `bytes` to `destRel` inside `root`, applying content-hash dedup and
 * `-vN` versioning: if a file already exists at the destination with the
 * *same* sha256, no new file is written and the existing path is returned;
 * if it exists with a *different* sha256, the write is retried against
 * `<stem>-v2<ext>`, `<stem>-v3<ext>`, etc. until a free/matching slot is
 * found. Shared by images.ts and image-intake.ts so every write path gets
 * identical dedup/versioning semantics.
 *
 * @throws {DomainError} PATH_OUTSIDE_PROJECT via resolveInProject.
 */
export async function writeVersionedImage(
  root: string,
  destRel: string,
  bytes: Buffer,
  sha256: string,
): Promise<{ filePath: string; deduped: boolean }> {
  const parsed = path.parse(destRel);
  const dir = parsed.dir;
  const ext = parsed.ext;
  const stem = parsed.name;

  const absDir = await resolveInProject(root, dir || ".", { allowSymlink: false });
  await mkdir(absDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidateRel = attempt === 0 ? destRel : path.join(dir, `${stem}-v${attempt + 1}${ext}`);
    const absCandidate = await resolveInProject(root, candidateRel, { allowSymlink: false });
    const existing = await readFile(absCandidate).catch(() => null);
    if (existing === null) {
      await writeFile(absCandidate, bytes, { mode: 0o600 });
      return { filePath: candidateRel, deduped: false };
    }
    const existingSha = createHash("sha256").update(existing).digest("hex");
    if (existingSha === sha256) {
      return { filePath: candidateRel, deduped: true };
    }
    // Different content at this path — try the next version suffix.
  }
  throw new DomainError(ErrorCode.FILE_EXISTS, `Exhausted version suffixes for ${destRel}`, { destRel });
}

export async function writeImageMetadata(root: string, filePath: string, record: Record<string, unknown>): Promise<string> {
  const name = `${createHash("sha256").update(filePath).digest("hex").slice(0, 16)}.json`;
  const rel = path.join(METADATA_DIR, name);
  const absDir = await resolveInProject(root, METADATA_DIR, { allowSymlink: false });
  await mkdir(absDir, { recursive: true, mode: 0o700 });
  const abs = await resolveInProject(root, rel, { allowSymlink: false });
  await writeFile(abs, JSON.stringify({ filePath, ...record }, null, 2), { mode: 0o600 });
  return rel;
}

export async function saveImage(root: string, projectId: string, imageData: string, filename?: string, metadata?: Record<string, unknown>): Promise<SavedImage> {
  const { bytes, mimeHint } = decodeImage(imageData);
  const detected = detect(bytes);
  if (mimeHint && mimeHint !== detected.mime) {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Image MIME hint does not match magic bytes", { mimeHint, detected: detected.mime });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const relDir = IMAGE_DIR;
  const absDir = await resolveInProject(root, relDir, { allowSymlink: false });
  await mkdir(absDir, { recursive: true, mode: 0o700 });
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(filename)}-${sha256.slice(0, 8)}.${detected.ext}`;
  const rel = path.join(relDir, fileName);
  const abs = await resolveInProject(root, rel, { allowSymlink: false });
  await writeFile(abs, bytes, { mode: 0o600 });
  if (metadata) {
    await writeImageMetadata(root, rel, { projectId, sha256, mime: detected.mime, bytes: bytes.length, metadata, savedAt: Date.now() });
  }
  return { filePath: rel, resourceUri: `chatgpt2codex://${projectId}/images/${fileName}`, sha256, bytes: bytes.length, mime: detected.mime };
}

export async function listImages(root: string): Promise<Array<SavedImage & { modifiedAt: number }>> {
  const absDir = await resolveInProject(root, IMAGE_DIR, { allowSymlink: false });
  let names: string[] = [];
  try { names = await readdir(absDir); } catch { return []; }
  const out: Array<SavedImage & { modifiedAt: number }> = [];
  for (const name of names.filter((n) => /\.(png|jpg|jpeg|webp|gif)$/i.test(n)).sort().reverse()) {
    const rel = path.join(IMAGE_DIR, name);
    const abs = await resolveInProject(root, rel, { allowSymlink: false });
    const data = await readFile(abs);
    const st = await stat(abs);
    const det = detect(data);
    out.push({ filePath: rel, resourceUri: `file://${abs}`, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, mime: det.mime, modifiedAt: st.mtimeMs });
  }
  return out;
}

export async function retrieveImage(root: string, filePath: string): Promise<SavedImage & { data: string }> {
  if (!filePath.startsWith(`${IMAGE_DIR}${path.sep}`) && !filePath.startsWith(`${IMAGE_DIR}/`)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Images can only be retrieved from .chatgpt2codex/images", { filePath });
  }
  const abs = await resolveInProject(root, filePath, { allowSymlink: false });
  const data = await readFile(abs);
  if (data.length > MAX_IMAGE_BYTES) throw new DomainError(ErrorCode.FILE_TOO_LARGE, "Image exceeds return limit");
  const det = detect(data);
  const sha256 = createHash("sha256").update(data).digest("hex");
  return { filePath, resourceUri: `file://${abs}`, sha256, bytes: data.length, mime: det.mime, data: `data:${det.mime};base64,${data.toString("base64")}` };
}
