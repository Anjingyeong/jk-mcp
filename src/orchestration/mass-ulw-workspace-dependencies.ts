import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { git, gitBytes } from "./mass-ulw-workspace-repository.js";
import type { MassUlwLaneCheckout } from "./mass-ulw-workspace-types.js";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Mass ULW",
  GIT_AUTHOR_EMAIL: "mass-ulw@localhost",
  GIT_COMMITTER_NAME: "Mass ULW",
  GIT_COMMITTER_EMAIL: "mass-ulw@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
} as const;

export async function prepareMassUlwLaneDependencies(
  privateRoot: string,
  target: MassUlwLaneCheckout,
  ancestors: readonly MassUlwLaneCheckout[],
): Promise<void> {
  const ancestorIds = ancestors.map((ancestor) => ancestor.id);
  if (target.preparedAncestorIds.length > 0) {
    if (target.preparedAncestorIds.join("\0") === ancestorIds.join("\0")) return;
    throw new Error(`MASS ULW lane ${target.id} dependency inputs changed after preparation`);
  }
  for (const ancestor of ancestors) {
    const head = (await git(ancestor.root, ["rev-parse", "HEAD"])).trim();
    const patch = await gitBytes(ancestor.root, [
      "diff",
      "--binary",
      "--full-index",
      "--no-renames",
      ancestor.executionBaselineCommit,
      head,
    ]);
    if (patch.length === 0) continue;
    const patchPath = path.join(privateRoot, `dependency-${target.id}-${ancestor.id}-${randomUUID()}.patch`);
    await fs.writeFile(patchPath, patch, { mode: 0o600 });
    try {
      await git(target.root, ["apply", "--index", "--binary", patchPath]);
      await git(target.root, ["commit", "--quiet", "-m", `mass-ulw dependency ${ancestor.id}`], GIT_ENV);
    } finally {
      await fs.rm(patchPath, { force: true });
    }
  }
  target.executionBaselineCommit = (await git(target.root, ["rev-parse", "HEAD"])).trim();
  target.preparedAncestorIds = ancestorIds;
}
