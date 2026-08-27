import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import { buildSafeChildEnv } from "./command-runner.js";

const DEFAULT_TIMEOUT_SEC = 900;
const MAX_TIMEOUT_SEC = 3600;
const DEFAULT_AGENT = "general";
const OUTPUT_HEAD_BYTES = 16_000;
const OUTPUT_TAIL_BYTES = 8_000;
const COMPATIBILITY_PROBE_TIMEOUT_MS = 5_000;
const REQUIRED_RUN_FLAGS = ["--json", "--directory", "--agent", "--model", "--session-id", "--verbose"] as const;
const REQUIRED_NATIVE_FLAGS = [
  "--mode",
  "--print",
  "--model",
  "--session-id",
  "--verbose",
  "--omo-senpi-ultrawork-disabled",
] as const;
const NATIVE_ULTRAWORK_TRIGGER = /(?:ultrawork|ulw(?!-))/iu;
const INJECTED_ULTRAWORK_MARKER = /<ultrawork-mode>/iu;

export type OmoCliContract = "legacy-run" | "native-print";
export type UltraworkTransport =
  | "none"
  | "native-hook-disabled"
  | "native-hook-trigger"
  | "legacy-keyword-trigger";

export interface OmoRunOptions {
  message: string;
  agent?: string;
  model?: string;
  sessionId?: string;
  timeoutSec?: number;
  verbose?: boolean;
  ultrawork?: boolean;
}

interface OmoCandidate {
  version: string;
  cliPath: string;
  mtimeMs: number;
}

export interface OmoInvocation {
  command: string;
  argsPrefix: string[];
  source: "env-bin" | "env-node-cli" | "codex-cache" | "native-global" | "path";
  compatibilityStatus: "compatible";
  cliContract: OmoCliContract;
  detectedVersion?: string;
  selectedVersion?: string;
  fallbackFromVersion?: string;
  incompatibleVersions?: string[];
}

interface CompatibilityProbe {
  compatible: boolean;
  reason: string;
  cliContract?: OmoCliContract;
}

const compatibilityCache = new Map<string, { mtimeMs: number; result: CompatibilityProbe }>();

function truncateOutput(buf: Buffer): { text: string; truncated: boolean } {
  const limit = OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES;
  if (buf.length <= limit) return { text: buf.toString("utf8"), truncated: false };
  const head = buf.subarray(0, OUTPUT_HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString("utf8");
  return {
    text: `${head}\n...[truncated ${buf.length - limit} bytes]...\n${tail}`,
    truncated: true,
  };
}

function versionSortDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}

function buildOmoEnv(): NodeJS.ProcessEnv {
  const env = buildSafeChildEnv();
  for (const key of ["USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function findCodexNodeClis(): Promise<OmoCandidate[]> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const cacheRoot = path.join(codexHome, "plugins", "cache", "sisyphuslabs", "omo");
  const dirs = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  const versions = dirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(versionSortDesc);

  const candidates: OmoCandidate[] = [];
  for (const version of versions) {
    const cliPath = path.join(cacheRoot, version, "dist", "cli-node", "index.js");
    const stat = await fs.stat(cliPath).catch(() => null);
    if (stat?.isFile()) candidates.push({ version, cliPath, mtimeMs: stat.mtimeMs });
  }
  return candidates;
}

async function findGlobalNativeNodeCli(): Promise<string | undefined> {
  const appData = process.env.APPDATA;
  if (!appData) return undefined;
  const cliPath = path.join(appData, "npm", "node_modules", "omo-ai", "bin", "omo.js");
  const stat = await fs.stat(cliPath).catch(() => null);
  return stat?.isFile() ? cliPath : undefined;
}

async function probeOmoCompatibility(command: string, argsPrefix: string[]): Promise<CompatibilityProbe> {
  const runHelp = await probeHelp(command, [...argsPrefix, "run", "--help"]);
  if (runHelp !== null) {
    const missing = REQUIRED_RUN_FLAGS.filter((flag) => !runHelp.includes(flag));
    if (missing.length === 0) {
      return {
        compatible: true,
        reason: "required OMO run flags are available",
        cliContract: "legacy-run",
      };
    }
  }

  const nativeHelp = await probeHelp(command, [...argsPrefix, "--help"]);
  if (nativeHelp !== null) {
    const missing = REQUIRED_NATIVE_FLAGS.filter((flag) => !nativeHelp.includes(flag));
    if (missing.length === 0) {
      return {
        compatible: true,
        reason: "required OMO Native print flags are available",
        cliContract: "native-print",
      };
    }
    return {
      compatible: false,
      reason: `missing required native flags: ${missing.join(", ")}`,
    };
  }

  return {
    compatible: false,
    reason: "legacy and native compatibility probes exited with an error",
  };
}

async function probeHelp(command: string, args: string[]): Promise<string | null> {
  return await new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: buildOmoEnv(),
        timeout: COMPATIBILITY_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(`${stdout ?? ""}\n${stderr ?? ""}`);
      },
    );
  });
}

