import type { PathLike } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildMassUlwPlan } from "./mass-ulw.js";

const renameProbe = vi.hoisted(() => ({
  attempts: 0,
  remainingTransientFailures: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: PathLike, newPath: PathLike): Promise<void> => {
      renameProbe.attempts += 1;
      if (renameProbe.remainingTransientFailures > 0) {
        renameProbe.remainingTransientFailures -= 1;
        throw Object.assign(new Error("simulated Windows file replacement contention"), { code: "EPERM" });
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

const { MassUlwStore } = await import("./mass-ulw-store.js");
const roots: string[] = [];

afterEach(async () => {
  renameProbe.attempts = 0;
  renameProbe.remainingTransientFailures = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("retries a transient Windows state replacement without losing the durable document", async () => {
  // Given: a valid new MASS ULW state and one transient Windows replacement denial.
  const root = join(tmpdir(), `mass-ulw-store-rename-${process.pid}-${roots.length}`);
  await mkdir(root, { recursive: true });
  roots.push(root);
  const store = new MassUlwStore(root, { now: () => 1_700_000_000_000 });
  const plan = buildMassUlwPlan({
    executionProfile: "fast",
    candidates: [{
      id: "A",
      task: "Persist one lane",
      estimatedWeight: 1,
      writeScopes: ["src/a"],
    }],
  });
  renameProbe.remainingTransientFailures = 1;

  // When: the store atomically creates the state document.
  const created = await store.create("transient-replacement", plan);

  // Then: the same write succeeds on retry and leaves no temporary file behind.
  expect(await store.load("transient-replacement")).toEqual(created);
  expect(renameProbe.attempts).toBe(2);
  expect(await readdir(join(root, "orchestration", "mass-ulw"))).toEqual(["transient-replacement.json"]);
});
