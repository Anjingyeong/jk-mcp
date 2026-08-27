import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveMassUlwExecutionId } from "../dist/orchestration/mass-ulw-identity-index.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = await mkdtemp(path.join(tmpdir(), "jk-mass-ulw-stdio-"));
const projectRoot = path.join(base, "project");
const home = path.join(base, "home");
const codexHome = path.join(base, "codex");
const processTemp = path.join(base, "process-temp");
const evidenceDir = path.join(processTemp, "mass-ulw-qa-events");
const surfaceEvidenceDir = path.join(repoRoot, "evidence", "mass-ulw");
const surfaceEvidencePath = path.join(surfaceEvidenceDir, "surface-mcp.json");
const stateDir = path.join(home, ".local", "share", "chatgpt2codex");
const loopId = "qa-mass-ulw-stdio";
const workSessionId = "ws_mass_ulw_stdio";
const expectedWaves = [["A"], ["B", "C"], ["D"]];
const expectedPaths = ["lanes/a/result.txt", "lanes/b/result.txt", "lanes/c/result.txt", "lanes/d/result.txt"];
const verifierIds = { A: "npm:test", B: "npm:tests", C: "npm:typecheck", D: "npm:lint" };
const stderrLines = [];
let client;
let transport;
let serverProcess;
let serverPid = null;
let barrierServer;
const barrierConnections = new Set();
let report = { pass: false };

