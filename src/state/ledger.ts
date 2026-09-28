import { mkdir, appendFile, chmod, readdir, rm, stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { renameWithRetry } from "../util/fs-retry.js";

/**
 * Append-only Evidence Ledger (PRD §15) persisted as
 * `~/.local/share/jk/audit.jsonl`. Every grant/tool-call/mutation/
 * exec event is appended, never rewritten.
 *
 * Format: one JSON object per line (JSONL). Each event gets a server-assigned
 * integer epoch-ms `ts` (never trusted from the caller) so ordering is
 * reconstructible even if concurrent writers interleave. Appends use the
 * `O_APPEND` file-open flag via `fs.appendFile`, which is atomic for writes
 * up to `PIPE_BUF`-ish sizes on POSIX and never truncates/rewrites existing
 * bytes — satisfying the "never rewrites" requirement.
 *
 * Size management: once `audit.jsonl` reaches `maxBytes` it is renamed
 * (whole-file, never edited) to `audit.<ts>.jsonl` and a fresh file is
 * started. Only the newest `keep` rotated files are retained. Rotation never
 * rewrites recorded bytes, so the append-only guarantee holds per file.
 *   JK_AUDIT_MAX_BYTES (default 20 MiB; 0 disables rotation)
 *   JK_AUDIT_KEEP      (default 5 rotated files)
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LEDGER_FILE = "audit.jsonl";
const ROTATED_RE = /^audit\.(\d{13})(?:-(\d+))?\.jsonl$/;
export const DEFAULT_AUDIT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_AUDIT_KEEP = 5;

export interface LedgerOptions {
  /** Rotate when the active file reaches this many bytes. 0 disables. */
  maxBytes?: number;
  /** Rotated files to keep (oldest pruned first). */
  keep?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export class Ledger {
  private readonly stateDir: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  /** mkdir/chmod/open run once per instance instead of on every tool call. */
  private ready: Promise<string> | undefined;
  /** Approximate size of the active file (re-checked with stat before rotating). */
  private size = 0;
  private rotating: Promise<void> | undefined;

  constructor(stateDir: string, options: LedgerOptions = {}) {
    this.stateDir = stateDir;
    this.maxBytes = options.maxBytes ?? envInt("JK_AUDIT_MAX_BYTES", DEFAULT_AUDIT_MAX_BYTES);
    this.keep = options.keep ?? envInt("JK_AUDIT_KEEP", DEFAULT_AUDIT_KEEP);
  }

  private ensureReady(): Promise<string> {
    this.ready ??= this.prepare().catch((error: unknown) => {
      this.ready = undefined; // retry preparation on the next append
      throw error;
    });
    return this.ready;
  }

  private async prepare(): Promise<string> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    try {
      await chmod(this.stateDir, DIR_MODE);
    } catch {
      // Non-fatal: filesystem may not support POSIX permission bits.
    }
    const target = join(this.stateDir, LEDGER_FILE);
    // Ensure the file exists with restrictive permissions before the first
    // append, without truncating it if it already has content.
    const fh = await open(target, "a", FILE_MODE);
    try {
      this.size = (await fh.stat()).size;
    } finally {
      await fh.close();
    }
    try {
      await chmod(target, FILE_MODE);
    } catch {
      // Non-fatal.
    }
    return target;
  }

  async append(event: { type: string; [k: string]: unknown }): Promise<void> {
    if (!event || typeof event.type !== "string" || event.type.length === 0) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        "Ledger.append requires a non-empty event.type",
      );
    }
    if (this.rotating) await this.rotating;
    const target = await this.ensureReady();
    const record = {
      ...event,
      ts: Date.now(),
    };
    const line = JSON.stringify(record) + "\n";
    try {
      await appendFile(target, line, { encoding: "utf8", mode: FILE_MODE });
    } catch (error) {
      // State dir may have been removed underneath us; re-prepare once.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.ready = undefined;
      await appendFile(await this.ensureReady(), line, { encoding: "utf8", mode: FILE_MODE });
    }
    this.size += Buffer.byteLength(line, "utf8");
    if (this.maxBytes > 0 && this.size >= this.maxBytes && !this.rotating) {
      this.rotating = this.rotate(target).finally(() => {
        this.rotating = undefined;
      });
      await this.rotating;
    }
  }

  /** Rename the active file aside and prune old rotations. Best-effort. */
  private async rotate(target: string): Promise<void> {
    try {
      // Another process may already have rotated; trust the real size.
      const actual = (await stat(target)).size;
      if (actual < this.maxBytes) {
        this.size = actual;
        return;
      }
      const stamp = String(Date.now());
      let rotated = join(this.stateDir, `audit.${stamp}.jsonl`);
      for (let n = 1; await exists(rotated); n += 1) rotated = join(this.stateDir, `audit.${stamp}-${n}.jsonl`);
      await renameWithRetry(target, rotated);
      this.size = 0;
      this.ready = undefined; // recreate the active file with FILE_MODE
      await this.prune();
    } catch {
      // Rotation must never break auditing; keep appending to the current file.
    }
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.stateDir))
      .map((name) => ({ name, m: ROTATED_RE.exec(name) }))
      .filter((entry): entry is { name: string; m: RegExpExecArray } => entry.m !== null)
      .sort((a, b) => a.m[1]!.localeCompare(b.m[1]!) || Number(a.m[2] ?? 0) - Number(b.m[2] ?? 0))
      .map((entry) => entry.name);
    const excess = names.length - this.keep;
    for (const name of names.slice(0, Math.max(0, excess))) {
      await rm(join(this.stateDir, name), { force: true });
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
