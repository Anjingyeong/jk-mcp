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

export interface OmoRunOptions {
  message: string;
  agent?: string;
  model?: string;
  sessionId?: string;
  timeoutSec?: number;
  verbose?: boolean;
}

interface OmoCandidate {
  version: string;
  cliPath: string;
  mtimeMs: number;
}

export interface OmoInvocation {
  command: string;
  argsPrefix: string[];
  source: "env-bin" | "env-node-cli" | "codex-cache" | "path";
  compatibilityStatus: "compatible";
  detectedVersion?: string;
  selectedVersion?: string;
  fallbackFromVersion?: string;
  incompatibleVersions?: string[];
}

interface CompatibilityProbe {
  compatible: boolean;
  reason: string;
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
  for (const key of ["USERPROFILE", "HOMEDRIVE", "HOMEPATH", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
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

async function probeOmoCompatibility(command: string, argsPrefix: string[]): Promise<CompatibilityProbe> {
  return await new Promise((resolve) => {
    execFile(
      command,
      [...argsPrefix, "run", "--help"],
      {
        env: buildOmoEnv(),
        timeout: COMPATIBILITY_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const killed = Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed);
          resolve({ compatible: false, reason: killed ? "compatibility probe timed out" : "run --help exited with an error" });
          return;
        }

        const help = `${stdout ?? ""}\n${stderr ?? ""}`;
        const missing = REQUIRED_RUN_FLAGS.filter((flag) => !help.includes(flag));
        if (missing.length > 0) {
          resolve({ compatible: false, reason: `missing required run flags: ${missing.join(", ")}` });
          return;
        }
        resolve({ compatible: true, reason: "required OMO run flags are available" });
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
  if (!probe.compatible) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Configured OMO CLI is incompatible with JK: ${probe.reason}`);
  }
  return { command, argsPrefix, source, compatibilityStatus: "compatible" };
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
      if (!probe.compatible) {
        incompatibleVersions.push(candidate.version);
        continue;
      }
      return {
        command: process.execPath,
        argsPrefix: [candidate.cliPath],
        source: "codex-cache",
        compatibilityStatus: "compatible",
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

  if (process.platform === "win32") {
    throw new DomainError(
      ErrorCode.COMMAND_NOT_ALLOWED,
      "OMO runner could not find a shell-free Windows CLI. Install/update LazyCodex OMO or set CHATGPT2CODEX_OMO_NODE_CLI.",
    );
  }

  return await requireCompatibleInvocation("omo", [], "path");
}

function extractSessionId(stdout: string): string | undefined {
  const candidates = [stdout.trim(), ...stdout.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as { sessionId?: unknown; session_id?: unknown };
      const value = parsed.sessionId ?? parsed.session_id;
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
  const args = [...invocation.argsPrefix, "run", "--json", "--directory", baseRoot];
  args.push("--agent", options.agent ?? DEFAULT_AGENT);
  if (options.model) args.push("--model", options.model);
  if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.verbose) args.push("--verbose");
  args.push(options.message);

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
