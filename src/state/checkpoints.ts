import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export interface CheckpointRecord {
  checkpointId: string;
  projectId: string;
  createdAt: number;
  reason: string;
  diff: string;
}

function checkpointDir(root: string, namespace = ".jk"): string {
  return path.join(root, namespace, "checkpoints");
}

function checkpointPath(root: string, checkpointId: string, namespace = ".jk"): string {
  if (!/^cp_[A-Za-z0-9_.-]+$/.test(checkpointId)) {
    throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Invalid checkpoint id", { checkpointId });
  }
  return path.join(checkpointDir(root, namespace), `${checkpointId}.json`);
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd: root, windowsHide: true, maxBuffer: MAX_DIFF_BYTES });
}

async function gitWithInput(root: string, args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd: root, windowsHide: true, maxBuffer: MAX_DIFF_BYTES },
      (error, stdout, stderr) => {
        const result = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
        if (error) {
          Object.assign(error, result);
          reject(error);
          return;
        }
        resolve(result);
      },
    );

    if (!child.stdin) {
      child.kill();
      reject(new Error("Failed to open stdin for git process"));
      return;
    }
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

export async function getWorkingDiff(root: string): Promise<string> {
  try {
    const result = await git(root, ["diff", "--binary"]);
    return redact(result.stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not a git repository") || msg.includes("not a git repository") || msg.includes("unknown revision") || msg.includes("ambiguous argument")) {
      return "";
    }
    throw err;
  }
}

const DEFAULT_CHECKPOINT_RETENTION = 200;
const LIST_LIMIT = 50;

/** Max checkpoint files kept per namespace dir. `JK_CHECKPOINT_RETENTION=0` disables pruning. */
export function checkpointRetention(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JK_CHECKPOINT_RETENTION;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHECKPOINT_RETENTION;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CHECKPOINT_RETENTION;
}

/**
 * Every patch/create writes a full working-tree diff, so without a bound the
 * directory grows without limit (hundreds of MB observed). Ids embed a
 * millisecond timestamp, so lexical order is creation order. Best-effort.
 */
export async function pruneCheckpoints(root: string, keep = checkpointRetention(), namespace = ".jk"): Promise<number> {
  if (keep <= 0) return 0;
  let names: string[];
  try {
    names = (await readdir(checkpointDir(root, namespace))).filter((n) => /^cp_.+\.json$/.test(n)).sort();
  } catch {
    return 0;
  }
  const excess = names.slice(0, Math.max(0, names.length - keep));
  await Promise.all(excess.map((name) => rm(path.join(checkpointDir(root, namespace), name), { force: true }).catch(() => undefined)));
  return excess.length;
}

export async function createCheckpoint(root: string, projectId: string, reason: string): Promise<CheckpointRecord> {
  await mkdir(checkpointDir(root), { recursive: true, mode: 0o700 });
  const checkpointId = `cp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const record: CheckpointRecord = {
    checkpointId,
    projectId,
    createdAt: Date.now(),
    reason,
    diff: await getWorkingDiff(root),
  };
  // Compact JSON: the diff dominates size and pretty-printing only adds bytes.
  await writeFile(checkpointPath(root, checkpointId), JSON.stringify(record), { mode: 0o600 });
  await pruneCheckpoints(root);
  return record;
}

export async function listCheckpoints(root: string, projectId: string): Promise<Omit<CheckpointRecord, "diff">[]> {
  const names = new Set<string>();
  for (const namespace of [".jk", ".chatgpt2codex"]) {
    try {
      for (const name of await readdir(checkpointDir(root, namespace))) names.add(name);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const out: Omit<CheckpointRecord, "diff">[] = [];
  // Filter by project before limiting, otherwise another project's recent
  // checkpoints sharing this root could hide all of this project's entries.
  for (const name of [...names].filter((n) => n.endsWith(".json")).sort().reverse()) {
    if (out.length >= LIST_LIMIT) break;
    try {
      const rec = await readCheckpoint(root, name.slice(0, -5));
      if (rec.projectId === projectId) {
        const { diff: _diff, ...meta } = rec;
        out.push(meta);
      }
    } catch { /* skip corrupt checkpoint */ }
  }
  return out;
}

export async function readCheckpoint(root: string, checkpointId: string): Promise<CheckpointRecord> {
  const canonical = checkpointPath(root, checkpointId);
  let raw: string;
  try {
    raw = await readFile(canonical, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try {
      raw = await readFile(checkpointPath(root, checkpointId, ".chatgpt2codex"), "utf8");
    } catch (legacyError) {
      if (!(legacyError instanceof Error && "code" in legacyError && legacyError.code === "ENOENT")) throw legacyError;
      throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Checkpoint not found", { checkpointId });
    }
  }
  try { return JSON.parse(raw) as CheckpointRecord; } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new DomainError(ErrorCode.CHECKPOINT_NOT_FOUND, "Checkpoint not found", { checkpointId });
  }
}

export async function restoreCheckpoint(root: string, checkpointId: string): Promise<{ checkpointId: string; restored: boolean; stdout: string; stderr: string }> {
  const rec = await readCheckpoint(root, checkpointId);
  if (!rec.diff.trim()) return { checkpointId, restored: false, stdout: "", stderr: "No diff stored in checkpoint." };
  const child = await gitWithInput(root, ["apply", "--reverse", "--whitespace=nowarn", "-"], rec.diff);
  return { checkpointId, restored: true, stdout: redact(String(child.stdout)), stderr: redact(String(child.stderr)) };
}
