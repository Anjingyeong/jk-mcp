import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Error codes Windows returns when a rename target (or source) is briefly
 * held open by another handle: a concurrent reader, Defender/indexer, or a
 * sibling writer mid-replace. These are transient; POSIX never returns them
 * for a same-directory rename in practice.
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RenameRetryOptions {
  /** Total attempts including the first. Default 8 (~1.3s worst case). */
  attempts?: number;
  /** Base backoff in ms; grows linearly per attempt. Default 10ms. */
  baseDelayMs?: number;
}

/**
 * `fs.rename` that tolerates transient Windows sharing violations.
 * Non-transient errors (ENOENT, EXDEV, ...) are rethrown immediately.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 8);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 10);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_RENAME_CODES.has(code) || attempt >= attempts) throw error;
      await delay(baseDelayMs * attempt * attempt);
    }
  }
}