async function probeCandidate(candidate: OmoCandidate): Promise<CompatibilityProbe> {
  const cached = compatibilityCache.get(candidate.cliPath);
  if (cached && cached.mtimeMs === candidate.mtimeMs) return cached.result;
  const result = await probeOmoCompatibility(process.execPath, [candidate.cliPath]);
  compatibilityCache.set(candidate.cliPath, { mtimeMs: candidate.mtimeMs, result });
  return result;
}

async function requireCompatibleInvocation(
  command: string,
  argsPrefix: string[],
  source: OmoInvocation["source"],
): Promise<OmoInvocation> {
  const probe = await probeOmoCompatibility(command, argsPrefix);
  if (!probe.compatible || !probe.cliContract) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Configured OMO CLI is incompatible with JK: ${probe.reason}`);
  }
  return {
    command,
    argsPrefix,
    source,
    compatibilityStatus: "compatible",
    cliContract: probe.cliContract,
  };
}

async function findPathExecutable(command: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

export async function resolveOmoInvocation(): Promise<OmoInvocation> {
  const explicitBin = process.env.CHATGPT2CODEX_OMO_BIN;
  if (explicitBin) {
    const stat = await fs.stat(explicitBin).catch(() => null);
    if (!stat?.isFile()) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "CHATGPT2CODEX_OMO_BIN does not point to a file");
    }
    return await requireCompatibleInvocation(explicitBin, [], "env-bin");
  }

  const explicitNodeCli = process.env.CHATGPT2CODEX_OMO_NODE_CLI;
  if (explicitNodeCli) {
    const stat = await fs.stat(explicitNodeCli).catch(() => null);
    if (!stat?.isFile()) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "CHATGPT2CODEX_OMO_NODE_CLI does not point to a file");
    }
    return await requireCompatibleInvocation(process.execPath, [explicitNodeCli], "env-node-cli");
  }

  const candidates = await findCodexNodeClis();
  if (candidates.length > 0) {
    const detectedVersion = candidates[0]!.version;
    const incompatibleVersions: string[] = [];
    for (const candidate of candidates) {
      const probe = await probeCandidate(candidate);
      if (!probe.compatible || !probe.cliContract) {
        incompatibleVersions.push(candidate.version);
        continue;
      }
      return {
        command: process.execPath,
        argsPrefix: [candidate.cliPath],
        source: "codex-cache",
        compatibilityStatus: "compatible",
        cliContract: probe.cliContract,
        detectedVersion,
        selectedVersion: candidate.version,
        fallbackFromVersion: candidate.version === detectedVersion ? undefined : detectedVersion,
        incompatibleVersions: incompatibleVersions.length > 0 ? incompatibleVersions : undefined,
      };
    }

    throw new DomainError(
      ErrorCode.COMMAND_NOT_ALLOWED,
      `JK found OMO versions ${candidates.map((candidate) => candidate.version).join(", ")}, but none expose the required run CLI flags.`,
    );
  }

  const globalNativeCli = await findGlobalNativeNodeCli();
  if (globalNativeCli) {
    return await requireCompatibleInvocation(process.execPath, [globalNativeCli], "native-global");
  }

  if (process.platform === "win32") {
    throw new DomainError(
      ErrorCode.COMMAND_NOT_ALLOWED,
      "OMO runner could not find a shell-free Windows CLI. Install/update LazyCodex OMO or set CHATGPT2CODEX_OMO_NODE_CLI.",
    );
  }

  const pathOmo = await findPathExecutable("omo");
  if (!pathOmo) {
    throw new DomainError(
      ErrorCode.COMMAND_NOT_ALLOWED,
      "OMO runner could not find an OMO CLI on PATH. Install/configure OMO or set CHATGPT2CODEX_OMO_BIN/CHATGPT2CODEX_OMO_NODE_CLI before using omo_run.",
    );
  }
  return await requireCompatibleInvocation(pathOmo, [], "path");
}

function extractSessionId(stdout: string): string | undefined {
  const candidates = [stdout.trim(), ...stdout.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as {
        id?: unknown;
        sessionId?: unknown;
        session_id?: unknown;
        type?: unknown;
      };
      const value = parsed.sessionId ?? parsed.session_id ?? (parsed.type === "session" ? parsed.id : undefined);
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // OMO can emit progress lines before the final JSON object.
    }
  }
  return undefined;
}

export async function runOmo(
  root: string,
  options: OmoRunOptions,
): Promise<{
  cwd: string;
  source: OmoInvocation["source"];
  compatibilityStatus: OmoInvocation["compatibilityStatus"];
  cliContract: OmoCliContract;
  ultraworkRequested: boolean;
  ultraworkTransport: UltraworkTransport;
  detectedVersion?: string;
  selectedVersion?: string;
  fallbackFromVersion?: string;
  incompatibleVersions?: string[];
  exitCode: number;
  stdoutSummary: string;
  stderrSummary: string;
  sessionId?: string;
  durationMs: number;
  outputTruncated: boolean;
}> {
  const baseRoot = await fs.realpath(root);
  const invocation = await resolveOmoInvocation();
  const ultraworkRequested = options.ultrawork === true;
  const alreadyInjected = INJECTED_ULTRAWORK_MARKER.test(options.message);
  const nativeHookRequested = ultraworkRequested && !alreadyInjected;
  const effectiveMessage =
    nativeHookRequested && !NATIVE_ULTRAWORK_TRIGGER.test(options.message)
      ? `${options.message}\n\nulw`
      : options.message;
  const args = [...invocation.argsPrefix];
  let ultraworkTransport: UltraworkTransport;
  if (invocation.cliContract === "legacy-run") {
    args.push("run", "--json", "--directory", baseRoot);
    args.push("--agent", options.agent ?? DEFAULT_AGENT);
    if (options.model) args.push("--model", options.model);
    if (options.sessionId) args.push("--session-id", options.sessionId);
    if (options.verbose) args.push("--verbose");
    ultraworkTransport = nativeHookRequested ? "legacy-keyword-trigger" : "none";
  } else {
    if (options.agent) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "OMO Native print mode does not support selecting an agent");
    }
    args.push("--mode", "json", "--print");
    if (options.model) args.push("--model", options.model);
    if (options.sessionId) args.push("--session-id", options.sessionId);
    if (options.verbose) args.push("--verbose");
    if (!nativeHookRequested) args.push("--omo-senpi-ultrawork-disabled");
    ultraworkTransport = nativeHookRequested ? "native-hook-trigger" : "native-hook-disabled";
  }
  args.push(effectiveMessage);

  const effectiveTimeoutSec = Math.min(Math.max(options.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      args,
      {
        cwd: baseRoot,
        env: buildOmoEnv(),
        timeout: effectiveTimeoutSec * 1000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          reject(new DomainError(ErrorCode.TIMEOUT, `OMO run timed out after ${effectiveTimeoutSec}s`));
          return;
        }

        const outStd = truncateOutput(Buffer.from(stdout ?? "", "utf8"));
        const outErr = truncateOutput(Buffer.from(stderr ?? "", "utf8"));
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        const redactedStdout = redact(outStd.text);

        resolve({
          cwd: ".",
          source: invocation.source,
          compatibilityStatus: invocation.compatibilityStatus,
          cliContract: invocation.cliContract,
          ultraworkRequested,
          ultraworkTransport,
          detectedVersion: invocation.detectedVersion,
          selectedVersion: invocation.selectedVersion,
          fallbackFromVersion: invocation.fallbackFromVersion,
          incompatibleVersions: invocation.incompatibleVersions,
          exitCode,
          stdoutSummary: redactedStdout,
          stderrSummary: redact(outErr.text),
          sessionId: extractSessionId(redactedStdout),
          durationMs,
          outputTruncated: outStd.truncated || outErr.truncated,
        });
      },
    );
  });
}
