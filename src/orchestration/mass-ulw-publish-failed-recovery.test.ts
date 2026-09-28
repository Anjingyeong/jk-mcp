import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor } from "./mass-ulw-executor.js";
import {
  git,
  lane,
} from "./mass-ulw-runner-fixtures.js";
import { massUlwPublishFingerprint, publicationTransactionRoot } from "./mass-ulw-publish-recovery.js";
import { MassUlwStore, type MassUlwDocument } from "./mass-ulw-store.js";
import { createMassUlwWorkspace, massUlwPrivateWorkspaceRoot } from "./mass-ulw-workspace.js";
import { buildMassUlwPlan } from "./mass-ulw.js";

const roots: string[] = [];
async function temporaryExecutorRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
async function makeExecutorRepository(): Promise<string> {
  const root = await temporaryExecutorRoot("mass-ulw-receipt-repo-");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Receipt Test"]);
  await git(root, ["config", "user.email", "receipt@example.test"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, ".gitattributes"), "* -text\n");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  return root;
}
afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
  console.log("RECEIPT_TEST_CLEANUP", JSON.stringify({ complete: true, paths: roots.splice(0) }));
});

describe("MASS ULW failed publication recovery", () => {
  it.each(["commit-hook", "published-state-save"] as const)("native-evolution R12 reconciles an exact failed attempt at %s with stable receipts", async (boundary) => {
    const repositoryRoot = await makeExecutorRepository();
    const stateDir = await temporaryExecutorRoot("mass-ulw-failed-publish-state-");
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B")] });
    const firstGeneration: string[] = [];
    const interruption = new Error(`interrupted at ${boundary}`);
    let saveFailures = 0;
    class FailingPublishedStore extends MassUlwStore {
      protected override async persist(document: MassUlwDocument): Promise<void> {
        if (boundary === "published-state-save" && saveFailures === 0 && document.publishJournal.some((entry) => entry.status === "published")) {
          saveFailures += 1;
          firstGeneration.push("committed");
          throw interruption;
        }
        await super.persist(document);
      }
    }
    const tempRoot = await temporaryExecutorRoot("mass-ulw-receipt-private-");
    const first = new MassUlwExecutor({
      stateDir,
      repositoryRoot,
      tempRoot,
      store: new FailingPublishedStore(stateDir),
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
        hooks: boundary === "commit-hook" ? {
          afterPublicationCommitted: () => {
            firstGeneration.push("committed");
            throw interruption;
          },
        } : {},
      }),
    });

    await expect(first.execute({ loopId: "failed-commit", plan }))
      .rejects.toBe(interruption);

    expect(saveFailures).toBe(boundary === "published-state-save" ? 1 : 0);
    expect(firstGeneration.sort()).toEqual([
      "committed", "lane:A", "lane:B", "publish", "verify-integrated", "verify-lane:A", "verify-lane:B",
    ]);
    expect(await readFile(join(repositoryRoot, "src", "a", "published.txt"), "utf8")).toBe("committed A once\n");
    expect(await readFile(join(repositoryRoot, "src", "b", "published.txt"), "utf8")).toBe("committed B once\n");
    const failed = await new MassUlwStore(stateDir).load("failed-commit");
    expect(failed.attempts.find((attempt) => attempt.kind === "publish")?.status).toBe("failed");
    expect(failed.publishJournal[0]?.status).toBe("failed");
    await expect(stat(massUlwPrivateWorkspaceRoot(tempRoot, stateDir, "failed-commit"))).rejects.toMatchObject({ code: "ENOENT" });
    const committedJournal: unknown = JSON.parse(await readFile(join(publicationTransactionRoot(stateDir, "failed-commit"), "journal.json"), "utf8"));
    expect(committedJournal).toMatchObject({ phase: "committed", receipt: { version: 1, changedPaths: ["src/a/published.txt", "src/b/published.txt"] } });

    const repeated = { lane: 0, verifier: 0, publication: 0 };
    const recovery = new MassUlwExecutor({
      stateDir,
      repositoryRoot,
      tempRoot,
      laneEngine: {
        async execute() { repeated.lane += 1; throw new Error("lane repeated"); },
        async restore() { repeated.lane += 1; throw new Error("lane restore repeated"); },
      },
      verificationEngine: {
        async verifyLane() { repeated.verifier += 1; throw new Error("lane verifier repeated"); },
        async verifyIntegrated() { repeated.verifier += 1; throw new Error("integrated verifier repeated"); },
      },
      authorizePublish: async () => { repeated.publication += 1; throw new Error("publish authorization repeated"); },
      workspaceFactory: async () => { repeated.publication += 1; throw new Error("publication repeated"); },
    });

    const result = await recovery.execute({ loopId: "failed-commit", plan });
    const resumedAgain = await recovery.execute({ loopId: "failed-commit", plan });

    expect(result).toMatchObject({ status: "completed", finalVerificationInvocationCount: 1 });
    expect(resumedAgain).toMatchObject({ status: "completed", finalVerificationInvocationCount: 1 });
    expect(resumedAgain).toEqual(result);
    expect(repeated).toEqual({ lane: 0, verifier: 0, publication: 0 });
    const persisted = await new MassUlwStore(stateDir).load("failed-commit");
    expect(persisted.publishJournal).toHaveLength(1);
    expect(persisted.publishJournal[0]).toMatchObject({ status: "published", receipt: { version: 1 } });
    expect(persisted.attempts.filter((attempt) => attempt.kind === "publish")).toHaveLength(1);
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
