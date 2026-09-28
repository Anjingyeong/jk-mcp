import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MassUlwExecutor } from "./mass-ulw-executor.js";
import { fingerprintMassUlwRepository } from "./mass-ulw-workspace.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import { cleanupExecutorRoots, git, lane, makeExecutorRepository, temporaryExecutorRoot } from "./mass-ulw-runner-fixtures.js";

afterEach(cleanupExecutorRoots);

it("native-evolution R4 full executor publishes reverse-ID dependent shared writes and stable receipts", async () => {
  const repositoryRoot = await makeExecutorRepository();
  const stateDir = await temporaryExecutorRoot("native-evolution-B-R4-state-");
  const tempRoot = await temporaryExecutorRoot("native-evolution-B-R4-clones-");
  await writeFile(join(repositoryRoot, "base.txt"), "staged\n");
  await git(repositoryRoot, ["add", "base.txt"]);
  await writeFile(join(repositoryRoot, "base.txt"), "dirty-after-stage\n");
  const before = await fingerprintMassUlwRepository(repositoryRoot);
  const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [
    lane("A", { estimatedWeight: 5, writeScopes: ["src/shared"], dependsOn: ["Z"] }),
    lane("C", { estimatedWeight: 5, writeScopes: ["src/c"] }),
    lane("Z", { estimatedWeight: 5, writeScopes: ["src/shared"] }),
  ] });
  expect(plan.recommended).toBe(true);
  const effects: string[] = [];
  const executor = new MassUlwExecutor({ stateDir, repositoryRoot, tempRoot,
    laneEngine: { async execute(request) {
      const id = request.lane.id;
      const output = join(request.checkout.root, "src", id === "C" ? "c" : "shared", "value.txt");
      if (id === "A") expect(await readFile(output, "utf8")).toBe("Z\n");
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${id}\n`);
      await git(request.checkout.root, ["add", "-A"]);
      await git(request.checkout.root, ["commit", "-q", "-m", id]);
      effects.push(id);
      return { outputFingerprint: id, approachFingerprint: id };
    } },
    verificationEngine: {
      async verifyLane(request) { return { passed: true, fingerprint: request.outputFingerprint }; },
      async verifyIntegrated(request) {
        expect(await readFile(join(request.root, "src/shared/value.txt"), "utf8")).toBe("A\n");
        expect(await readFile(join(request.root, "src/c/value.txt"), "utf8")).toBe("C\n");
        effects.push("final");
        return { passed: true, fingerprint: request.fingerprint };
      },
    },
  });
  const result = await executor.execute({ loopId: "reverse-dependent", plan });
  expect(result.status).toBe("completed");
  expect(await executor.execute({ loopId: "reverse-dependent", plan })).toEqual(result);
  expect(effects.sort()).toEqual(["A", "C", "Z", "final"]);
  expect(await readFile(join(repositoryRoot, "src/shared/value.txt"), "utf8")).toBe("A\n");
  expect(await git(repositoryRoot, ["show", ":base.txt"])).toBe("staged\n");
  expect(await readFile(join(repositoryRoot, "base.txt"), "utf8")).toBe("dirty-after-stage\n");
  expect((await fingerprintMassUlwRepository(repositoryRoot)).indexDigest).toBe(before.indexDigest);
  expect(await readdir(tempRoot)).toEqual([]);
}, 120_000);
