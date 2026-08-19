import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

/**
 * Resolve `rel` against project `root`, enforcing lease-style path
 * confinement (PRD §9.3): realpath the root, then walk each path component
 * with lstat to reject symlink escapes, rather than trusting a naive string
 * join. Full O_NOFOLLOW openat-based fd containment is a later-phase nicety
 * (see PRD §9.3 note); this stub is filled in by the policy-owning agent.
 *
 * @throws {DomainError} PATH_OUTSIDE_PROJECT if resolution would escape root.
 */
export async function resolveInProject(
  root: string,
  rel: string,
  opts?: { allowSymlink?: boolean; rejectRoot?: boolean },
): Promise<string> {
  const allowSymlink = opts?.allowSymlink ?? false;

  // Reject nullbytes up front — never let them reach fs syscalls.
  if (rel.includes("\0") || root.includes("\0")) {
    throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "path contains a null byte");
  }

  // Realpath the root first so we have a canonical, symlink-free base to
  // confine against (PRD §9.3: "realpath 확정된 root").
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "project root does not exist", {
      root,
    });
  }

  // Build the naive joined target and split into path components relative
  // to the root. path.normalize/resolve collapses ".." segments in the
  // string domain — this is a UX convenience only; the real security
  // boundary is the per-component lstat walk below.
  const joined = path.resolve(realRoot, rel);
  const relFromRoot = path.relative(realRoot, joined);

  // A relative path that escapes the root (starts with ".." or is
  // absolute-looking after relative()) is rejected immediately.
  if (relFromRoot === "") {
    // rel resolves to the root itself. Some callers (write/create paths)
    // must reject this explicitly: an unguarded write to `realRoot` (e.g.
    // rel === "" or ".") writes into the project's *parent* directory once
    // path.dirname(realRoot) is used as the write dir — see
    // src/code/patch.ts applyPatch/createFile. Read-style callers keep the
    // existing "." / "" === root behavior.
    if (opts?.rejectRoot) {
      throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "path must not resolve to the project root itself", {
        root: realRoot,
        rel,
      });
    }
    return realRoot;
  }
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "path escapes project root", {
      root: realRoot,
      rel,
    });
  }

  const components = relFromRoot.split(path.sep).filter((c) => c.length > 0);

  // Walk each path component from the realpath'd root, lstat'ing as we go.
  // Any symlink encountered along the way (other than the final leaf, when
  // explicitly allowed) is rejected — this defeats TOCTOU-style symlink
  // escapes where an intermediate directory component is swapped for a
  // symlink pointing outside the project.
  let current = realRoot;
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    if (comp === undefined) continue;
    const isLast = i === components.length - 1;
    const next = path.join(current, comp);

    let st;
    try {
      st = await fs.lstat(next);
    } catch {
      // Component doesn't exist yet (e.g. file_create target, or a patch
      // add). That's fine as long as we've validated everything up to
      // here — record and continue without following anything further.
      current = next;
      continue;
    }

    if (st.isSymbolicLink()) {
      if (isLast && allowSymlink) {
        // Caller explicitly opted in to following a leaf symlink (rare).
        // Still confine the symlink target within root.
        const target = await fs.realpath(next);
        assertInWorkspace(target, realRoot);
        current = target;
        continue;
      }
      throw new DomainError(
        ErrorCode.PATH_OUTSIDE_PROJECT,
        "path traverses a symlink; symlink escapes are not permitted",
        { root: realRoot, rel, component: comp },
      );
    }

    current = next;
  }

  // Final containment assertion: whatever we resolved to (existing or not)
  // must still be within realRoot. Use realpath on the longest existing
  // ancestor if the leaf itself doesn't exist.
  let finalCheck = current;
  try {
    finalCheck = await fs.realpath(current);
  } catch {
    // Leaf doesn't exist; verify the deepest existing ancestor is
    // contained instead.
    let ancestor = path.dirname(current);
    for (;;) {
      try {
        finalCheck = await fs.realpath(ancestor);
        break;
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          finalCheck = realRoot;
          break;
        }
        ancestor = parent;
      }
    }
  }

  const finalRel = path.relative(realRoot, finalCheck);
  if (finalRel.startsWith("..") || path.isAbsolute(finalRel)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "path escapes project root", {
      root: realRoot,
      rel,
    });
  }

  return current;
}

/**
 * Assert an already-resolved absolute path lies within workspaceRoot.
 *
 * @throws {DomainError} PATH_OUTSIDE_WORKSPACE if abs is outside workspaceRoot.
 */
export function assertInWorkspace(abs: string, workspaceRoot: string): void {
  if (abs.includes("\0") || workspaceRoot.includes("\0")) {
    throw new DomainError(ErrorCode.NULLBYTE_REJECTED, "path contains a null byte");
  }

  const normRoot = path.resolve(workspaceRoot);
  const normAbs = path.resolve(abs);
  const rel = path.relative(normRoot, normAbs);

  if (rel === "") return;

  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_WORKSPACE, "path escapes workspace root", {
      workspaceRoot: normRoot,
      abs: normAbs,
    });
  }
}
