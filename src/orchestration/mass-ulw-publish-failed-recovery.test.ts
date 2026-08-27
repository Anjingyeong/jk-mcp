import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor } from "./mass-ulw-executor.js";
import {
  cleanupExecutorRoots,
  git,
  lane,
  makeExecutorRepository,
  temporaryExecutorRoot,
} from "./mass-ulw-runner-fixtures.js";
import { massUlwPublishFingerprint, publicationTransactionRoot } from "./mass-ulw-publish-recovery.js";
import { MassUlwStore } from "./mass-ulw-store.js";
import { createMassUlwWorkspace } from "./mass-ulw-workspace.js";
import { buildMassUlwPlan } from "./mass-ulw.js";

afterEach(cleanupExecutorRoots);

describe("MASS ULW failed publication recovery", () => {
  it("reconciles an exact failed attempt after the filesystem commit without repeating finalization", async () => {
    const repositoryRoot = await makeExecutorRepository();
    const stateDir = await temporaryExecutorRoot("mass-ulw-failed-publish-state-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B")] });
    const firstGeneration: string[] = [];
    const first = new MassUlwExecutor({
      stateDir,
      repositoryRoot,
      laneEngine: {
        async execute(request) {
          firstGeneration.push(`lane:${request.lane.id}`);
          const laneDirectory = request.lane.id.toLowerCase();
          const target = join(request.checkout.root, "src", laneDirectory, "published.txt");
          await mkdir(join(request.checkout.root, "src", laneDirectory), { recursive: true });
          await writeFile(target, `committed ${request.lane.id} once\n`, "utf8");
          await git(request.checkout.root, ["add", "-A"]);
          await git(request.checkout.root, ["commit", "-q", "-m", `publish ${request.lane.id}`]);
          return { outputFingerprint: `output-${request.lane.id}`, approachFingerprint: `approach-${request.lane.id}` };
        },
      },
      verificationEngine: {
        async verifyLane(request) {
          firstGeneration.push(`verify-lane:${request.lane.id}`);
          return { passed: true, fingerprint: request.outputFingerprint };
        },
        async verifyIntegrated(request) {
          firstGeneration.push("verify-integrated");
          return { passed: true, fingerprint: request.fingerprint };
        },
      },
      authorizePublish: async () => { firstGeneration.push("publish"); },
      workspaceFactory: async (options) => createMassUlwWorkspace({
        ...options,
        hooks: {
          afterPublicationCommitted: () => {
            firstGeneration.push("committed");
            throw new Error("interrupted after durable publication commit");
          },
        },
      }),
    });

    await expect(first.execute({ loopId: "failed-commit", plan }))
      .rejects.toThrow("interrupted after durable publication commit");

    expect(firstGeneration.sort()).toEqual([
      "committed", "lane:A", "lane:B", "publish", "verify-integrated", "verify-lane:A", "verify-lane:B",
    ]);
    expect(await readFile(join(repositoryRoot, "src", "a", "published.txt"), "utf8")).toBe("committed A once\n");
    expect(await readFile(join(repositoryRoot, "src", "b", "published.txt"), "utf8")).toBe("committed B once\n");
    const failed = await new MassUlwStore(stateDir).load("failed-commit");
    expect(failed.attempts.find((attempt) => attempt.kind === "publish")?.status).toBe("failed");
    expect(failed.publishJournal[0]?.status).toBe("failed");

    const repeated = { lane: 0, verifier: 0, publication: 0 };
    const recovery = new MassUlwExecutor({
      stateDir,
      repositoryRoot,
      laneEngine: {
        async execute() { repeated.lane += 1; throw new Error("lane repeated"); },
        async restore() { repeated.lane += 1; throw new Error("lane restore repeated"); },
      },
      verificationEngine: {
        async verifyLane() { repeated.verifier += 1; throw new Error("lane verifier repeated"); },
        async verifyIntegrated() { repeated.verifier += 1; throw new Error("integrated verifier repeated"); },
      },
      authorizePublish: async () => { repeated.publication += 1; },
      workspaceFactory: async () => { repeated.publication += 1; throw new Error("publication repeated"); },
    });

    const result = await recovery.execute({ loopId: "failed-commit", plan });
    const resumedAgain = await recovery.execute({ loopId: "failed-commit", plan });

    expect(result).toMatchObject({ status: "completed", finalVerificationInvocationCount: 1 });
    expect(resumedAgain).toMatchObject({ status: "completed", finalVerificationInvocationCount: 1 });
    expect(repeated).toEqual({ lane: 0, verifier: 0, publication: 0 });
    const persisted = await new MassUlwStore(stateDir).load("failed-commit");
    expect(persisted.publishJournal).toHaveLength(1);
    expect(persisted.publishJournal[0]).toMatchObject({ status: "published", receipt: { version: 1 } });
    expect(persisted.attempts.find((attempt) => attempt.kind === "publish")?.status).toBe("completed");
    await expect(stat(publicationTransactionRoot(stateDir, "failed-commit"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an ordinary failed attempt whose fingerprint does not match the durable generation", async () => {
    const stateDir = await temporaryExecutorRoot("mass-ulw-mismatched-publish-state-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B")] });
    const store = new MassUlwStore(stateDir, { now: () => 200 });
    const integrationCommit = "verified-integration";
    const changedPaths = ["src/a/published.txt"];
    const publishFingerprint = massUlwPublishFingerprint(integrationCommit, changedPaths);
    await store.create("mismatched-failure", plan);
    await store.update("mismatched-failure", (document) => {
      document.integrationVerification = {
        status: "passed",
        attemptId: "verification-1",
        fingerprint: integrationCommit,
        startedAt: 100,
        completedAt: 150,
      };
      document.fingerprints.integration = integrationCommit;
      document.fingerprints.publish = publishFingerprint;
      document.attempts.push({
        id: "publish-attempt-1",
        kind: "publish",
        status: "failed",
        startedAt: 160,
        completedAt: 170,
        fingerprint: "ordinary-failed-generation",
      });
      document.publishJournal.push({
        id: "publish-1",
        fingerprint: publishFingerprint,
        status: "failed",
        attemptId: "publish-attempt-1",
        startedAt: 160,
        completedAt: 170,
      });
    });

    await expect(store.reconcileCommittedPublication("mismatched-failure", {
      version: 1,
      repositoryRoot: stateDir,
      integrationCommit,
      changedPaths,
      laneCommits: [],
      publishFingerprint,
      postimages: [{ path: changedPaths[0] ?? "", exists: true, digest: "0".repeat(64) }],
    })).rejects.toThrow("no matching interrupted attempt");

    const rejected = (await store.load("mismatched-failure")).publishJournal[0];
    expect(rejected?.status).toBe("failed");
    expect(rejected).not.toHaveProperty("receipt");
  });

  it("keeps committed reconciliation idempotent while filesystem cleanup is retried", async () => {
    const stateDir = await temporaryExecutorRoot("mass-ulw-cleanup-retry-state-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A")] });
    const store = new MassUlwStore(stateDir, { now: () => 200 });
    const integrationCommit = "verified-integration";
    const changedPaths = ["src/a/published.txt"];
    const publishFingerprint = massUlwPublishFingerprint(integrationCommit, changedPaths);
    const receipt = {
      version: 1 as const,
      repositoryRoot: stateDir,
      integrationCommit,
      changedPaths,
      laneCommits: [{ id: "A", commit: "lane-a", changedPaths }],
      publishFingerprint,
      postimages: [{ path: changedPaths[0]!, exists: true as const, digest: "0".repeat(64) }],
    };
    await store.create("cleanup-retry", plan);
    await store.update("cleanup-retry", (document) => {
      document.integrationVerification = {
        status: "passed",
        attemptId: "verification-1",
        fingerprint: integrationCommit,
        startedAt: 100,
        completedAt: 150,
      };
      document.fingerprints.integration = integrationCommit;
      document.fingerprints.publish = publishFingerprint;
      document.attempts.push({
        id: "publish-attempt-1",
        kind: "publish",
        status: "interrupted",
        startedAt: 160,
        completedAt: 170,
        fingerprint: publishFingerprint,
      });
      document.publishJournal.push({
        id: "publish-1",
        fingerprint: publishFingerprint,
        status: "unknown-after-interruption",
        attemptId: "publish-attempt-1",
        startedAt: 160,
        completedAt: 170,
      });
    });

    const reconciled = await store.reconcileCommittedPublication("cleanup-retry", receipt);
    expect(reconciled.publishJournal[0]).toMatchObject({ status: "published", receipt });

    await expect(store.reconcileCommittedPublication("cleanup-retry", receipt)).resolves.toEqual(reconciled);
  });
});
