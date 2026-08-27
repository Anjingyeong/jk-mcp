import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redact } from "../policy/secrets.js";
import { resolveOmoInvocation, runOmo } from "./omo-runner.js";

describe("omo-runner", () => {
  let root: string;
  let codexHome: string;
  let previousCodexHome: string | undefined;
  let previousBin: string | undefined;
  let previousNodeCli: string | undefined;
  let previousAppData: string | undefined;
  let previousPath: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chatgpt2codex-omo-root-"));
    codexHome = await mkdtemp(join(tmpdir(), "chatgpt2codex-omo-home-"));
    previousCodexHome = process.env.CODEX_HOME;
    previousBin = process.env.CHATGPT2CODEX_OMO_BIN;
    previousNodeCli = process.env.CHATGPT2CODEX_OMO_NODE_CLI;
    previousAppData = process.env.APPDATA;
    previousPath = process.env.PATH;
    process.env.CODEX_HOME = codexHome;
    delete process.env.CHATGPT2CODEX_OMO_BIN;
    delete process.env.CHATGPT2CODEX_OMO_NODE_CLI;
  });

  afterEach(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousBin === undefined) delete process.env.CHATGPT2CODEX_OMO_BIN;
    else process.env.CHATGPT2CODEX_OMO_BIN = previousBin;
    if (previousNodeCli === undefined) delete process.env.CHATGPT2CODEX_OMO_NODE_CLI;
    else process.env.CHATGPT2CODEX_OMO_NODE_CLI = previousNodeCli;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  });

  async function installFakeCli(version: string, compatible = true): Promise<string> {
    const cli = join(codexHome, "plugins", "cache", "sisyphuslabs", "omo", version, "dist", "cli-node", "index.js");
    await mkdir(join(cli, ".."), { recursive: true });
    const help = compatible
      ? "Usage: oh-my-opencode run [options] <message> --agent --model --directory --json --verbose --session-id"
      : "Usage: oh-my-opencode run [options] <message> --directory --json";
    await writeFile(
      cli,
      [
        "const argv = process.argv.slice(2);",
        `if (argv[0] === 'run' && argv.includes('--help')) { console.log(${JSON.stringify(help)}); process.exit(0); }`,
        "console.log(JSON.stringify({ sessionId: 'ses_test', argv }));",
      ].join("\n"),
      "utf8",
    );
    return cli;
  }

  async function installFakeNativeCli(version = "5.0.0-beta.12"): Promise<string> {
    const cli = join(codexHome, "native", version, "omo.js");
    return await writeFakeNativeCli(cli);
  }

  async function installFakeGlobalNativeCli(appData: string): Promise<string> {
    const cli = join(appData, "npm", "node_modules", "omo-ai", "bin", "omo.js");
    return await writeFakeNativeCli(cli);
  }

  async function writeFakeNativeCli(cli: string): Promise<string> {
    await mkdir(join(cli, ".."), { recursive: true });
    await writeFile(
      cli,
      [
        "const argv = process.argv.slice(2);",
        "if (argv.includes('--help')) {",
        "  console.log('Usage: omo [options] [message] --mode --print --model --session-id --verbose --omo-senpi-ultrawork-disabled');",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'session', id: 'ses_native' }));",
        "console.log(JSON.stringify({ argv }));",
      ].join("\n"),
      "utf8",
    );
    return cli;
  }

  it("prefers the newest compatible Codex OMO node CLI without invoking a shell", async () => {
    await installFakeCli("4.9.0");
    const newest = await installFakeCli("4.19.4");

    const invocation = await resolveOmoInvocation();

    expect(invocation).toEqual({
      command: process.execPath,
      argsPrefix: [newest],
      source: "codex-cache",
      compatibilityStatus: "compatible",
      cliContract: "legacy-run",
      detectedVersion: "4.19.4",
      selectedVersion: "4.19.4",
      fallbackFromVersion: undefined,
      incompatibleVersions: undefined,
    });
  });

  it("falls back to the newest compatible installed OMO when a newer version breaks the CLI contract", async () => {
    await installFakeCli("4.19.4", true);
    const compatible = await installFakeCli("4.20.0", true);
    await installFakeCli("5.0.0", false);

    const invocation = await resolveOmoInvocation();

    expect(invocation.argsPrefix).toEqual([compatible]);
    expect(invocation.detectedVersion).toBe("5.0.0");
    expect(invocation.selectedVersion).toBe("4.20.0");
    expect(invocation.fallbackFromVersion).toBe("5.0.0");
    expect(invocation.incompatibleVersions).toEqual(["5.0.0"]);
    expect(invocation.compatibilityStatus).toBe("compatible");
  });

  it("rejects the installed set when no OMO version exposes JK's required run flags", async () => {
    await installFakeCli("5.0.0", false);
    await installFakeCli("4.19.4", false);

    await expect(resolveOmoInvocation()).rejects.toThrow(/none expose the required run CLI flags/i);
  });

  it.skipIf(process.platform === "win32")("reports a missing PATH OMO as unavailable instead of incompatible", async () => {
    process.env.PATH = root;

    await expect(resolveOmoInvocation()).rejects.toThrow(/could not find an OMO CLI on PATH/i);
  });

  it("passes prompt metacharacters as a literal argv value, extracts session id, and reports version status", async () => {
    await installFakeCli("4.19.4");
    const message = 'fix this && echo SHOULD_NOT_RUN | more > nope.txt';

    const result = await runOmo(root, {
      message,
      agent: "Sisyphus",
      model: "openai/gpt-test",
      sessionId: "ses_old",
      timeoutSec: 10,
    });

    expect(result.exitCode).toBe(0);
    expect(result.source).toBe("codex-cache");
    expect(result.compatibilityStatus).toBe("compatible");
    expect(result.detectedVersion).toBe("4.19.4");
    expect(result.selectedVersion).toBe("4.19.4");
    expect(result.sessionId).toBe("ses_test");
    const parsed = JSON.parse(result.stdoutSummary.trim()) as { argv: string[] };
    expect(parsed.argv).toContain("run");
    expect(parsed.argv).toContain("--json");
    expect(parsed.argv).toContain("--directory");
    expect(parsed.argv).toContain(redact(root));
    expect(parsed.argv).toContain("--agent");
    expect(parsed.argv).toContain("Sisyphus");
    expect(parsed.argv).toContain("--model");
    expect(parsed.argv).toContain("openai/gpt-test");
    expect(parsed.argv).toContain("--session-id");
    expect(parsed.argv).toContain("ses_old");
    expect(parsed.argv.at(-1)).toBe(message);
  });

  it("defaults to the general agent when no agent is specified", async () => {
    await installFakeCli("4.19.4");

    const result = await runOmo(root, {
      message: "return ok",
      timeoutSec: 10,
    });

    const parsed = JSON.parse(result.stdoutSummary.trim()) as { argv: string[] };
    expect(parsed.argv).toContain("--agent");
    expect(parsed.argv).toContain("general");
  });

  it("activates ultrawork once through the OMO Native hook", async () => {
    process.env.CHATGPT2CODEX_OMO_NODE_CLI = await installFakeNativeCli();

    const result = await runOmo(root, {
      message: "ship the verified change",
      model: "openai/gpt-test",
      sessionId: "ses_old",
      timeoutSec: 10,
      verbose: true,
      ultrawork: true,
    });

    expect(result.cliContract).toBe("native-print");
    expect(result.ultraworkRequested).toBe(true);
    expect(result.ultraworkTransport).toBe("native-hook-trigger");
    expect(result.sessionId).toBe("ses_native");
    const lastLine = result.stdoutSummary.trim().split(/\r?\n/u).at(-1);
    expect(lastLine).toBeDefined();
    const parsed = JSON.parse(lastLine ?? "{}") as { argv?: string[] };
    expect(parsed.argv).toEqual([
      "--mode",
      "json",
      "--print",
      "--model",
      "openai/gpt-test",
      "--session-id",
      "ses_old",
      "--verbose",
      "ship the verified change\n\nulw",
    ]);
    expect(parsed.argv?.at(-1)?.match(/(?:ultrawork|ulw(?!-))/giu)).toHaveLength(1);
    expect(parsed.argv?.at(-1)).not.toContain("<ultrawork-mode>");
  });

  it.each(["ulw-plan only", "mass-ulw audit", "ultraworking", "bulwark", "ulw_notes", "ulw-loop"])(
    "disables incidental native activation and preserves %s byte-for-byte",
    async (message) => {
      process.env.CHATGPT2CODEX_OMO_NODE_CLI = await installFakeNativeCli();

      const result = await runOmo(root, {
        message,
        timeoutSec: 10,
        ultrawork: false,
      });

      expect(result.ultraworkRequested).toBe(false);
      expect(result.ultraworkTransport).toBe("native-hook-disabled");
      const lastLine = result.stdoutSummary.trim().split(/\r?\n/u).at(-1);
      const parsed = JSON.parse(lastLine ?? "{}") as { argv?: string[] };
      expect(parsed.argv).toContain("--omo-senpi-ultrawork-disabled");
      expect(parsed.argv?.at(-1)).toBe(message);
    },
  );

  it.each([
    ["mass-ulw audit", "mass-ulw audit"],
    ["ulw-plan only", "ulw-plan only\n\nulw"],
  ])("adds no second native trigger to %s", async (message, expectedMessage) => {
    process.env.CHATGPT2CODEX_OMO_NODE_CLI = await installFakeNativeCli();

    const result = await runOmo(root, {
      message,
      timeoutSec: 10,
      ultrawork: true,
    });

    const lastLine = result.stdoutSummary.trim().split(/\r?\n/u).at(-1);
    const parsed = JSON.parse(lastLine ?? "{}") as { argv?: string[] };
    expect(parsed.argv?.at(-1)).toBe(expectedMessage);
    expect(parsed.argv?.at(-1)?.match(/(?:ultrawork|ulw(?!-))/giu)).toHaveLength(1);
  });

  it("does not re-arm an already injected ultrawork directive", async () => {
    process.env.CHATGPT2CODEX_OMO_NODE_CLI = await installFakeNativeCli();
    const message = "<ultrawork-mode>already armed</ultrawork-mode>\nShip it";

    const result = await runOmo(root, {
      message,
      timeoutSec: 10,
      ultrawork: true,
    });

    expect(result.ultraworkRequested).toBe(true);
    expect(result.ultraworkTransport).toBe("native-hook-disabled");
    const lastLine = result.stdoutSummary.trim().split(/\r?\n/u).at(-1);
    const parsed = JSON.parse(lastLine ?? "{}") as { argv?: string[] };
    expect(parsed.argv).toContain("--omo-senpi-ultrawork-disabled");
    expect(parsed.argv?.at(-1)).toBe(message);
  });

  it("rejects an agent selection that OMO Native cannot honor", async () => {
    process.env.CHATGPT2CODEX_OMO_NODE_CLI = await installFakeNativeCli();

    await expect(
      runOmo(root, {
        message: "ship it",
        agent: "Sisyphus",
        timeoutSec: 10,
        ultrawork: true,
      }),
    ).rejects.toThrow(/native print mode does not support selecting an agent/i);
  });

  it("discovers the shell-free global OMO Native node entry", async () => {
    process.env.APPDATA = codexHome;
    const nativeCli = await installFakeGlobalNativeCli(codexHome);

    const invocation = await resolveOmoInvocation();

    expect(invocation).toEqual({
      command: process.execPath,
      argsPrefix: [nativeCli],
      source: "native-global",
      compatibilityStatus: "compatible",
      cliContract: "native-print",
    });
  });
});
