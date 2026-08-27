import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSecretPath } from "../policy/secrets.js";
import { normalizeFanoutScope } from "./mass-ulw.js";
import { git, safeRelative, splitZ } from "./mass-ulw-workspace-repository.js";
import type { JournalRecord, MassUlwWorkspaceLane, PathImage, TreeChange } from "./mass-ulw-workspace-types.js";

export function validateLanes(lanes: MassUlwWorkspaceLane[]): MassUlwWorkspaceLane[] {
  const ids = new Set<string>();
  return lanes.map((lane) => {
    const id = lane.id.trim();
    if (!id || !/^[A-Za-z0-9._-]+$/u.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate Mass ULW lane id: ${lane.id}`);
    ids.add(id);
    const writeScopes = [...new Set(lane.writeScopes.map(normalizeFanoutScope))].sort();
    return { id, writeScopes };
  });
}

async function treeMode(root: string, commit: string, relative: string): Promise<string | null> {
  const output = await git(root, ["ls-tree", commit, "--", relative]);
  if (!output) return null;
  return output.slice(0, 6);
}

export async function treeChanges(root: string, from: string, to: string): Promise<TreeChange[]> {
  const names = splitZ(await git(root, ["diff", "--name-only", "-z", "--no-renames", from, to])).map(safeRelative).sort();
  return Promise.all(names.map(async (relative) => ({
    path: relative,
    oldMode: await treeMode(root, from, relative),
    newMode: await treeMode(root, to, relative),
  })));
}

function scopeContains(scope: string, relative: string): boolean {
  const normalized = safeRelative(relative).toLowerCase();
  return normalized === scope || normalized.startsWith(`${scope}/`);
}

export function auditChanges(root: string, lane: MassUlwWorkspaceLane, changes: TreeChange[]): void {
  for (const change of changes) {
    if (!lane.writeScopes.some((scope) => scopeContains(scope, change.path))) {
      throw new Error(`Lane ${lane.id} changed out-of-scope path: ${change.path}`);
    }
    if (isSecretPath(path.resolve(root, ...change.path.split("/")))) {
      throw new Error(`Lane ${lane.id} changed secret-classified path: ${change.path}`);
    }
    if (change.oldMode === "120000" || change.newMode === "120000") {
      throw new Error(`Lane ${lane.id} changed symlink path: ${change.path}`);
    }
    if (change.oldMode === "160000" || change.newMode === "160000") {
      throw new Error(`Lane ${lane.id} changed submodule path: ${change.path}`);
    }
  }
}

export async function assertNoSymlinkParents(root: string, relative: string): Promise<void> {
  const segments = safeRelative(relative).split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Refusing to publish through symlink parent: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function writeJournal(journalPath: string, record: JournalRecord): Promise<void> {
  const temporary = `${journalPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, journalPath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export function imagesEqual(left: PathImage, right: PathImage): boolean {
  return left.kind === right.kind && (left.mode & 0o777) === (right.mode & 0o777) && left.bytes.equals(right.bytes);
}
