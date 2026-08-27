import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const MassUlwIdentityIndexSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  externalLoopId: z.string().min(1),
  executionId: z.string().regex(/^mass-[a-f0-9]{64}$/u),
}).strict();

export type MassUlwIdentityIndex = z.infer<typeof MassUlwIdentityIndexSchema>;
export type MassUlwIdentitySelector = Pick<MassUlwIdentityIndex, "projectId" | "externalLoopId">;

function indexRoot(stateDir: string): string {
  return path.join(stateDir, "orchestration", "mass-ulw-index");
}

function indexKey(selector: MassUlwIdentitySelector): string {
  return createHash("sha256")
    .update("mass-ulw-index-v1\0")
    .update(selector.projectId)
    .update("\0")
    .update(selector.externalLoopId)
    .digest("hex");
}

function indexPath(stateDir: string, selector: MassUlwIdentitySelector): string {
  return path.join(indexRoot(stateDir), `${indexKey(selector)}.json`);
}

export async function writeMassUlwIdentityIndex(
  stateDir: string,
  record: MassUlwIdentityIndex,
): Promise<void> {
  const validated = MassUlwIdentityIndexSchema.parse(record);
  const root = indexRoot(stateDir);
  await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(root, DIRECTORY_MODE);
  const target = indexPath(stateDir, validated);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await chmod(target, FILE_MODE);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function resolveMassUlwExecutionId(
  stateDir: string,
  selector: MassUlwIdentitySelector,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(indexPath(stateDir, selector), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = MassUlwIdentityIndexSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  if (parsed.data.projectId !== selector.projectId || parsed.data.externalLoopId !== selector.externalLoopId) {
    return null;
  }
  return parsed.data.executionId;
}

export async function removeMassUlwIdentityIndex(
  stateDir: string,
  selector: MassUlwIdentitySelector,
): Promise<void> {
  await rm(indexPath(stateDir, selector), { force: true });
}
