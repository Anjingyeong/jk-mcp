import { mkdir, appendFile, chmod } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DomainError, ErrorCode } from "../types.js";

/**
 * Append-only Evidence Ledger (PRD §15) persisted as
 * `~/.local/share/chatgpt2codex/audit.jsonl`. Every grant/tool-call/mutation/
 * exec event is appended, never rewritten.
 *
 * Format: one JSON object per line (JSONL). Each event gets a server-assigned
 * integer epoch-ms `ts` (never trusted from the caller) so ordering is
 * reconstructible even if concurrent writers interleave. Appends use the
 * `O_APPEND` file-open flag via `fs.appendFile`, which is atomic for writes
 * up to `PIPE_BUF`-ish sizes on POSIX and never truncates/rewrites existing
 * bytes — satisfying the "never rewrites" requirement.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LEDGER_FILE = "audit.jsonl";

export class Ledger {
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  private async ensureReady(): Promise<string> {
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
    await fh.close();
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
    const target = await this.ensureReady();
    const record = {
      ...event,
      ts: Date.now(),
    };
    const line = JSON.stringify(record) + "\n";
    await appendFile(target, line, { encoding: "utf8", mode: FILE_MODE });
  }
}
