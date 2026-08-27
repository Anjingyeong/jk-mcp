import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOmo } from "../src/exec/omo-runner.js";

const base = await mkdtemp(path.join(tmpdir(), "jk-omo-ulw-runner-"));
const projectRoot = path.join(base, "project");
const appData = path.join(base, "appdata");
const codexHome = path.join(base, "codex");
const nativeCli = path.join(appData, "npm", "node_modules", "omo-ai", "bin", "omo.js");
const previousAppData = process.env.APPDATA;
const previousCodexHome = process.env.CODEX_HOME;
const previousBin = process.env.CHATGPT2CODEX_OMO_BIN;
const previousNodeCli = process.env.CHATGPT2CODEX_OMO_NODE_CLI;
let report: Record<string, unknown> = { pass: false };

try {
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(path.dirname(nativeCli), { recursive: true }),
  ]);
  await writeFile(
    nativeCli,
    [
      "const argv = process.argv.slice(2);",
      "if (argv.includes('--help')) {",
      "  console.log('Usage: omo [options] [message] --mode --print --model --session-id --verbose --omo-senpi-ultrawork-disabled');",
      "  process.exit(0);",
      "}",
      "console.log(JSON.stringify({ type: 'session', id: 'ses_runner_native' }));",
      "console.log(JSON.stringify({ argv }));",
    ].join("\n"),
    "utf8",
  );

  process.env.APPDATA = appData;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CHATGPT2CODEX_OMO_BIN;
  delete process.env.CHATGPT2CODEX_OMO_NODE_CLI;

  const happy = await runOmo(projectRoot, {
    message: "ship through direct runner",
    model: "openai/gpt-test",
    sessionId: "ses_old",
    timeoutSec: 10,
    verbose: true,
    ultrawork: true,
  });
  const normalMessage = "mass-ulw remains literal data";
  const normal = await runOmo(projectRoot, {
    message: normalMessage,
    timeoutSec: 10,
    ultrawork: false,
  });
  const existingTriggerMessage = "mass-ulw audit";
  const existingTrigger = await runOmo(projectRoot, {
    message: existingTriggerMessage,
    timeoutSec: 10,
    ultrawork: true,
  });
  const planMessage = "ulw-plan only";
  const plan = await runOmo(projectRoot, {
    message: planMessage,
    timeoutSec: 10,
    ultrawork: true,
  });
  const prearmedMessage = "<ultrawork-mode>already armed</ultrawork-mode>\nShip it";
  const prearmed = await runOmo(projectRoot, {
    message: prearmedMessage,
    timeoutSec: 10,
    ultrawork: true,
  });

  const happyArgv = parseArgv(happy.stdoutSummary);
  const normalArgv = parseArgv(normal.stdoutSummary);
  const existingTriggerArgv = parseArgv(existingTrigger.stdoutSummary);
  const planArgv = parseArgv(plan.stdoutSummary);
  const prearmedArgv = parseArgv(prearmed.stdoutSummary);
  const happyChecks = {
    nativeGlobal: happy.source === "native-global",
    nativeContract: happy.cliContract === "native-print",
    nativeSession: happy.sessionId === "ses_runner_native",
    triggerTransport: happy.ultraworkTransport === "native-hook-trigger",
    oneTrigger: (happyArgv.at(-1)?.match(/(?:ultrawork|ulw(?!-))/giu) ?? []).length === 1,
    expectedMessage: happyArgv.at(-1) === "ship through direct runner\n\nulw",
    noCopiedDirective: !happyArgv.some((arg) => arg.includes("<ultrawork-mode>")),
  };
  const edgeChecks = {
    normalDisabled: normal.ultraworkTransport === "native-hook-disabled",
    normalDisableFlag: normalArgv.includes("--omo-senpi-ultrawork-disabled"),
    normalBytes: normalArgv.at(-1) === normalMessage,
    existingTriggerUnchanged: existingTriggerArgv.at(-1) === existingTriggerMessage,
    existingTriggerCount:
      (existingTriggerArgv.at(-1)?.match(/(?:ultrawork|ulw(?!-))/giu) ?? []).length === 1,
    planGetsTrigger: planArgv.at(-1) === `${planMessage}\n\nulw`,
    prearmedDisabled: prearmed.ultraworkTransport === "native-hook-disabled",
    prearmedDisableFlag: prearmedArgv.includes("--omo-senpi-ultrawork-disabled"),
    prearmedBytes: prearmedArgv.at(-1) === prearmedMessage,
  };
  report = {
    pass: Object.values(happyChecks).every(Boolean) && Object.values(edgeChecks).every(Boolean),
    happy: {
      pass: Object.values(happyChecks).every(Boolean),
      checks: happyChecks,
      source: happy.source,
      cliContract: happy.cliContract,
      sessionId: happy.sessionId,
      ultraworkRequested: happy.ultraworkRequested,
      ultraworkTransport: happy.ultraworkTransport,
      argv: happyArgv,
    },
    edge: {
      pass: Object.values(edgeChecks).every(Boolean),
      checks: edgeChecks,
      normal: { transport: normal.ultraworkTransport, argv: normalArgv },
      existingTrigger: { transport: existingTrigger.ultraworkTransport, argv: existingTriggerArgv },
      plan: { transport: plan.ultraworkTransport, argv: planArgv },
      prearmed: { transport: prearmed.ultraworkTransport, argv: prearmedArgv },
    },
  };
} catch (error) {
  report = {
    pass: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
} finally {
  restoreEnv("APPDATA", previousAppData);
  restoreEnv("CODEX_HOME", previousCodexHome);
  restoreEnv("CHATGPT2CODEX_OMO_BIN", previousBin);
  restoreEnv("CHATGPT2CODEX_OMO_NODE_CLI", previousNodeCli);
  await rm(base, { recursive: true, force: true });
  const tempRemoved = (await stat(base).catch(() => null)) === null;
  report = {
    ...report,
    pass: report.pass === true && tempRemoved,
    cleanup: { tempRemoved, removedPath: base, environmentRestored: true },
  };
}

console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;

function parseArgv(stdout: string): string[] {
  const lastLine = stdout.trim().split(/\r?\n/u).at(-1) ?? "{}";
  const parsed = JSON.parse(lastLine) as { argv?: unknown };
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((entry) => typeof entry === "string")) {
    throw new Error("fake OMO output did not contain a string argv array");
  }
  return parsed.argv;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
