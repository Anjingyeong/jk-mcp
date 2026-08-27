import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { MassUlwFingerprintEntry, MassUlwRepositoryFingerprint, PathImage } from "./mass-ulw-workspace-types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const GIT_ENV = { GIT_AUTHOR_NAME: "Mass ULW", GIT_AUTHOR_EMAIL: "mass-ulw@localhost", GIT_COMMITTER_NAME: "Mass ULW", GIT_COMMITTER_EMAIL: "mass-ulw@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } as const;

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return result.stdout;
}

export async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const result = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return result.stdout;
}

export function splitZ(value: string): string[] {
  const parts = value.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

export function safeRelative(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\")) throw new Error(`Unsafe Git path: ${value}`);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Unsafe Git path: ${value}`);
  }
  return normalized;
}

export function absoluteFromRelative(root: string, relative: string): string {
  const safe = safeRelative(relative);
  const absolute = path.resolve(root, ...safe.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error(`Path escapes workspace: ${relative}`);
  return absolute;
}

export async function readPathImage(root: string, relative: string): Promise<PathImage> {
  const absolute = absoluteFromRelative(root, relative);
  let stat: Stats;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, kind: "missing", mode: 0, bytes: Buffer.alloc(0) };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { exists: true, kind: "symlink", mode: stat.mode, bytes: Buffer.from(await fs.readlink(absolute)) };
  }
  if (!stat.isFile()) throw new Error(`Mass ULW only supports regular files: ${relative}`);
  return { exists: true, kind: "file", mode: stat.mode, bytes: await fs.readFile(absolute) };
}

export function imageDigest(image: PathImage): string {
  return createHash("sha256")
    .update(image.kind).update("\0")
    .update(String(image.mode & 0o777)).update("\0")
    .update(image.bytes)
    .digest("hex");
}

export async function requireRepositoryRoot(repositoryRoot: string): Promise<{ root: string; head: string }> {
  const root = await fs.realpath(path.resolve(repositoryRoot));
  let top: string;
  let head: string;
  try {
    [top, head] = await Promise.all([
      git(root, ["rev-parse", "--show-toplevel"]),
      git(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    ]);
  } catch (error) {
    throw new Error(`Mass ULW requires a local Git repository with HEAD: ${(error as Error).message}`);
  }
  const realTop = await fs.realpath(top.trim());
  if (path.resolve(realTop) !== path.resolve(root)) throw new Error("Mass ULW repositoryRoot must be the Git top-level directory");
  return { root, head: head.trim() };
}

/** Fingerprint local HEAD, the complete index representation, and tracked/nonignored-untracked worktree bytes and modes. */
export async function fingerprintMassUlwRepository(repositoryRoot: string): Promise<MassUlwRepositoryFingerprint> {
  const { root, head } = await requireRepositoryRoot(repositoryRoot);
  const [index, headPathsRaw, indexPathsRaw, untrackedRaw] = await Promise.all([
    git(root, ["ls-files", "--stage", "-z"]),
    git(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]),
    git(root, ["ls-files", "--cached", "-z"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const paths = [...new Set([...splitZ(headPathsRaw), ...splitZ(indexPathsRaw), ...splitZ(untrackedRaw)].map(safeRelative))].sort();
  const entries: MassUlwFingerprintEntry[] = [];
  const hash = createHash("sha256").update("mass-ulw-fingerprint-v1\0").update(head).update("\0").update(index);
  for (const relative of paths) {
    const image = await readPathImage(root, relative);
    const digest = imageDigest(image);
    entries.push({ path: relative, kind: image.kind, mode: image.mode & 0o777, digest });
    hash.update(relative).update("\0").update(image.kind).update("\0").update(String(image.mode & 0o777)).update("\0").update(digest);
  }
  return {
    digest: hash.digest("hex"),
    head,
    indexDigest: createHash("sha256").update(index).digest("hex"),
    index,
    entries,
  };
}

async function emptyWorktree(root: string): Promise<void> {
  for (const name of await fs.readdir(root)) {
    if (name === ".git") continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
}

async function copyImage(targetRoot: string, relative: string, image: PathImage): Promise<void> {
  if (!image.exists) return;
  const target = absoluteFromRelative(targetRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (image.kind === "symlink") {
    await fs.symlink(image.bytes.toString(), target);
  } else {
    await fs.writeFile(target, image.bytes, { mode: image.mode & 0o777 });
    await fs.chmod(target, image.mode & 0o777);
  }
}

export async function restoreOriginalCheckout(source: string, integration: string, fingerprint: MassUlwRepositoryFingerprint): Promise<void> {
  await emptyWorktree(integration);
  for (const entry of fingerprint.entries) await copyImage(integration, entry.path, await readPathImage(source, entry.path));

  // Reproduce staged state without changing the source index. Binary patches also transfer staged-only blobs.
  const cachedPatch = await gitBytes(source, ["diff", "--cached", "--binary", "--full-index", "HEAD"]);
  await git(integration, ["reset", "--mixed", fingerprint.head]);
  if (cachedPatch.length > 0) {
    const patchPath = path.join(path.dirname(integration), `cached-${randomUUID()}.patch`);
    try {
      await fs.writeFile(patchPath, cachedPatch, { mode: 0o600 });
      await git(integration, ["apply", "--cached", "--binary", patchPath]);
    } finally {
      await fs.rm(patchPath, { force: true });
    }
  }
  // Refresh only known-clean index paths. Refreshing the whole index stops at
  // the first genuinely dirty path on some Git versions, leaving later copied
  // files racily dirty despite equal blobs on coarse-timestamp filesystems.
  const dirty = new Set(splitZ(await git(source, ["diff", "--name-only", "-z"])).map(safeRelative));
  const clean = splitZ(await git(source, ["ls-files", "--cached", "-z"]))
    .map(safeRelative)
    .filter((relative) => !dirty.has(relative));
  for (let offset = 0; offset < clean.length; offset += 100) {
    await git(integration, ["update-index", "--refresh", "--", ...clean.slice(offset, offset + 100)]).catch(() => undefined);
  }
}

export async function createSnapshotCommit(integration: string, head: string, privateRoot: string): Promise<string> {
  const temporaryIndex = path.join(privateRoot, `snapshot-index-${randomUUID()}`);
  const env = { ...GIT_ENV, GIT_INDEX_FILE: temporaryIndex };
  try {
    await git(integration, ["read-tree", head], env);
    await git(integration, ["add", "-A"], env);
    const tree = (await git(integration, ["write-tree"], env)).trim();
    const commit = (await git(integration, ["commit-tree", tree, "-p", head, "-m", "mass-ulw baseline"], env)).trim();
    await git(integration, ["update-ref", "refs/heads/mass-ulw-baseline", commit]);
    return commit;
  } finally {
    await fs.rm(temporaryIndex, { force: true });
  }
}
