import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import { resolveInProject } from "../policy/paths.js";
import { buildSafeChildEnv } from "./command-runner.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 900;
const OUTPUT_HEAD_BYTES = 12_000;
const OUTPUT_TAIL_BYTES = 6_000;
const READ_ONLY_SCOPE_TTL_MS = 15 * 60 * 1000;

const SECRET_COMMAND_PATTERNS = [
  /(^|[\s/"'])\.env([\s/"'.]|$)/i,
  /(^|[\s/"'])\.ssh([\s/"']|$)/i,
  /(^|[\s/"'])\.npmrc([\s/"']|$)/i,
  /id_rsa|id_ed25519|private[_-]?key/i,
  /security\s+find-(generic|internet)-password/i,
  /keychain/i,
  /(^|[\s/"'])\.netrc([\s/"'.]|$)/i,
  /(^|[\s/"'])\.git-credentials([\s/"']|$)/i,
  /(^|[\s/"'])\.aws([\s/"']|$)/i,
  /(^|[\s/"'])\.gnupg([\s/"']|$)/i,
  /(^|[\s/"'])\.docker([\s/"']|$)/i,
  /(^|[\s/"'])\.kube([\s/"']|$)/i,
  /(^|[\s/"'])\.config[/\\]gcloud([\s/"']|$)/i,
  /(^|[\s/"'])credentials([\s/"'.]|$)/i,
];

const APPROVABLE_DESTRUCTIVE_PATTERNS = [
  /\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b/i,
  /\bfind\b[^\n]*-delete\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f\b|--delete\b|--mirror\b|\s\+\S)/i,
  /\bcrontab\b(?!\s+-l\b)/i,
  /\bRemove-Item\b/i,
  /\b(del|erase|rmdir|rd)\b/i,
  /\b(kill|pkill|killall)\b/i,
  /\bsystemctl\s+(restart|stop|start|reload|reload-or-restart|try-restart|kill)\b/i,
  /\baws(?:\.exe)?\b[^\n]*\bec2\b[^\n]*\b(run-instances|terminate-instances|authorize-security-group-ingress|create-nat-gateway|allocate-address)\b/i,
  /\baws(?:\.exe)?\b[^\n]*\biam\b[^\n]*\b(create-access-key|delete-access-key|create-login-profile|update-login-profile)\b/i,
  /\baws(?:\.exe)?\b[^\n]*\bfreetier\b[^\n]*\b(upgrade-account-plan|update-account-plan|put-account-plan)\b/i,
  /\boci\b[^\n]*\bcompute\s+instance\s+(launch|terminate|update)\b/i,
  /\boci\b[^\n]*\bbv\s+(volume|boot-volume)\s+(create|delete|update)\b/i,
  /\boci\b[^\n]*\bnetwork\b[^\n]*\b(create|delete|update)\b/i,
  /\boci\b[^\n]*\bbudgets?\b[^\n]*\b(create|delete|update)\b/i,
];

// Zero-charge mode: commands that can increase OCI billable capacity are not
// merely approval-gated. They are rejected even with a destructive/network
// grant so JK cannot accidentally provision or scale paid resources.
const HARD_BLOCKED_CLOUD_COST_PATTERNS = [
  /\boci\b[^\n]*\bcompute\s+instance\s+(launch|update)\b/i,
  /\boci\b[^\n]*\bbv\s+(volume|boot-volume)\s+create\b/i,
  /\boci\b[^\n]*\bnetwork\b[^\n]*\bcreate\b/i,
  /\boci\b[^\n]*\b(load-balancer|network-load-balancer)\b[^\n]*\bcreate\b/i,
  /\boci\b[^\n]*\bcontainer-instances\b[^\n]*\bcreate\b/i,
  /\boci\b[^\n]*\bcompute\s+capacity-reservation\s+(create|update)\b/i,
];

const HARD_BLOCKED_OS_PATTERNS = [
  /\bsudo\b/i,
  // Redirecting into a block/char device (disk overwrite risk) — but not
  // `> /dev/null`, which is a common, harmless "discard output" idiom.
  />\s*\/dev\/(?!null\b)\S+/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\bdiskutil\s+erase/i,
  /\bmkfs\b/i,
  /\bshutdown\b|\breboot\b/i,
];

const NETWORK_COMMAND_PATTERNS = [
  /\b(curl|wget|nc|ncat|netcat|telnet|scp|sftp|ftp|ssh)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|update)\b/i,
  /\bgit\s+(pull|fetch|clone|push)\b/i,
  /(^|[\s"'\\/])aws(?:\.exe)?(?=[\s"']|$)/i,
  /(^|[\s"'\\/])oci(?=[\s"']|$)/i,
  /\bInvoke-(WebRequest|RestMethod)\b/i,
];

const AUTONOMOUS_DEVELOPMENT_NETWORK_PATTERNS = [
  /^\s*(npm|pnpm|yarn|bun)\s+(install|add|update)\b/i,
  /^\s*git\s+(pull|fetch|clone)\b/i,
];

const TRUSTED_OWNER_NETWORK_BLOCK_PATTERNS = [
  /\bgit\s+push\b/i,
  /\b(ssh|scp|sftp|ftp|nc|ncat|netcat|telnet|wget)\b/i,
  /\bInvoke-(WebRequest|RestMethod)\b/i,
  /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f\b|--delete\b|--mirror\b|\s\+\S)/i,
  /(^|[\s"'\\/])aws(?:\.exe)?(?=[\s"']|$)/i,
  /(^|[\s"'\\/])oci(?=[\s"']|$)/i,
  /\b(curl|curl\.exe)\b[^\n]*(?:\s-d\b|\s--data(?:-[a-z-]+)?\b|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request\s+(?:POST|PUT|PATCH|DELETE)\b)/i,
  /\b(npm|pnpm|yarn|bun)\b[^\n]*(?:\s-g\b|\s--global\b|--location\s*=?\s*global\b)/i,
  /\b(?:python(?:3(?:\.\d+)?)?|node|deno)\s+(?:-c|-e|--eval)\b/i,
];

const AWS_READ_ONLY_OPERATIONS: Record<string, RegExp> = {
  sts: /^get-caller-identity$/,
  ec2: /^describe-/,
  elb: /^describe-/,
  elbv2: /^describe-/,
  rds: /^describe-/,
  efs: /^describe-/,
  elasticache: /^describe-/,
  autoscaling: /^describe-/,
  ecs: /^(list-|describe-)/,
  eks: /^(list-|describe-)/,
  ecr: /^(describe-repositories|list-images)$/,
  lambda: /^list-functions$/,
  dynamodb: /^(list-tables|describe-table)$/,
  s3api: /^(list-buckets|get-bucket-location|list-objects-v2)$/,
  lightsail: /^get-(instances|disks|static-ips|load-balancers)$/,
  opensearch: /^(list-domain-names|describe-domain)$/,
  route53: /^(list-hosted-zones|get-hosted-zone|list-resource-record-sets)$/,
  freetier: /^(get-|list-)/,
  ce: /^get-/,
  pricing: /^get-/,
  account: /^(get-|list-)/,
  "service-quotas": /^(get-|list-)/,
  "resource-groups-tagging-api": /^get-/,
  cloudformation: /^(describe-|list-|get-template(?:-summary)?$)/,
  iam: /^(get-account-summary|get-role|get-instance-profile|list-(roles|instance-profiles|policies|account-aliases|mfa-devices))$/,
};

const AWS_SCOPE_BLOCKED_ARGUMENTS = [
  /^--endpoint-url$/i,
  /^--no-verify-ssl$/i,
  /^--ca-bundle$/i,
  /^--cli-input-(json|yaml)$/i,
  /^--debug$/i,
];

const OCI_SCOPE_BLOCKED_ARGUMENTS = [
  /^--endpoint$/i,
  /^--config-file$/i,
  /^--cert-bundle$/i,
  /^--auth$/i,
  /^--debug$/i,
];

const CURL_SAFE_FLAGS = new Set([
  "-s",
  "-S",
  "-f",
  "-L",
  "-I",
  "--silent",
  "--show-error",
  "--fail",
  "--location",
  "--head",
  "--compressed",
]);

const CURL_SAFE_VALUE_FLAGS = new Set(["--max-time", "--connect-timeout"]);

export interface ReadOnlyNetworkApprovalScope {
  key: string;
  label: string;
  ttlMs: number;
}

function splitTopLevelConjunctions(command: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "&") {
      if (command[index + 1] !== "&") return null;
      if (!current.trim()) return null;
      parts.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (char === "|" || char === ";" || char === ">" || char === "<" || char === "\n" || char === "\r") {
      return null;
    }
    current += char;
  }
  if (quote || !current.trim()) return null;
  parts.push(current.trim());
  return parts;
}

function tokenizeShellSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const flush = () => {
    if (!current) return;
    tokens.push(current);
    current = "";
  };

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  if (quote) return null;
  flush();
  return tokens.length ? tokens : null;
}

function executableName(token: string): string {
  return token.split(/[\\/]/).pop()?.toLowerCase() ?? token.toLowerCase();
}

function executesJkReloadScript(command: string): boolean {
  const segments = splitTopLevelConjunctions(command);
  if (!segments?.length) return false;

  return segments.some((segment) => {
    const tokens = tokenizeShellSegment(segment);
    if (!tokens?.length) return false;
    const executable = executableName(tokens[0]!);
    if (executable === "reload-jk-runtime.sh") return true;
    if ((executable === "bash" || executable === "sh") && tokens[1]) {
      return executableName(tokens[1]) === "reload-jk-runtime.sh";
    }
    return false;
  });
}

export function isJkMaintenanceCommand(command: string): boolean {
  return executesJkReloadScript(command);
}

function containsShellInterpolation(token: string): boolean {
  return /\$\(|\$\{|`|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!/.test(token);
}

function isSafeAwsReadOnlySegment(segment: string): boolean {
  const tokens = tokenizeShellSegment(segment);
  if (!tokens || tokens.length < 3) return false;
  const executable = executableName(tokens[0]!);
  if (executable !== "aws" && executable !== "aws.exe") return false;

  const service = tokens[1]!.toLowerCase();
  const operation = tokens[2]!.toLowerCase();
  const allowedOperation = AWS_READ_ONLY_OPERATIONS[service];
  if (!allowedOperation?.test(operation)) return false;

  const args = tokens.slice(3);
  if (args.some((token) => containsShellInterpolation(token) || token.startsWith("file://") || token.startsWith("fileb://") || token.startsWith("@"))) {
    return false;
  }
  for (let index = 0; index < args.length; index += 1) {
    if (AWS_SCOPE_BLOCKED_ARGUMENTS.some((pattern) => pattern.test(args[index]!))) return false;
  }
  return true;
}

function isSafeOciReadOnlySegment(segment: string): boolean {
  const tokens = tokenizeShellSegment(segment);
  if (!tokens || tokens.length < 4) return false;
  if (executableName(tokens[0]!) !== "oci") return false;

  const operation = tokens[3]!.toLowerCase();
  if (operation !== "list" && operation !== "get") return false;

  const args = tokens.slice(4);
  if (args.some((token) => containsShellInterpolation(token) || token.startsWith("file://") || token.startsWith("fileb://") || token.startsWith("@"))) {
    return false;
  }
  if (args.some((token) => OCI_SCOPE_BLOCKED_ARGUMENTS.some((pattern) => pattern.test(token)))) return false;
  return true;
}

/**
 * Cloud inventory reads that the server itself can prove are read-only may
 * run without a human approval round-trip. Arbitrary HTTP reads and every
 * cloud mutation/credential operation stay outside this path.
 */
export function isAutonomousCloudInventoryRead(command: string): boolean {
  const segments = splitTopLevelConjunctions(command);
  if (!segments?.length) return false;
  return segments.every((segment) => isSafeAwsReadOnlySegment(segment) || isSafeOciReadOnlySegment(segment));
}

function safeCurlReadScope(segment: string): ReadOnlyNetworkApprovalScope | null {
  const tokens = tokenizeShellSegment(segment);
  if (!tokens?.length) return null;
  const executable = executableName(tokens[0]!);
  if (executable !== "curl" && executable !== "curl.exe") return null;

  let urlToken: string | null = null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (containsShellInterpolation(token)) return null;
    if (CURL_SAFE_FLAGS.has(token)) continue;
    if (/^-[sSfLI]+$/.test(token)) continue;
    if (CURL_SAFE_VALUE_FLAGS.has(token)) {
      const value = tokens[index + 1];
      if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
      index += 1;
      continue;
    }
    if (token === "-X" || token === "--request") {
      const method = tokens[index + 1]?.toUpperCase();
      if (method !== "GET" && method !== "HEAD") return null;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return null;
    if (urlToken) return null;
    urlToken = token;
  }

  if (!urlToken) return null;
  try {
    const url = new URL(urlToken);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const origin = url.origin.toLowerCase();
    return {
      key: `network-read:http:${origin}`,
      label: `HTTP read-only · ${origin}`,
      ttlMs: READ_ONLY_SCOPE_TTL_MS,
    };
  } catch {
    return null;
  }
}

/**
 * Returns a short-lived reusable approval scope only for server-verified,
 * read-only network command families. Anything ambiguous falls back to the
 * existing exact-command, one-shot approval path.
 */
export function classifyReadOnlyNetworkApprovalScope(command: string): ReadOnlyNetworkApprovalScope | null {
  const segments = splitTopLevelConjunctions(command);
  if (!segments?.length) return null;
  if (segments.every(isSafeAwsReadOnlySegment)) {
    return {
      key: "network-read:aws-inventory",
      label: "AWS read-only inventory",
      ttlMs: READ_ONLY_SCOPE_TTL_MS,
    };
  }
  if (segments.every(isSafeOciReadOnlySegment)) {
    return {
      key: "network-read:oci-inventory",
      label: "OCI read-only inventory",
      ttlMs: READ_ONLY_SCOPE_TTL_MS,
    };
  }
  if (segments.length === 1) return safeCurlReadScope(segments[0]!);
  return null;
}

function truncateOutput(buf: Buffer): { text: string; truncated: boolean } {
  const limit = OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES;
  if (buf.length <= limit) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  const head = buf.subarray(0, OUTPUT_HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString("utf8");
  return {
    text: `${head}\n...[truncated ${buf.length - limit} bytes]...\n${tail}`,
    truncated: true,
  };
}

export interface ShellCommandRisk {
  needsNetwork: boolean;
  destructive: boolean;
}

export function inspectShellCommand(command: string): ShellCommandRisk {
  for (const pattern of SECRET_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new DomainError(
        ErrorCode.SECRET_BLOCKED,
        "local_shell_run blocked a command that appears to read secret-classified material",
      );
    }
  }
  for (const pattern of HARD_BLOCKED_CLOUD_COST_PATTERNS) {
    if (pattern.test(command)) {
      throw new DomainError(
        ErrorCode.PERMISSION_DENIED,
        "local_shell_run blocked an OCI capacity-increasing command in zero-charge mode",
      );
    }
  }
  for (const pattern of HARD_BLOCKED_OS_PATTERNS) {
    if (pattern.test(command)) {
      throw new DomainError(
        ErrorCode.PERMISSION_DENIED,
        "local_shell_run blocked an OS-level command that is never approvable",
      );
    }
  }
  return {
    destructive: executesJkReloadScript(command) || APPROVABLE_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)),
    needsNetwork: NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(command)),
  };
}

/**
 * Narrow allowlist for ordinary project-development network work. This does
 * not include arbitrary HTTP/SSH egress or git push; those stay approval- or
 * dedicated-tool-gated. Chained commands must all belong to the safe family.
 */
export function isAutonomousDevelopmentNetworkCommand(command: string): boolean {
  const segments = splitTopLevelConjunctions(command);
  if (!segments?.length) return false;
  return segments.every((segment) => AUTONOMOUS_DEVELOPMENT_NETWORK_PATTERNS.some((pattern) => pattern.test(segment)));
}

export function isTrustedOwnerRoutineNetworkCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (TRUSTED_OWNER_NETWORK_BLOCK_PATTERNS.some((pattern) => pattern.test(command))) return false;
  if (/\bgit\s+push\b/i.test(command)) return true;
  if (/\b(curl|curl\.exe)\b/i.test(command)) return true;
  if (AUTONOMOUS_DEVELOPMENT_NETWORK_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return /(?:^|[\s;&\n])(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:python(?:3(?:\.\d+)?)?|node|npm|pnpm|yarn|bun|\.\/[^\s]+|bash\s+\.\/[^\s]+|sh\s+\.\/[^\s]+)/im.test(command);
}

export function guardShellCommand(
  command: string,
  approved: { needsNetwork?: boolean; destructive?: boolean } = {},
): ShellCommandRisk {
  const risk = inspectShellCommand(command);
  if (risk.destructive && !approved.destructive) {
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      "local_shell_run blocked a destructive command that requires explicit approval",
    );
  }
  if (risk.needsNetwork && !approved.needsNetwork) {
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      "local_shell_run blocked a network/egress command that requires explicit approval",
    );
  }
  return risk;
}

export async function runLocalShell(
  root: string,
  command: string,
  cwd?: string,
  timeoutSec?: number,
  approved?: { needsNetwork?: boolean; destructive?: boolean },
): Promise<{
  cwd: string;
  exitCode: number;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
  outputTruncated: boolean;
}> {
  guardShellCommand(command, approved);

  const baseRoot = await fs.realpath(root);
  const commandCwd = cwd
    ? await resolveInProject(baseRoot, cwd, { allowSymlink: false })
    : baseRoot;
  const stat = await fs.stat(commandCwd).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "cwd is not a project directory", {
      cwd,
    });
  }

  const requestedTimeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const effectiveTimeoutSec = Math.min(Math.max(requestedTimeout, 1), MAX_TIMEOUT_SEC);
  const start = Date.now();

  return await new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: commandCwd,
        env: buildSafeChildEnv(),
        timeout: effectiveTimeoutSec * 1000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const stdoutBuf = Buffer.from(stdout ?? "", "utf8");
        const stderrBuf = Buffer.from(stderr ?? "", "utf8");

        if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          reject(
            new DomainError(ErrorCode.TIMEOUT, `local shell command timed out after ${effectiveTimeoutSec}s`, {
              timeoutSec: effectiveTimeoutSec,
            }),
          );
          return;
        }

        const outStd = truncateOutput(stdoutBuf);
        const outErr = truncateOutput(stderrBuf);
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;

        resolve({
          cwd: path.relative(baseRoot, commandCwd) || ".",
          exitCode,
          stdoutSummary: redact(outStd.text),
          stderrSummary: redact(outErr.text),
          durationMs,
          outputTruncated: outStd.truncated || outErr.truncated,
        });
      },
    );
  });
}
