import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = await mkdtemp(path.join(tmpdir(), "jk-omo-ulw-stdio-"));
const projectRoot = path.join(base, "project");
const home = path.join(base, "home");
const appData = path.join(base, "appdata");
const codexHome = path.join(base, "codex");
const nativeCli = path.join(appData, "npm", "node_modules", "omo-ai", "bin", "omo.js");
const stderrLines = [];
let client;
let transport;
let serverPid = null;
let report = { pass: false };

try {
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(path.dirname(nativeCli), { recursive: true }),
  ]);
  await writeFile(path.join(projectRoot, "package.json"), '{"name":"jk-omo-ulw-qa","private":true}\n', "utf8");
  await writeFile(
    nativeCli,
    [
      "const argv = process.argv.slice(2);",
      "if (argv.includes('--help')) {",
      "  console.log('Usage: omo [options] [message] --mode --print --model --session-id --verbose --omo-senpi-ultrawork-disabled');",
      "  process.exit(0);",
      "}",
      "console.log(JSON.stringify({ type: 'session', id: 'ses_stdio_native' }));",
      "console.log(JSON.stringify({ argv }));",
    ].join("\n"),
    "utf8",
  );

  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(repoRoot, "dist", "cli.js"),
      "serve",
      "--workspace",
      projectRoot,
      "--active-project-root",
      projectRoot,
      "--active-project-preset",
      "full-write",
    ],
    cwd: repoRoot,
    env: {
      ...inherited,
      APPDATA: appData,
      CODEX_HOME: codexHome,
      HOME: home,
      USERPROFILE: home,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrLines.push(String(chunk).trim()));
  client = new Client({ name: "jk-omo-ulw-stdio-qa", version: "0.0.0" });
  await client.connect(transport);
  serverPid = transport.pid;

  const tools = await client.listTools();
  const omoRun = tools.tools.find((tool) => tool.name === "omo_run");
  const schemaProperties = omoRun?.inputSchema.properties ?? {};
  const workspaceResult = await client.callTool({ name: "workspace_list_projects", arguments: {} });
  const projects = readProjects(workspaceResult.structuredContent);
  const project = projects.find((entry) => path.resolve(entry.root) === path.resolve(projectRoot));
  if (!project) throw new Error(`temporary project not listed: ${JSON.stringify(projects)}`);

  const ulwResult = await client.callTool({
    name: "omo_run",
    arguments: {
      projectId: project.projectId,
      message: "ship through real stdio",
      model: "openai/gpt-test",
      sessionId: "ses_old",
      timeoutSec: 10,
      verbose: true,
      ultrawork: true,
    },
  });
  const normalMessage = "mass-ulw remains literal data";
  const normalResult = await client.callTool({
    name: "omo_run",
    arguments: {
      projectId: project.projectId,
      message: normalMessage,
      timeoutSec: 10,
      ultrawork: false,
    },
  });

  const ulw = readStructuredResult(ulwResult.structuredContent);
  const normal = readStructuredResult(normalResult.structuredContent);
  const ulwArgv = parseArgv(ulw.stdoutSummary);
  const normalArgv = parseArgv(normal.stdoutSummary);
  const checks = {
    toolListed: Boolean(omoRun),
    optionalBooleanPublished:
      isRecord(schemaProperties.ultrawork) && schemaProperties.ultrawork.type === "boolean",
    ulwCallSucceeded: ulwResult.isError !== true,
    normalCallSucceeded: normalResult.isError !== true,
    nativeContract: ulw.cliContract === "native-print",
    nativeSession: ulw.sessionId === "ses_stdio_native",
    ulwTransport: ulw.ultraworkTransport === "native-hook-trigger",
    ulwSuffix: ulwArgv.at(-1) === "ship through real stdio\n\nulw",
    oneTrigger: (ulwArgv.at(-1)?.match(/(?:ultrawork|ulw(?!-))/giu) ?? []).length === 1,
    noCopiedDirective: !ulwArgv.some((arg) => arg.includes("<ultrawork-mode>")),
    normalTransport: normal.ultraworkTransport === "native-hook-disabled",
    normalDisableFlag: normalArgv.includes("--omo-senpi-ultrawork-disabled"),
    normalBytes: normalArgv.at(-1) === normalMessage,
  };
  report = {
    pass: Object.values(checks).every(Boolean),
    checks,
    projectId: project.projectId,
    serverPid,
    toolSchemaUltrawork: schemaProperties.ultrawork,
    ulw: {
      cliContract: ulw.cliContract,
      sessionId: ulw.sessionId,
      ultraworkRequested: ulw.ultraworkRequested,
      ultraworkTransport: ulw.ultraworkTransport,
      argv: ulwArgv,
    },
    normal: {
      ultraworkRequested: normal.ultraworkRequested,
      ultraworkTransport: normal.ultraworkTransport,
      argv: normalArgv,
    },
  };
} catch (error) {
  report = {
    pass: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  const serverStopped = serverPid === null || !isPidAlive(serverPid);
  await rm(base, { recursive: true, force: true });
  const tempRemoved = (await stat(base).catch(() => null)) === null;
  report.cleanup = {
    serverStopped,
    tempRemoved,
    removedPath: base,
  };
  report.stderr = stderrLines.filter(Boolean);
  report.pass = report.pass === true && serverStopped && tempRemoved;
}

console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProjects(value) {
  if (!isRecord(value) || !Array.isArray(value.projects)) throw new Error("workspace_list_projects returned no projects");
  return value.projects.filter(
    (entry) =>
      isRecord(entry) &&
      typeof entry.projectId === "string" &&
      typeof entry.root === "string",
  );
}

function readStructuredResult(value) {
  if (!isRecord(value) || typeof value.stdoutSummary !== "string") {
    throw new Error(`omo_run returned invalid structured content: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseArgv(stdout) {
  const lastLine = stdout.trim().split(/\r?\n/u).at(-1) ?? "{}";
  const parsed = JSON.parse(lastLine);
  if (!isRecord(parsed) || !Array.isArray(parsed.argv) || !parsed.argv.every((entry) => typeof entry === "string")) {
    throw new Error("fake OMO output did not contain a string argv array");
  }
  return parsed.argv;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