try {
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(evidenceDir, { recursive: true }),
  ]);
  await writeFile(path.join(projectRoot, "package.json"), `${JSON.stringify({
    name: "jk-mass-ulw-stdio-qa",
    private: true,
    type: "module",
    scripts: {
      test: "node qa-verifier.mjs lane A",
      tests: "node qa-verifier.mjs lane B",
      typecheck: "node qa-verifier.mjs lane C",
      lint: "node qa-verifier.mjs lane D",
      verify: "node qa-verifier.mjs final",
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(projectRoot, "qa-verifier.mjs"), verifierFixture(), "utf8");
  await git(projectRoot, ["init", "-q"]);
  await git(projectRoot, ["config", "user.name", "MASS ULW Stdio QA"]);
  await git(projectRoot, ["config", "user.email", "mass-ulw-stdio@example.invalid"]);
  await git(projectRoot, ["add", "package.json", "qa-verifier.mjs"]);
  await git(projectRoot, ["commit", "-qm", "qa baseline"]);
  await writeFile(path.join(projectRoot, "dirty-preserved.txt"), "ephemeral dirty worktree sentinel\n", "utf8");

  const arrived = new Map();
  barrierServer = net.createServer((socket) => {
    barrierConnections.add(socket);
    socket.setEncoding("utf8");
    socket.once("data", (value) => {
      const lane = String(value).trim();
      if (lane !== "B" && lane !== "C") {
        socket.destroy(new Error(`unexpected barrier lane ${lane}`));
        return;
      }
      arrived.set(lane, socket);
      if (arrived.has("B") && arrived.has("C")) {
        arrived.get("B").end("release\n");
        arrived.get("C").end("release\n");
      }
    });
    socket.once("close", () => barrierConnections.delete(socket));
  });
  barrierServer.listen(0, "127.0.0.1");
  await once(barrierServer, "listening");
  const barrierAddress = barrierServer.address();
  if (!barrierAddress || typeof barrierAddress === "string") throw new Error("failed to start the QA lane barrier");
  await writeFile(path.join(evidenceDir, "barrier-port"), String(barrierAddress.port), "utf8");

  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "cli.js"), "serve", "--workspace", projectRoot,
      "--active-project-root", projectRoot, "--active-project-preset", "full-write"],
    cwd: repoRoot,
    env: { ...inherited, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home,
      TEMP: processTemp, TMP: processTemp },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrLines.push(...String(chunk).split(/\r?\n/u).filter(Boolean)));
  client = new Client({ name: "jk-mass-ulw-stdio-qa", version: "0.0.0" });
  await client.connect(transport);
  serverPid = transport.pid;
  serverProcess = transport._process;

  const listed = await client.listTools();
  const toolListed = listed.tools.some((tool) => tool.name === "mass_ulw_execute");
  const workspaceResult = await client.callTool({ name: "workspace_list_projects", arguments: {} });
  const project = readProjects(workspaceResult.structuredContent)
    .find((entry) => path.resolve(entry.root) === path.resolve(projectRoot));
  if (!project) throw new Error("ephemeral project was not routed by the stdio server");

  const plannedResult = await client.callTool({
    name: "goal_loop",
    arguments: {
      goal: "Build and verify dependency-aware outputs A through D",
      loopId,
      projectId: project.projectId,
      workSessionId,
      mode: "implement",
      executionProfile: "max",
      pending: ["A", "B", "C", "D"],
      fanoutCandidates: [
        { id: "A", task: "Implement foundation A", estimatedWeight: 5, writeScopes: ["lanes/a"] },
        { id: "B", task: "Implement parallel branch B", estimatedWeight: 5, writeScopes: ["lanes/b"], dependsOn: ["A"] },
        { id: "C", task: "Implement parallel branch C", estimatedWeight: 5, writeScopes: ["lanes/c"], dependsOn: ["A"] },
        { id: "D", task: "Integrate terminal output D", estimatedWeight: 5, writeScopes: ["lanes/d"], dependsOn: ["B", "C"] },
      ],
    },
  });
  if (plannedResult.isError === true) throw new Error(`goal_loop failed: ${JSON.stringify(plannedResult.structuredContent)}`);
  const planned = requireRecord(plannedResult.structuredContent, "goal_loop structuredContent");
  const orchestration = requireRecord(planned.orchestration, "goal_loop orchestration");
  const plan = requireRecord(orchestration.massUlw, "goal_loop MASS ULW plan");
  const planFingerprint = requireString(plan.planFingerprint, "planFingerprint");
  const waves = requireStringMatrix(plan.waves, "plan waves");
  const executeInput = {
    projectId: project.projectId,
    loopId,
    planFingerprint,
    workSessionId,
    lanePatches: Object.fromEntries(["A", "B", "C", "D"].map((lane) => [lane, lanePatch(lane)])),
    laneVerificationCommandIds: verifierIds,
    finalVerificationCommandId: "npm:verify",
    timeoutSec: 30,
  };

  const firstResult = await client.callTool({ name: "mass_ulw_execute", arguments: executeInput });
  if (firstResult.isError === true) throw new Error(`mass_ulw_execute failed: ${JSON.stringify(firstResult.structuredContent)}`);
  const first = requireRecord(firstResult.structuredContent, "first mass_ulw_execute structuredContent");
  const executionId = await resolveMassUlwExecutionId(stateDir, {
    projectId: project.projectId,
    externalLoopId: loopId,
  });
  if (!executionId) throw new Error("goal-loop did not persist a scoped MASS ULW identity index");
  const persistedPath = path.join(stateDir, "orchestration", "mass-ulw", `${executionId}.json`);
  const persistedBeforeText = await readFile(persistedPath, "utf8");
  const persistedBefore = JSON.parse(persistedBeforeText);

  const secondResult = await client.callTool({ name: "mass_ulw_execute", arguments: executeInput });
  if (secondResult.isError === true) throw new Error(`terminal resume failed: ${JSON.stringify(secondResult.structuredContent)}`);
  const second = requireRecord(secondResult.structuredContent, "second mass_ulw_execute structuredContent");
  const persistedAfterText = await readFile(persistedPath, "utf8");
  const persistedAfter = JSON.parse(persistedAfterText);
  const availableEvidence = await readdir(evidenceDir);
  if (first.status !== "completed" || second.status !== "completed") {
    throw new Error(`MASS ULW did not complete: ${JSON.stringify({
      firstStatus: first.status,
      secondStatus: second.status,
      firstCompletedLaneIds: first.completedLaneIds,
      firstFailedLaneId: first.failedLaneId,
      lanes: Object.fromEntries(Object.entries(persistedAfter.lanes ?? {})
        .map(([id, lane]) => [id, { status: lane.status, attempts: lane.attempts }])),
      availableEvidence,
    })}`);
  }

  const lanes = ["A", "B", "C", "D"];
  const barrierFiles = await Promise.all(["arrived-B", "arrived-C", "released-B", "released-C"]
    .map((name) => fileExists(path.join(evidenceDir, name))));
  const verifierFiles = await Promise.all(lanes.map((lane) => fileExists(path.join(evidenceDir, `verified-${lane}`))));
  const mergedContents = await Promise.all(lanes.map((lane) =>
    readFile(path.join(projectRoot, "lanes", lane.toLowerCase(), "result.txt"), "utf8")));
  const finalCount = Number.parseInt(await readFile(path.join(evidenceDir, "final-count"), "utf8"), 10);
  const changedPaths = stringArray(first.changedPaths);
  const laneCommits = Array.isArray(first.laneCommits) ? first.laneCommits : [];
  const overlapProven = barrierFiles.every(Boolean);
  const exactMerge = sameStrings(changedPaths, expectedPaths)
    && mergedContents.every((content, index) => content.trimEnd() === `lane ${lanes[index]} complete`)
    && laneCommits.length === 4;
  const terminalIdempotent = second.status === "completed"
    && second.finalVerificationInvocationCount === 1
    && persistedBeforeText === persistedAfterText
    && finalCount === 1;
  const checks = {
    toolListed,
    planApproved: plan.state === "fanout" && plan.recommended === true && sameMatrix(waves, expectedWaves),
    firstCompleted: first.status === "completed" && sameStrings(stringArray(first.completedLaneIds), lanes),
    overlapProven,
    declaredScopeMerge: exactMerge,
    dirtyWorktreePreserved: await readFile(path.join(projectRoot, "dirty-preserved.txt"), "utf8")
      === "ephemeral dirty worktree sentinel\n",
    laneVerifierOrdering: verifierFiles.every(Boolean),
    finalVerifierOnce: first.finalVerificationInvocationCount === 1 && finalCount === 1,
    persistedTerminal: persistedBefore.integrationVerification?.status === "passed"
      && persistedBefore.publishJournal?.some((entry) => entry.status === "published"),
    terminalIdempotent,
    nativeEngine: first.externalModelRequired !== true,
  };

  report = {
    pass: Object.values(checks).every(Boolean),
    maxConcurrency: overlapProven ? 2 : 0,
    mergeConflicts: exactMerge ? [] : ["integrated output did not match four declared disjoint scopes"],
    verification: {
      status: verifierFiles.every(Boolean) && finalCount === 1 ? "pass" : "fail",
      perLaneOrdering: verifierFiles.every(Boolean),
      finalInvocationCount: finalCount,
    },
    cleanup: { serverStopped: false, tempRemoved: false },
    checks,
    projectId: project.projectId,
    serverPid,
    plan: { state: plan.state, recommended: plan.recommended, planFingerprint, waves },
    execution: { status: first.status, completedLaneIds: stringArray(first.completedLaneIds), changedPaths,
      laneCommitCount: laneCommits.length },
    resume: {
      status: second.status,
      persistedStateUnchanged: persistedBeforeText === persistedAfterText,
      terminalIdempotent,
      integrationVerificationStatus: persistedAfter.integrationVerification?.status ?? null,
      publishStatus: persistedAfter.publishJournal?.at(-1)?.status ?? null,
    },
    native: { externalModelRequired: first.externalModelRequired ?? false, lanePatchCount: lanes.length },
  };
} catch (error) {
  report = {
    pass: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    cleanup: { serverStopped: false, tempRemoved: false },
  };
} finally {
  const cleanupErrors = [];
  const serverExit = serverProcess && serverProcess.exitCode === null
    ? new Promise((resolve) => serverProcess.once("close", resolve))
    : Promise.resolve();
  await client?.close().catch((error) => cleanupErrors.push(`client close: ${String(error)}`));
  await transport?.close().catch((error) => cleanupErrors.push(`transport close: ${String(error)}`));
  for (const socket of barrierConnections) socket.destroy();
  if (barrierServer) {
    await new Promise((resolve) => barrierServer.close(resolve))
      .catch((error) => cleanupErrors.push(`barrier close: ${String(error)}`));
  }
  if (serverProcess?.exitCode === null) {
    try {
      serverProcess.kill("SIGKILL");
    } catch (error) {
      cleanupErrors.push(`server kill: ${String(error)}`);
    }
  }
  await Promise.race([serverExit, boundedTimeout(5_000)]);
  const serverStopped = serverPid === null || !isPidAlive(serverPid);
  await rm(base, { recursive: true, force: true }).catch((error) => cleanupErrors.push(`temp remove: ${String(error)}`));
  const tempRemoved = (await stat(base).catch(() => null)) === null;
  report.cleanup = { serverStopped, tempRemoved, errors: cleanupErrors };
  report.stderr = stderrLines;
  report.pass = report.pass === true && serverStopped && tempRemoved && cleanupErrors.length === 0;
}

await mkdir(surfaceEvidenceDir, { recursive: true });
await writeFile(surfaceEvidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function fileExists(file) {
  return access(file).then(() => true, () => false);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} was not a string`);
  return value;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function requireStringMatrix(value, label) {
  if (!Array.isArray(value)
    || !value.every((wave) => Array.isArray(wave) && wave.every((entry) => typeof entry === "string"))) {
    throw new Error(`${label} was not a string matrix`);
  }
  return value;
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sameMatrix(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readProjects(value) {
  const record = requireRecord(value, "workspace_list_projects structuredContent");
  if (!Array.isArray(record.projects)) throw new Error("workspace_list_projects returned no projects");
  return record.projects.filter((entry) => isRecord(entry)
    && typeof entry.projectId === "string" && typeof entry.root === "string");
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function boundedTimeout(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function verifierFixture() {
  return `import net from "node:net";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const evidence = path.join(process.env.TEMP, "mass-ulw-qa-events");
await mkdir(evidence, { recursive: true });
const [kind, lane] = process.argv.slice(2);
if (kind === "lane" && /^[A-D]$/.test(lane)) {
  for (const dependency of lane === "D" ? ["B", "C"] : lane === "B" || lane === "C" ? ["A"] : []) {
    await access(path.join(evidence, \`verified-\${dependency}\`));
  }
  await access(path.join(process.cwd(), "lanes", lane.toLowerCase(), "result.txt"));
  if (lane === "B" || lane === "C") await crossBarrier(evidence, lane, lane === "B" ? "C" : "B");
  const marker = await open(path.join(evidence, \`verified-\${lane}\`), "wx");
  await marker.writeFile("verified after native patch\\n", "utf8");
  await marker.close();
  console.log(\`verified lane \${lane}\`);
} else if (kind === "final") {
  for (const id of ["A", "B", "C", "D"]) {
    await access(path.join(evidence, \`verified-\${id}\`));
    await access(path.join(process.cwd(), "lanes", id.toLowerCase(), "result.txt"));
  }
  const count = await open(path.join(evidence, "final-count"), "wx");
  await count.writeFile("1\\n", "utf8");
  await count.close();
  await writeFile(path.join(evidence, "final-verified"), "pass\\n", "utf8");
  console.log("verified integrated result once");
} else {
  throw new Error("invalid verifier invocation");
}

async function crossBarrier(evidenceRoot, self, peer) {
  await writeFile(path.join(evidenceRoot, \`arrived-\${self}\`), String(process.pid), "utf8");
  const port = Number(await readFile(path.join(evidenceRoot, "barrier-port"), "utf8"));
  if (!Number.isInteger(port) || port <= 0) throw new Error("missing QA barrier port");
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(self));
    socket.setEncoding("utf8");
    socket.setTimeout(10000, () => socket.destroy(new Error(\`barrier timeout waiting for \${peer}\`)));
    socket.once("data", (value) => {
      if (String(value).trim() !== "release") return reject(new Error(\`unexpected barrier response \${value}\`));
      resolve();
    });
    socket.once("error", reject);
  });
  await writeFile(path.join(evidenceRoot, \`released-\${self}\`), \`observed \${peer}\\n\`, "utf8");
}
`;
}

function lanePatch(lane) {
  const lower = lane.toLowerCase();
  return `*** Begin Patch\n*** Add File: lanes/${lower}/result.txt\n+lane ${lane} complete\n*** End Patch`;
}
