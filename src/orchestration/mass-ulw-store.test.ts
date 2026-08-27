import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildMassUlwPlan, type MassUlwCandidate } from "./mass-ulw.js";
import { MassUlwStore } from "./mass-ulw-store.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
let rootSequence = 0;

async function temporaryStateDir(): Promise<string> {
  const root = join(tmpdir(), `mass-ulw-store-${process.pid}-${rootSequence++}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bounded<T>(event: Promise<T>): Promise<T> {
  const timeout = once(AbortSignal.timeout(5_000), "abort").then(() => {
    throw new Error("MASS ULW test event barrier timed out");
  });
  return Promise.race([event, timeout]);
}

const candidate = (id: string, extra: Partial<MassUlwCandidate> = {}): MassUlwCandidate => ({
  id,
  task: `Implement ${id}`,
  estimatedWeight: 2,
  writeScopes: [`src/${id.toLowerCase()}`],
  ...extra,
});

function plan() {
  return buildMassUlwPlan({
    executionProfile: "max",
    candidates: [candidate("A"), candidate("B", { dependsOn: ["A"] })],
  });
}

describe("MassUlwStore", () => {
  it("persists a validated v1 plan atomically with restrictive permissions", async () => {
    const stateDir = await temporaryStateDir();
    const store = new MassUlwStore(stateDir, { now: () => 1_700_000_000_000 });

    const created = await store.create("loop-one", plan());
    const filePath = join(stateDir, "orchestration", "mass-ulw", "loop-one.json");
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as unknown;

    expect(await store.load("loop-one")).toEqual(created);
    expect(persisted).toEqual(created);
    expect(created).toMatchObject({
      version: 1,
      loopId: "loop-one",
      currentWave: 0,
      fingerprints: { plan: plan().planFingerprint },
      integrationVerification: { status: "not-started" },
      publishJournal: [],
    });
    expect(created.waves.map((wave) => wave.laneIds)).toEqual([["A"], ["B"]]);
    expect(Object.keys(created.lanes)).toEqual(["A", "B"]);
    expect(created.attempts).toEqual([]);
    expect((await readdir(join(stateDir, "orchestration", "mass-ulw"))).sort()).toEqual(["loop-one.json"]);

    if (process.platform !== "win32") {
      expect((await stat(join(stateDir, "orchestration", "mass-ulw"))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }

    await writeFile(filePath, JSON.stringify({ ...created, version: 2 }), "utf8");
    await expect(store.load("loop-one")).rejects.toThrow(/failed validation/u);
  });

  it("serializes updates per loop across store instances without losing journal entries", async () => {
    const stateDir = await temporaryStateDir();
    const first = new MassUlwStore(stateDir, { now: () => 100 });
    const second = new MassUlwStore(stateDir, { now: () => 100 });
    await first.create("serialized", plan());

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? first : second).update("serialized", (document) => {
        document.publishJournal.push({
          id: `publish-${index}`,
          fingerprint: `fingerprint-${index}`,
          status: "published",
          attemptId: `attempt-${index}`,
          startedAt: 100 + index,
          completedAt: 200 + index,
        });
      })),
    );

    const loaded = await first.load("serialized");
    expect(loaded.publishJournal.map((entry) => entry.id).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `publish-${index}`).sort(),
    );
    expect((await readdir(join(stateDir, "orchestration", "mass-ulw"))).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("holds an exclusive wx lock and recovers a lock owned by a stale pid", async () => {
    const stateDir = await temporaryStateDir();
    const first = new MassUlwStore(stateDir, { now: () => 100 });
    const second = new MassUlwStore(stateDir, { now: () => 100 });
    await first.create("locked", plan());

    const held = await first.acquireLock("locked");
    await expect(second.acquireLock("locked")).rejects.toThrow(/already locked/u);
    await held.release();

    const lockPath = join(stateDir, "orchestration", "mass-ulw", "locked.lock");
    const exitedChild = await execFileAsync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const stalePid = Number(exitedChild.stdout);
    expect(stalePid).toBeGreaterThan(0);
    await writeFile(lockPath, JSON.stringify({ version: 1, pid: stalePid, token: "stale", createdAt: 1 }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(lockPath, 0o600);

    const recovered = await second.acquireLock("locked");
    await recovered.release();
    await expect(readdir(join(stateDir, "orchestration", "mass-ulw"))).resolves.toEqual(["locked.json"]);
  });

  it("does not let a delayed stale cleaner remove a new owner lock", async () => {
    const stateDir = await temporaryStateDir();
    const setup = new MassUlwStore(stateDir, { now: () => 100 });
    await setup.create("stale-race", plan());
    const lockPath = join(stateDir, "orchestration", "mass-ulw", "stale-race.lock");
    const exitedChild = await execFileAsync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: Number(exitedChild.stdout),
      token: "stale-race-token",
      createdAt: 1,
    }), { mode: 0o600 });

    let observed = 0;
    let releaseFirstObserved!: () => void;
    let releaseSecondObserved!: () => void;
    let releaseFirstAcquired!: () => void;
    const firstObserved = new Promise<void>((resolve) => { releaseFirstObserved = resolve; });
    const secondObserved = new Promise<void>((resolve) => { releaseSecondObserved = resolve; });
    const firstAcquired = new Promise<void>((resolve) => { releaseFirstAcquired = resolve; });
    const hook = async () => {
      observed += 1;
      if (observed === 1) {
        releaseFirstObserved();
        await bounded(secondObserved);
      } else {
        releaseSecondObserved();
        await bounded(firstAcquired);
      }
    };
    const first = new MassUlwStore(stateDir, { now: () => 100, onStaleLockObserved: hook });
    const second = new MassUlwStore(stateDir, { now: () => 100, onStaleLockObserved: hook });

    const firstPromise = first.acquireLock("stale-race").then((lock) => {
      releaseFirstAcquired();
      return lock;
    });
    await bounded(firstObserved);
    const secondPromise = second.acquireLock("stale-race");
    const settled = await Promise.allSettled([firstPromise, secondPromise]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of settled) if (result.status === "fulfilled") await result.value.release();
  });

  it("resumes completed work but marks interrupted work and final verification conservatively", async () => {
    const stateDir = await temporaryStateDir();
    const beforeRestart = new MassUlwStore(stateDir, { now: () => 500 });
    await beforeRestart.create("resume", plan());
    await beforeRestart.update("resume", (document) => {
      document.lanes.A!.status = "completed";
      document.lanes.A!.attempts = 1;
      document.lanes.A!.completedAt = 300;
      document.lanes.B!.status = "in-flight";
      document.lanes.B!.attempts = 1;
      document.waves[0]!.status = "completed";
      document.waves[0]!.completedAt = 300;
      document.waves[1]!.status = "in-flight";
      document.attempts.push(
        { id: "lane-a-1", kind: "lane", laneId: "A", status: "completed", startedAt: 100, completedAt: 300 },
        { id: "lane-b-1", kind: "lane", laneId: "B", status: "in-flight", startedAt: 400 },
      );
      document.integrationVerification = {
        status: "in-flight",
        attemptId: "verify-1",
        fingerprint: "tree-abc",
        startedAt: 450,
      };
      document.fingerprints.integration = "tree-abc";
    });

    const afterRestart = new MassUlwStore(stateDir, { now: () => 600 });
    const resumed = await afterRestart.resume("resume");

    expect(resumed.lanes.A).toMatchObject({ status: "completed", attempts: 1, completedAt: 300 });
    expect(resumed.waves[0]).toMatchObject({ status: "completed", completedAt: 300 });
    expect(resumed.lanes.B).toMatchObject({ status: "planned", attempts: 1 });
    expect(resumed.waves[1]).toMatchObject({ status: "planned" });
    expect(resumed.attempts.find((attempt) => attempt.id === "lane-b-1")).toMatchObject({
      status: "interrupted",
      completedAt: 600,
    });
    expect(resumed.currentWave).toBe(1);
    expect(resumed.integrationVerification).toEqual({
      status: "unknown-after-interruption",
      attemptId: "verify-1",
      fingerprint: "tree-abc",
      startedAt: 450,
      interruptedAt: 600,
    });
    expect(await afterRestart.claimIntegrationVerification("resume", "verify-2", "tree-abc")).toBe(false);
    expect(await afterRestart.load("resume")).toEqual(resumed);
  });

  it("claims final integration verification at most once under concurrency", async () => {
    const stateDir = await temporaryStateDir();
    const first = new MassUlwStore(stateDir, { now: () => 700 });
    const second = new MassUlwStore(stateDir, { now: () => 700 });
    await first.create("verification", plan());

    const claims = await Promise.all([
      first.claimIntegrationVerification("verification", "verification-a", "tree-final"),
      second.claimIntegrationVerification("verification", "verification-b", "tree-final"),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const persisted = await first.load("verification");
    expect(persisted.integrationVerification.status).toBe("in-flight");
    expect(persisted.attempts.filter((attempt) => attempt.kind === "integration-verification")).toHaveLength(1);
  });
});
