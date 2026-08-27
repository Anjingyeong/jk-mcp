import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { acquireExecutionLock } from "./mass-ulw-executor-lock.js";
import { acquireMassUlwLock } from "./mass-ulw-lock.js";
import { MassUlwStore } from "./mass-ulw-store.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
let rootSequence = 0;

async function temporaryLockPath(): Promise<string> {
  const root = join(tmpdir(), `mass-ulw-lock-${process.pid}-${rootSequence++}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  roots.push(root);
  return join(root, "loop.lock");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MASS ULW shared lock", () => {
  it("recovers an incomplete abandoned store lock record", async () => {
    // Given: a crash left the legacy final store lock path empty.
    const stateDir = dirname(await temporaryLockPath());
    const directory = join(stateDir, "orchestration", "mass-ulw");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "incomplete-store.lock"), "");
    const store = new MassUlwStore(stateDir, { now: () => 100 });

    // When: the store acquires that loop lock.
    const recovered = await store.acquireLock("incomplete-store");

    // Then: the abandoned record is reclaimed and remains releasable.
    await recovered.release();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("recovers an invalid abandoned executor lock record", async () => {
    // Given: a crash left an invalid legacy executor lock record.
    const stateDir = dirname(await temporaryLockPath());
    const directory = join(stateDir, "orchestration", "mass-ulw");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "incomplete-executor.executor.lock"), "{");

    // When: the executor acquires that loop lock.
    const recovered = await acquireExecutionLock(stateDir, "incomplete-executor", () => 100);

    // Then: the abandoned record is reclaimed and remains releasable.
    await recovered.release();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("recovers when a reclaimer crashes after publishing its complete claim", async () => {
    // Given: a stale owner and a child that crashes at the exact claimed event.
    const path = await temporaryLockPath();
    const exited = await execFileAsync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    await writeFile(path, JSON.stringify({
      version: 1,
      pid: Number(exited.stdout),
      token: "abandoned-owner",
      createdAt: 1,
    }));
    const moduleUrl = new URL("./mass-ulw-lock.ts", import.meta.url).href;
    const childScript = `
      import { acquireMassUlwLock } from ${JSON.stringify(moduleUrl)};
      await acquireMassUlwLock({
        path: ${JSON.stringify(path)},
        now: () => 2,
        lockedMessage: "locked",
        onReclamationClaimed: () => process.exit(0),
      });
    `;

    // When: the child exits while owning the reclamation claim.
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript]);

    // Then: the complete claim is visible and another process can resume it.
    expect((await readdir(dirname(path))).some((name) => name.includes(".reclaim"))).toBe(true);
    const recovered = await acquireMassUlwLock({
      path,
      now: () => 3,
      lockedMessage: "locked",
    });
    await recovered.release();
    await expect(readdir(dirname(path))).resolves.toEqual([]);
  });
});
