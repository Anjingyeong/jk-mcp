import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MassUlwExecutor } from "./mass-ulw-executor.js";
import { cleanupExecutorRoots, lane, makeExecutorRepository } from "./mass-ulw-runner-fixtures.js";
import { MassUlwStore } from "./mass-ulw-store.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import {
  massUlwPublishFingerprint,
  publicationTransactionRoot,
  recoverMassUlwPublication,
} from "./mass-ulw-publish-recovery.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await cleanupExecutorRoots();
});

async function publicationCommitted(child: ChildProcess, stderr: () => string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out awaiting committed publication: ${stderr()}`)), 60_000);
    child.once("message", (message: unknown) => {
      clearTimeout(timeout);
      const privateRoot = typeof message === "object" && message !== null && "privateRoot" in message
        ? Reflect.get(message, "privateRoot")
        : null;
      if (typeof privateRoot !== "string") {
        reject(new Error(`Crash fixture omitted its private workspace root: ${JSON.stringify(message)}`));
        return;
      }
      resolve(privateRoot);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Crash fixture exited before commit with code ${code}: ${stderr()}`));
    });
  });
}

describe("MASS ULW durable publication recovery", () => {
  it("recovers a process interruption after filesystem commit without repeating finalization", async () => {
    const repositoryRoot = await makeExecutorRepository();
    const recoveryRoot = await mkdtemp(join(tmpdir(), "mass-ulw-publish-state-"));
    roots.push(recoveryRoot);
    const counterPath = join(recoveryRoot, "invocations.log");
    await writeFile(counterPath, "", "utf8");
    const fixture = fileURLToPath(new URL("./mass-ulw-publish-crash-fixture.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", fixture, recoveryRoot, repositoryRoot, counterPath], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const privateRoot = await publicationCommitted(child, () => stderr);
    expect((await stat(privateRoot)).isDirectory()).toBe(true);
    const exited = once(child, "exit");
    child.kill();
    await exited;

    expect((await readFile(counterPath, "utf8")).trim().split("\n").sort()).toEqual([
      "committed", "lane:A", "lane:B", "publish", "verify-integrated", "verify-lane:A", "verify-lane:B",
    ]);
    expect(await readFile(join(repositoryRoot, "src", "a", "published.txt"), "utf8")).toBe("committed A once\n");
    expect(await readFile(join(repositoryRoot, "src", "b", "published.txt"), "utf8")).toBe("committed B once\n");

    const repeat = { lane: 0, verifier: 0, publication: 0 };
    const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B")] });
    const executor = new MassUlwExecutor({
      stateDir: recoveryRoot,
      repositoryRoot,
      laneEngine: {
        async execute() { repeat.lane += 1; throw new Error("lane repeated"); },
        async restore() { repeat.lane += 1; throw new Error("lane restore repeated"); },
      },
      verificationEngine: {
        async verifyLane() { repeat.verifier += 1; throw new Error("lane verifier repeated"); },
        async verifyIntegrated() { repeat.verifier += 1; throw new Error("integrated verifier repeated"); },
      },
      authorizePublish: async () => { repeat.publication += 1; },
      workspaceFactory: async () => { repeat.publication += 1; throw new Error("workspace publication repeated"); },
    });

    const result = await executor.execute({ loopId: "committed-crash", plan });

    expect(result).toMatchObject({
      status: "completed",
      changedPaths: ["src/a/published.txt", "src/b/published.txt"],
      finalVerificationInvocationCount: 1,
    });
    expect(repeat).toEqual({ lane: 0, verifier: 0, publication: 0 });
    const persisted = await new MassUlwStore(recoveryRoot).load("committed-crash");
    expect(persisted.publishJournal).toHaveLength(1);
    expect(persisted.publishJournal[0]).toMatchObject({
      status: "published",
      receipt: {
        changedPaths: ["src/a/published.txt", "src/b/published.txt"],
        postimages: [{ path: "src/a/published.txt" }, { path: "src/b/published.txt" }],
      },
    });
    await expect(stat(publicationTransactionRoot(recoveryRoot, "committed-crash"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns committed evidence without deleting it before state reconciliation", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "mass-ulw-publish-repo-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "mass-ulw-publish-state-"));
    roots.push(repositoryRoot, recoveryRoot);
    const transactionRoot = publicationTransactionRoot(recoveryRoot, "publish-committed");
    const published = join(repositoryRoot, "src", "published.txt");
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(published, "committed bytes\n", "utf8");
    await writeFile(join(transactionRoot, "journal.json"), JSON.stringify({
      version: 1,
      repositoryRoot,
      phase: "committed",
      paths: ["src/published.txt"],
      applied: ["src/published.txt"],
      preexisting: [],
      backedUp: [],
      receipt: {
        version: 1,
        repositoryRoot,
        integrationCommit: "integration-commit",
        changedPaths: ["src/published.txt"],
        laneCommits: [{ id: "lane-a", commit: "lane-commit", changedPaths: ["src/published.txt"] }],
        publishFingerprint: massUlwPublishFingerprint("integration-commit", ["src/published.txt"]),
        postimages: [{
          path: "src/published.txt",
          exists: true,
          digest: createHash("sha256").update("committed bytes\n").digest("hex"),
        }],
      },
    }), "utf8");

    const recovery = await recoverMassUlwPublication({ recoveryRoot, recoveryId: "publish-committed", repositoryRoot });

    expect(recovery).toMatchObject({
      kind: "committed",
      receipt: { integrationCommit: "integration-commit", changedPaths: ["src/published.txt"] },
    });
    expect(await readFile(published, "utf8")).toBe("committed bytes\n");
    expect((await stat(transactionRoot)).isDirectory()).toBe(true);
  });

  it("recovers an interrupted multi-path publication on restart", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "mass-ulw-publish-repo-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "mass-ulw-publish-state-"));
    roots.push(repositoryRoot, recoveryRoot);
    const transactionRoot = publicationTransactionRoot(recoveryRoot, "publish-restart");
    const backupRoot = join(transactionRoot, "backup");
    const existing = join(repositoryRoot, "src", "a", "existing.txt");
    const added = join(repositoryRoot, "src", "a", "added.txt");
    const backup = join(backupRoot, "src", "a", "existing.txt");
    await mkdir(join(repositoryRoot, "src", "a"), { recursive: true });
    await mkdir(join(backupRoot, "src", "a"), { recursive: true });
    await writeFile(existing, "partially published\n", "utf8");
    await writeFile(added, "partially added\n", "utf8");
    await writeFile(backup, "original\n", "utf8");
    await writeFile(
      join(transactionRoot, "journal.json"),
      JSON.stringify({
        version: 1,
        repositoryRoot,
        phase: "publishing",
        paths: ["src/a/added.txt", "src/a/existing.txt"],
        applied: ["src/a/added.txt", "src/a/existing.txt"],
        preexisting: ["src/a/existing.txt"],
        backedUp: ["src/a/existing.txt"],
      }),
      "utf8",
    );

    await recoverMassUlwPublication({ recoveryRoot, recoveryId: "publish-restart", repositoryRoot });

    expect(await readFile(existing, "utf8")).toBe("original\n");
    await expect(stat(added)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(transactionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
