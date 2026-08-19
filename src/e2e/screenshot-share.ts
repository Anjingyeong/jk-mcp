import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

interface ScreenshotShareRecord {
  token: string;
  path: string;
  createdAt: number;
  expiresAt: number;
}

export interface ScreenshotShare {
  token: string;
  url: string;
  markdown: string;
  expiresAt: string;
}

export interface ScreenshotShareRead {
  path: string;
  bytes: number;
  expiresAt: number;
}

const SHARE_TTL_SEC = 10 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,96}$/;

function sharesDir(stateDir: string): string {
  return path.join(stateDir, "e2e-screenshot-shares");
}

function isScreenshotPath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  return normalized.includes("/.chatgpt2codex/e2e/screenshots/") && normalized.endsWith(".png");
}

export async function createE2eScreenshotShare(
  stateDir: string,
  screenshotPath: string,
  publicOrigin: string,
  ttlSec = SHARE_TTL_SEC,
): Promise<ScreenshotShare> {
  const realPath = await fs.realpath(screenshotPath);
  if (!isScreenshotPath(realPath)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Only E2E screenshot PNG files can be shared inline");
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new DomainError(ErrorCode.NOT_A_FILE, "E2E screenshot share target is not a file");
  }

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const record: ScreenshotShareRecord = {
    token,
    path: realPath,
    createdAt: now,
    expiresAt: now + Math.max(60, Math.min(ttlSec, SHARE_TTL_SEC)) * 1000,
  };
  const dir = sharesDir(stateDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${token}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const url = new URL(`/actions/e2e-screenshot-inline/${token}/${encodeURIComponent(path.basename(realPath))}`, publicOrigin).toString();
  return {
    token,
    url,
    markdown: `![E2E screenshot](${url})`,
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

export async function readE2eScreenshotShare(stateDir: string, token: string): Promise<ScreenshotShareRead | null> {
  if (!TOKEN_RE.test(token)) return null;
  const recordPath = path.join(sharesDir(stateDir), `${token}.json`);
  let record: ScreenshotShareRecord;
  try {
    record = JSON.parse(await fs.readFile(recordPath, "utf8")) as ScreenshotShareRecord;
  } catch {
    return null;
  }
  if (record.token !== token || Date.now() > record.expiresAt) {
    await fs.rm(recordPath, { force: true });
    return null;
  }
  const realPath = await fs.realpath(record.path).catch(() => "");
  if (!realPath || !isScreenshotPath(realPath)) return null;
  const stat = await fs.stat(realPath).catch(() => null);
  if (!stat?.isFile()) return null;
  return { path: realPath, bytes: stat.size, expiresAt: record.expiresAt };
}
