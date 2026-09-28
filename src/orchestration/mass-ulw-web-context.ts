import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveInProject } from "../policy/paths.js";
import { isSecretPath, redact } from "../policy/secrets.js";
import { git, splitZ } from "./mass-ulw-workspace-repository.js";
import type { MassUlwLane } from "./mass-ulw.js";

/** Bounded, dependency-aware source slices for the next ChatGPT reasoning turn. */
export async function webLaneContext(input: { root: string; baseline: string; lane: MassUlwLane; paths?: string[]; startLine?: number }): Promise<Record<string, unknown>> {
  const all = splitZ(await git(input.root, ["ls-files", "-z"]));
  const scopes = [...input.lane.readScopes, ...input.lane.writeScopes];
  const candidates = all.filter((file) => scopes.some((scope) => file.toLowerCase() === scope || file.toLowerCase().startsWith(`${scope}/`)) && !isSecretPath(path.resolve(input.root, file)));
  const requested = input.paths ?? [...new Set(["AGENTS.md", "package.json", ...candidates])].slice(0, 8);
  const files: Record<string, unknown>[] = [];
  let remaining = 24000;
  for (const relative of requested.slice(0, 8)) {
    const absolute = await resolveInProject(input.root, relative, { allowSymlink: false });
    if (isSecretPath(absolute)) throw new Error("Secret-classified files cannot be included in MASS ULW context");
    const stat = await fs.stat(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) { files.push({ path: relative, exists: false }); continue; }
    if (!stat.isFile() || stat.size > 1024 * 1024) { files.push({ path: relative, omitted: "not a text file under 1 MiB" }); continue; }
    const bytes = await fs.readFile(absolute);
    if (bytes.includes(0)) { files.push({ path: relative, omitted: "binary" }); continue; }
    const lines = bytes.toString("utf8").split(/\r?\n/u);
    const start = input.startLine ?? 1;
    const slice = redact(lines.slice(start - 1, start + 119).join("\n"));
    const content = slice.slice(0, Math.min(4000, remaining)); remaining -= content.length;
    files.push({ path: relative, startLine: start, totalLines: lines.length, hash: createHash("sha256").update(bytes).digest("hex"), content, truncated: slice.length > content.length || lines.length > start + 119 });
    if (!remaining) break;
  }
  const diff = redact(await git(input.root, ["diff", "--no-ext-diff", "--no-textconv", input.baseline, "HEAD", "--"]));
  return { dataTrust: "untrusted-project-content", baselineCommit: input.baseline, files, candidatePaths: candidates.slice(0, 100), candidatePathsTruncated: candidates.length > 100, diff: diff.slice(0, 24000), diffTruncated: diff.length > 24000,
    readMore: "Call mass_ulw_step action=context with laneId, paths and startLine for more slices. Call project_rules for applicable hierarchical rules before patching." };
}
