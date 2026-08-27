import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MassUlwWorkspaceLike, VerificationEngine } from "./mass-ulw-executor.js";
import type { MassUlwCandidate, MassUlwPlan } from "./mass-ulw.js";
export const lane = (id: string, extra: Partial<MassUlwCandidate> = {}): MassUlwCandidate => ({ id, task: `Implement ${id}`, estimatedWeight: 3, writeScopes: [`src/${id}`], ...extra });
const execFileAsync = promisify(execFile);
const executorRoots = new Set<string>();

export async function temporaryExecutorRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  executorRoots.add(root);
  return root;
}

export async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.stdout;
}

export async function makeExecutorRepository(): Promise<string> {
  const root = await temporaryExecutorRoot("mass-ulw-executor-repo-");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Executor Test"]);
  await git(root, ["config", "user.email", "executor@example.test"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await mkdir(join(root, "src", "a"), { recursive: true });
  await mkdir(join(root, "src", "b"), { recursive: true });
  await writeFile(join(root, ".gitattributes"), "* -text\n");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  return root;
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function eventOrFinished(event: Promise<void>, execution: Promise<unknown>): Promise<boolean> {
  return Promise.race([event.then(() => true), execution.then(() => false)]);
}

export function fakeWorkspace(plan: MassUlwPlan, events: string[], onCleanup: () => void): MassUlwWorkspaceLike {
  const laneIds = plan.lanes.map((item) => item.id).sort();
  const changedPaths = laneIds.map((id) => `src/${id.toLowerCase()}/output.txt`);
  return {
    privateRoot: join(tmpdir(), `fake-mass-ulw-${plan.planFingerprint}`),
    lanes: plan.lanes.map((item) => ({
      id: item.id,
      root: `checkout-${item.id}`,
      writeScopes: item.writeScopes,
      executionBaselineCommit: `baseline-${item.id}`,
      preparedAncestorIds: [],
    })),
    async integrate() {
      events.push("integrate");
      return {
        commit: `integration-${plan.planFingerprint}`,
        changedPaths,
        laneCommits: laneIds.map((id) => ({
          id,
          commit: `commit-${id}`,
          changedPaths: [`src/${id.toLowerCase()}/output.txt`],
        })),
      };
    },
    async publish() {
      events.push("publish");
      return { changedPaths, journalPath: "fake-journal.json", rolledBack: false };
    },
    async cleanup() {
      events.push("cleanup");
      onCleanup();
    },
  };
}

export function passVerification(events: string[]): VerificationEngine {
  return {
    async verifyLane(request) {
      events.push(`verify:${request.lane.id}`);
      return { passed: true, fingerprint: `verified-${request.lane.id}` };
    },
    async verifyIntegrated(request) {
      events.push(`verify-integrated:${request.invocationCount}`);
      return { passed: true, fingerprint: request.fingerprint };
    },
  };
}

/** Windows can hold a brief handle (git/AV) after a test finishes; retry
 * instead of failing the whole afterEach with EBUSY. */
type RemoveRoot = (root: string) => Promise<void>;

export async function rmResilient(root: string, attempts = 5, remove: RemoveRoot = (target) => rm(target, { recursive: true, force: true })): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await remove(root);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      lastError = error;
    }
  }
  throw new Error(`MASS ULW cleanup exhausted for ${root}`, { cause: lastError });
}

export async function cleanupExecutorRoots(): Promise<void> {
  await Promise.all([...executorRoots].map((root) => rmResilient(root)));
  executorRoots.clear();
}
