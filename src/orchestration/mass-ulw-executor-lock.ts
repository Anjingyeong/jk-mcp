import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireMassUlwLock } from "./mass-ulw-lock.js";

const LOOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const DIRECTORY_MODE = 0o700;
type ExecutionLock = { release(): Promise<void> };

export async function acquireExecutionLock(
  stateDir: string,
  loopId: string,
  now: () => number,
): Promise<ExecutionLock> {
  if (!LOOP_ID_PATTERN.test(loopId)) throw new Error("Invalid MASS ULW loop id");
  const directory = join(stateDir, "orchestration", "mass-ulw");
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(directory, DIRECTORY_MODE);
  return acquireMassUlwLock({
    path: join(directory, `${loopId}.executor.lock`),
    now,
    lockedMessage: `MASS ULW execution is already locked: ${loopId}`,
  });
}
