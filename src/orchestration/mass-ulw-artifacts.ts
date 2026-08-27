import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { git, gitBytes } from "./mass-ulw-workspace-repository.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const ArtifactManifestSchema = z.object({
  version: z.literal(1),
  laneId: z.string().min(1).max(80),
  baselineTree: z.string().regex(/^[0-9a-f]{40,64}$/u),
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

type ArtifactRequest = {
  laneId: string;
  checkoutRoot: string;
  baselineCommit: string;
};

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(path: string, bytes: string | Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class MassUlwArtifactStore {
  readonly root: string;

  constructor(stateDir: string, loopId: string) {
    this.root = resolve(stateDir, "orchestration", "mass-ulw-artifacts", digest(loopId));
  }

  private paths(laneId: string): { manifest: string; patch: string } {
    const stem = digest(laneId);
    return {
      manifest: join(this.root, `${stem}.json`),
      patch: join(this.root, `${stem}.patch`),
    };
  }

  async save(request: ArtifactRequest): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
    const paths = this.paths(request.laneId);
    const baselineTree = (await git(request.checkoutRoot, ["rev-parse", `${request.baselineCommit}^{tree}`])).trim();
    const patch = await gitBytes(request.checkoutRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-renames",
      request.baselineCommit,
      "HEAD",
    ]);
    const manifest = ArtifactManifestSchema.parse({
      version: 1,
      laneId: request.laneId,
      baselineTree,
      patchSha256: digest(patch),
    });
    await atomicWrite(paths.patch, patch);
    await atomicWrite(paths.manifest, `${JSON.stringify(manifest)}\n`);
  }

  async restore(request: ArtifactRequest): Promise<void> {
    const paths = this.paths(request.laneId);
    const manifest = ArtifactManifestSchema.parse(JSON.parse(await readFile(paths.manifest, "utf8")));
    if (manifest.laneId !== request.laneId) {
      throw new Error(`MASS ULW artifact lane mismatch: expected ${request.laneId}`);
    }
    const baselineTree = (await git(request.checkoutRoot, ["rev-parse", "HEAD^{tree}"])).trim();
    if (manifest.baselineTree !== baselineTree) {
      throw new Error(`MASS ULW artifact baseline changed for lane ${request.laneId}`);
    }
    const patch = await readFile(paths.patch);
    if (digest(patch) !== manifest.patchSha256) {
      throw new Error(`MASS ULW artifact patch digest mismatch for lane ${request.laneId}`);
    }
    if (patch.length === 0) return;
    await git(request.checkoutRoot, ["apply", "--check", "--index", "--binary", paths.patch]);
    await git(request.checkoutRoot, ["apply", "--index", "--binary", paths.patch]);
    await git(request.checkoutRoot, ["commit", "--quiet", "-m", `mass-ulw restore ${request.laneId}`]);
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
