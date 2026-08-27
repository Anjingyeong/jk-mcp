import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { MassUlwExecutor } from "./mass-ulw-executor.js";
import { createMassUlwWorkspace } from "./mass-ulw-workspace.js";
import { buildMassUlwPlan } from "./mass-ulw.js";
import { lane } from "./mass-ulw-runner-fixtures.js";

const execFileAsync = promisify(execFile);
const [stateDir, repositoryRoot, counterPath] = process.argv.slice(2);
if (!stateDir || !repositoryRoot || !counterPath) throw new Error("Crash fixture requires state, repository, and counter paths");

const plan = buildMassUlwPlan({ executionProfile: "max", candidates: [lane("A"), lane("B")] });
const record = async (event: string): Promise<void> => appendFile(counterPath, `${event}\n`, "utf8");

await new MassUlwExecutor({
  stateDir,
  repositoryRoot,
  laneEngine: {
    async execute(request) {
      await record(`lane:${request.lane.id}`);
      const laneDirectory = request.lane.id.toLowerCase();
      const target = join(request.checkout.root, "src", laneDirectory, "published.txt");
      await mkdir(join(request.checkout.root, "src", laneDirectory), { recursive: true });
      await writeFile(target, `committed ${request.lane.id} once\n`, "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: request.checkout.root, windowsHide: true });
      await execFileAsync("git", ["commit", "-q", "-m", "publish committed generation"], {
        cwd: request.checkout.root,
        windowsHide: true,
      });
      return { outputFingerprint: "output-A", approachFingerprint: "approach-A" };
    },
  },
  verificationEngine: {
    async verifyLane(request) {
      await record(`verify-lane:${request.lane.id}`);
      return { passed: true, fingerprint: request.outputFingerprint };
    },
    async verifyIntegrated(request) {
      await record("verify-integrated");
      return { passed: true, fingerprint: request.fingerprint };
    },
  },
  authorizePublish: async () => record("publish"),
  workspaceFactory: async (options) => {
    let privateRoot: string | null = null;
    const workspace = await createMassUlwWorkspace({
      ...options,
      hooks: {
        afterPublicationCommitted: async () => {
          if (!privateRoot) throw new Error("Crash fixture workspace root is unavailable");
          await record("committed");
          process.send?.({ type: "publication-committed", privateRoot });
          await new Promise<void>(() => undefined);
        },
      },
    });
    privateRoot = workspace.privateRoot;
    return workspace;
  },
}).execute({ loopId: "committed-crash", plan });
