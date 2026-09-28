#!/usr/bin/env node
/**
 * jk CLI entrypoint.
 *
 * Minimal hand-rolled argv parsing (no commander dependency) for the three
 * MVP subcommands defined in PRD §5:
 *
 *   jk serve  --workspace <path>
 *   jk init   --workspace <path>
 *   jk doctor
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config, LeasePreset, ProjectRegistryEntry, ToolContext } from "./types.js";
import { findProject, scanWorkspace, scanWorkspaceWithRuntimeSelf } from "./workspace/registry.js";
import { makeLease } from "./workspace/project-select.js";
import { Store } from "./state/store.js";
import { Ledger } from "./state/ledger.js";
import { createServer } from "./server/mcp-server.js";
import { createHttpServer, defaultHttpServerConfig } from "./server/http.js";
import { generateOwnerToken, hasOwnerToken, storeOwnerToken } from "./auth/owner-token.js";
import { JsonOAuthStore } from "./auth/oauth-store.js";
import { checkIntakeAvailability } from "./assets/image-intake.js";
import { controlAllowlist, isAppAllowed, isControlEnabled, isSensitiveApp } from "./control/policy.js";
import { startExecutor } from "./control/executor.js";
import { approveAction, isKilled, listActions, rejectAction, setKill, toSummary } from "./control/queue.js";
import { preflightPermissions } from "./control/mac-input.js";
import { clampMinutes, clearAuto, readAuto, setAuto, type AutoActionKind } from "./control/auto.js";
import { readExecutorToken, runExecutorWorker } from "./executors/worker.js";
import { SETUP_COMMAND, formatSetupReady, normalizeSetupPublicUrl, type HttpReadyInfo } from "./cli-setup.js";

const execFileAsync = promisify(execFile);
const USAGE =
  "usage: jk <setup|start|serve|init|doctor|owner-token|control|executor> [--workspace <path>] " +
  "[--active-project-root <path>] [--stdio | --http [--port 7979] [--public-url <origin>]]\n" +
  "  jk setup  [--workspace <path>] [--quick-tunnel | --public-url <origin>] [--reset-code] [--no-start]\n" +
  "  jk start  [--quick-tunnel | --public-url <origin>] [--port 7979]";

interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
  /** Non-flag arguments after the command, e.g. `control approve <actionId>`. */
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

/** Select one state directory; never move or merge existing installations. */
function defaultStateDir(): string {
  // Portable/override mode: lets sandboxed runs, USB-portable installs, and
  // multi-instance setups redirect all state without touching $HOME.
  const override = process.env.JK_STATE_DIR?.trim() || process.env.CHATGPT2CODEX_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const canonical = path.join(os.homedir(), ".local", "share", "jk");
  const legacy = path.join(os.homedir(), ".local", "share", "chatgpt2codex");
  return existsSync(canonical) ? canonical : existsSync(legacy) ? legacy : canonical;
}

/**
 * `jk setup` remembers the allowed folder (and an optional fixed HTTPS origin)
 * so the next `jk setup` / `jk start` needs no answers. No secrets live here:
 * the Owner Token is stored only as a hash by owner-token.ts.
 */
interface SavedSetupConfig {
  workspaceRoot: string;
  publicUrl?: string;
}

function setupConfigPath(stateDir = defaultStateDir()): string {
  return path.join(stateDir, "setup.json");
}

async function saveSetupConfig(workspaceRoot: string, publicUrl?: string): Promise<void> {
  const stateDir = defaultStateDir();
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const saved: SavedSetupConfig = publicUrl ? { workspaceRoot, publicUrl } : { workspaceRoot };
  await fs.writeFile(setupConfigPath(stateDir), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
}

async function loadSavedSetupConfig(): Promise<SavedSetupConfig | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(setupConfigPath(), "utf8")) as SavedSetupConfig;
    if (!parsed || typeof parsed.workspaceRoot !== "string" || !parsed.workspaceRoot.trim()) {
      throw new Error("JK's saved setup is invalid. Run `jk setup` again.");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function loadSetupWorkspace(): Promise<string | undefined> {
  const parsed = await loadSavedSetupConfig();
  if (!parsed) return undefined;
  const workspaceRoot = path.resolve(parsed.workspaceRoot);
  const stat = await fs.stat(workspaceRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`The saved JK folder no longer exists: ${workspaceRoot}. Run \`jk setup\` again.`);
  }
  return workspaceRoot;
}

async function loadSetupPublicUrl(): Promise<string | undefined> {
  const value = (await loadSavedSetupConfig())?.publicUrl;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveRuntimeWorkspace(flags: Record<string, string | boolean>): Promise<string> {
  if (typeof flags.workspace === "string") return flags.workspace;
  return (await loadSetupWorkspace()) ?? process.cwd();
}

function defaultConfig(workspaceRoot: string, stateDir: string): Config {
  return {
    workspaceRoot,
    stateDir,
    maxReadBytes: 10 * 1024 * 1024,
    maxPatchBytes: 10 * 1024 * 1024,
    defaultCommandTimeoutSec: 30,
    defaultLeaseTtlMs: 30 * 60 * 1000,
  };
}

async function buildToolContext(workspace: string): Promise<ToolContext> {
  const workspaceRoot = path.resolve(workspace);
  const stateDir = defaultStateDir();

  const store = new Store(stateDir);
  const ledger = new Ledger(stateDir);

  const registry = await scanWorkspaceWithRuntimeSelf(workspaceRoot);
  await store.saveProjects(registry);

  const config = defaultConfig(workspaceRoot, stateDir);

  return {
    workspaceRoot,
    stateDir,
    registry,
    ledger: { append: (event) => ledger.append(event) },
    store: {
      loadProjects: () => store.loadProjects(),
      saveProjects: (p) => store.saveProjects(p),
      getSession: () => store.getSession(),
      setSession: (s) => store.setSession(s),
      updateSession: (mutator) => store.updateSession(mutator),
    },
    config,
  };
}

function parseLeasePreset(value: string | boolean | undefined): LeasePreset {
  if (
    value === "read-only" ||
    value === "tests-only" ||
    value === "full-write" ||
    value === "image-only" ||
    value === "control"
  ) {
    return value;
  }
  return "full-write";
}

async function applyStartupProjectSelection(ctx: ToolContext, flags: Record<string, string | boolean>): Promise<void> {
  const activeProject = typeof flags["active-project"] === "string" ? flags["active-project"] : undefined;
  const activeProjectRoot =
    typeof flags["active-project-root"] === "string" ? path.resolve(flags["active-project-root"]) : undefined;
  if (!activeProject && !activeProjectRoot) return;

  const entries = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
  let entry: ProjectRegistryEntry | undefined;
  if (activeProjectRoot) {
    entry = entries.find((candidate) => path.resolve(candidate.root) === activeProjectRoot);
  } else if (activeProject) {
    const result = findProject(entries, { projectId: activeProject, name: activeProject });
    if (result.ok) entry = result.entry;
  }

  if (!entry) {
    throw new Error(
      `Startup active project not found: ${activeProjectRoot ?? activeProject}. ` +
        `Make sure --workspace points at that project folder or its workspace root.`,
    );
  }

  const preset = parseLeasePreset(flags["active-project-preset"]);
  const lease = makeLease(entry, preset);
  await ctx.store.setSession({ activeProjectId: entry.projectId, mode: "read", lease });
  await ctx.ledger.append({
    type: "project.selected",
    projectId: entry.projectId,
    reason: "startup active project",
    preset,
  });
}

async function cmdServeStdio(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const ctx = await buildToolContext(workspace);
  await applyStartupProjectSelection(ctx, flags);
  if (isControlEnabled()) startExecutor(ctx);
  const server = await createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await ctx.ledger.append({ type: "workspace.opened", workspaceRoot: ctx.workspaceRoot });
  console.error(`jk serve: listening on stdio (workspace=${ctx.workspaceRoot})`);
}

interface QuickTunnelHandle {
  child: ChildProcess;
  publicUrl: string;
}

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

/**
 * Prefer an explicit override, then the cloudflared bundled with packaged
 * builds (`<runtime>/bin`), then whatever is on PATH.
 */
function resolveCloudflared(): string {
  const override = process.env.JK_CLOUDFLARED?.trim();
  if (override) return override;
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", exe);
  return existsSync(bundled) ? bundled : "cloudflared";
}

async function startQuickTunnel(port: number): Promise<QuickTunnelHandle> {
  return await new Promise<QuickTunnelHandle>((resolve, reject) => {
    const child = spawn(resolveCloudflared(), ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let recentOutput = "";
    const timeout = setTimeout(() => {
      finishError("Timed out waiting for Cloudflare Quick Tunnel. Run `cloudflared --version` and retry.");
    }, 30_000);

    function finishError(message: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error(message));
    }
    const inspect = (chunk: Buffer | string) => {
      if (settled) return;
      recentOutput = `${recentOutput}${String(chunk)}`.slice(-12_000);
      const match = recentOutput.match(QUICK_TUNNEL_URL_RE);
      if (!match) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ child, publicUrl: match[0] });
    };

    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", (error) => {
      finishError(
        `Could not start cloudflared (${error.message}). Install the official Cloudflare package first, then retry ` +
          "`jk start --quick-tunnel`.",
      );
    });
    child.once("exit", (code) => {
      finishError(`cloudflared exited before a Quick Tunnel URL was issued (exit=${code ?? "unknown"}).`);
    });
  });
}

/**
 * HTTP mode (PRD §4 Transport Gateway, §5 CLI): `jk serve --http
 * [--port 7979] [--public-url <origin> | --quick-tunnel]`. Exposes the SAME
 * registerTools(ctx) catalog as stdio mode over a Streamable HTTP `/mcp`
 * endpoint, gated by OAuth 2.1 (see src/server/http.ts,
 * src/auth/oauth-provider.ts).
 */
async function cmdServeHttp(
  flags: Record<string, string | boolean>,
  onReady?: (info: HttpReadyInfo) => void,
): Promise<void> {
  const workspace = await resolveRuntimeWorkspace(flags);
  const ctx = await buildToolContext(workspace);

  if (!(await hasOwnerToken(ctx.stateDir))) {
    console.error(
      `jk serve --http: no owner token found. Run \`jk setup\` (or \`${SETUP_COMMAND}\`) or \`jk init\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  const port = typeof flags.port === "string" ? Number.parseInt(flags.port, 10) : 7979;
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";
  const quickTunnelRequested = flags["quick-tunnel"] === true;
  if (quickTunnelRequested && typeof flags["public-url"] === "string") {
    throw new Error("Use either --quick-tunnel or --public-url, not both.");
  }
  let quickTunnelProcess: ChildProcess | undefined;
  let publicUrl =
    typeof flags["public-url"] === "string" ? (flags["public-url"] as string) : `http://${host}:${port}`;
  if (quickTunnelRequested) {
    const tunnel = await startQuickTunnel(port);
    quickTunnelProcess = tunnel.child;
    publicUrl = tunnel.publicUrl;
    console.error(`jk start: Quick Tunnel ready: ${publicUrl}/mcp`);
  }
  ctx.config.publicUrl = publicUrl;
  const idleShutdownMinutes =
    typeof flags["idle-shutdown-minutes"] === "string" ? Number.parseFloat(flags["idle-shutdown-minutes"]) : 0;
  const idleShutdownMs =
    Number.isFinite(idleShutdownMinutes) && idleShutdownMinutes > 0 ? idleShutdownMinutes * 60 * 1000 : undefined;
  await applyStartupProjectSelection(ctx, flags);
  if (isControlEnabled()) startExecutor(ctx);

  let httpServer: ReturnType<ReturnType<typeof createHttpServer>["app"]["listen"]> | undefined;
  let closeHttpServer: () => void = () => undefined;
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = () => {
      quickTunnelProcess?.kill("SIGTERM");
      closeHttpServer();
      process.exit(exitCode);
    };
    if (httpServer) httpServer.close(finish);
    else finish();
  };

  const httpConfig = defaultHttpServerConfig({
    host,
    port,
    publicUrl,
    // "headless" means there is no desktop UI process, not that the shared
    // management HTTP surface disappears. Local and deployed JK instances use
    // the same Control Center routes; access is enforced separately by
    // loopback checks and remote owner authentication. Use the explicit
    // "disabled" mode only when management routes must not be registered.
    managementRoutesEnabled: (process.env.JK_MANAGEMENT_MODE ?? "local").trim().toLowerCase() !== "disabled",
    idleShutdownMs,
    onIdleTimeout: () => {
      console.error("jk serve --http: idle timeout reached; stopping.");
      shutdown(0);
    },
  });
  const running = createHttpServer(ctx, httpConfig);
  const { app } = running;
  closeHttpServer = running.close;

  httpServer = app.listen(port, host, () => {
    console.error(`jk serve --http: listening on http://${host}:${port}/mcp`);
    console.error(`jk serve --http: public URL ${publicUrl}/mcp`);
    console.error(`jk serve --http: workspace=${ctx.workspaceRoot}`);
    if (idleShutdownMs !== undefined) {
      console.error(`jk serve --http: idle shutdown after ${idleShutdownMinutes} minute(s) without sessions`);
    }
    onReady?.({
      connectorUrl: `${publicUrl}/mcp`,
      localBaseUrl: `http://${host}:${port}`,
      workspaceRoot: ctx.workspaceRoot,
      quickTunnel: quickTunnelRequested,
    });
  });
  quickTunnelProcess?.once("exit", (code) => {
    if (shuttingDown) return;
    console.error(
      `jk start: Cloudflare Quick Tunnel stopped (exit=${code ?? "unknown"}); ${publicUrl}/mcp no longer works. ` +
        "Restart JK to get a new address.",
    );
  });

  await ctx.ledger.append({ type: "workspace.opened", workspaceRoot: ctx.workspaceRoot, transport: "http" });

  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));

  // Keep the process alive; httpServer.listen already does this, but guard
  // against callers awaiting cmdServeHttp() expecting it to resolve only
  // once the server is asked to stop.
  await new Promise<void>(() => {});
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  if (flags.http) {
    await cmdServeHttp(flags);
    return;
  }
  await cmdServeStdio(flags);
}

type SetupPrompt = ReturnType<typeof createInterface>;

interface SetupDependency {
  label: string;
  command: string;
  args: string[];
  wingetId: string;
}

const SETUP_DEPENDENCIES: SetupDependency[] = [
  { label: "Git", command: "git", args: ["--version"], wingetId: "Git.Git" },
  { label: "ripgrep", command: "rg", args: ["--version"], wingetId: "BurntSushi.ripgrep.MSVC" },
  { label: "Cloudflare Quick Tunnel", command: "cloudflared", args: ["--version"], wingetId: "Cloudflare.cloudflared" },
];

function setupIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function expandUserPath(value: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

async function validateWorkspaceDirectory(value: string): Promise<string> {
  const resolved = path.resolve(expandUserPath(value));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Folder does not exist: ${resolved}`);
  return resolved;
}

async function askYesNo(prompt: SetupPrompt, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await prompt.question(`${question}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function chooseSetupPublicUrl(
  flags: Record<string, string | boolean>,
  prompt: SetupPrompt | null,
): Promise<string | undefined> {
  if (flags["quick-tunnel"] === true) return undefined;
  if (typeof flags["public-url"] === "string") return normalizeSetupPublicUrl(flags["public-url"]);

  const remembered = await loadSetupPublicUrl();
  if (remembered) {
    console.error("");
    console.error(`Saved fixed HTTPS address: ${remembered}/mcp`);
    if (!prompt || (await askYesNo(prompt, "Use this fixed address again?", true))) return remembered;
  }
  if (!prompt) return undefined;

  console.error("");
  console.error("Choose how ChatGPT will reach JK:");
  console.error("  1. Quick Tunnel (recommended) - no domain needed. The address CHANGES every time JK restarts.");
  console.error("  2. Your own HTTPS domain - address stays the same. Requires a Named Tunnel or HTTPS reverse proxy.");
  while (true) {
    const mode = (await prompt.question("Connection mode (Enter = 1, or type 2): ")).trim();
    if (!mode || mode === "1") return undefined;
    if (mode !== "2") {
      console.error("Type 1 for Quick Tunnel or 2 for a fixed HTTPS domain.");
      continue;
    }
    console.error("");
    console.error("Your domain must already forward HTTPS traffic to JK at http://127.0.0.1:7979.");
    console.error("A domain name alone is not enough; configure Cloudflare Named Tunnel or another HTTPS reverse proxy first.");
    while (true) {
      const answer = await prompt.question("Fixed HTTPS address (example: https://mcp.example.com): ");
      try {
        return normalizeSetupPublicUrl(answer);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  }
}

async function browseForWorkspaceWindows(initialDirectory: string): Promise<string | undefined> {
  const escapedInitial = initialDirectory.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Choose the folder JK is allowed to work in'",
    `$dialog.SelectedPath = '${escapedInitial}'`,
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      timeout: 120_000,
      windowsHide: false,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Never default to a filesystem root or the Windows system folder. */
async function defaultSetupWorkspace(): Promise<string> {
  const current = path.resolve(process.cwd());
  let unsafeDefault = current === path.parse(current).root;
  if (process.platform === "win32") {
    const windowsDir = process.env.WINDIR ?? process.env.SystemRoot;
    if (windowsDir) {
      const rel = path.relative(path.resolve(windowsDir), current);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) unsafeDefault = true;
    }
  }
  if (!unsafeDefault) return current;
  const documents = path.join(os.homedir(), "Documents");
  const documentsStat = await fs.stat(documents).catch(() => null);
  return documentsStat?.isDirectory() ? documents : os.homedir();
}

async function chooseSetupWorkspace(
  flags: Record<string, string | boolean>,
  prompt: SetupPrompt | null,
): Promise<string> {
  if (typeof flags.workspace === "string") return await validateWorkspaceDirectory(flags.workspace);
  const remembered = await loadSetupWorkspace();
  if (remembered) {
    console.error(`✓ Using saved allowed folder: ${remembered}`);
    return remembered;
  }
  const current = await defaultSetupWorkspace();
  if (!prompt) return await validateWorkspaceDirectory(current);

  console.error("");
  console.error("Choose the folder ChatGPT is allowed to work in.");
  while (true) {
    const browseHint = process.platform === "win32" ? ", B = browse" : "";
    let candidate = (await prompt.question(`Folder (Enter = ${current}${browseHint}): `)).trim() || current;
    if (process.platform === "win32" && candidate.toLowerCase() === "b") {
      const selected = await browseForWorkspaceWindows(current);
      if (!selected) {
        console.error("No folder selected. You can type or paste a folder path instead.");
        continue;
      }
      candidate = selected;
    }
    try {
      return await validateWorkspaceDirectory(candidate);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function refreshWindowsPath(): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const script = [
      "$m=[Environment]::GetEnvironmentVariable('Path','Machine')",
      "$u=[Environment]::GetEnvironmentVariable('Path','User')",
      "[Console]::Out.Write($m + ';' + $u)",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 10_000 });
    const refreshed = stdout.trim();
    if (refreshed) process.env.PATH = `${refreshed};${process.env.PATH ?? ""}`;
  } catch {
    // A fresh terminal will pick up PATH changes even if this process cannot.
  }
}

async function runVisibleProcess(command: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function missingSetupDependencies(includeCloudflared: boolean): Promise<SetupDependency[]> {
  const missing: SetupDependency[] = [];
  for (const dependency of SETUP_DEPENDENCIES) {
    if (dependency.command === "cloudflared") {
      if (includeCloudflared && !(await checkCommand(resolveCloudflared(), dependency.args))) missing.push(dependency);
      continue;
    }
    if (!(await checkCommand(dependency.command, dependency.args))) missing.push(dependency);
  }
  return missing;
}

async function ensureSetupDependencies(prompt: SetupPrompt | null, includeCloudflared: boolean): Promise<boolean> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    console.error(`Node.js 22 or newer is required (current: ${process.version}).`);
    console.error(`Install the current Node.js LTS release, open a new terminal, then run \`${SETUP_COMMAND}\` again.`);
    return false;
  }

  let missing = await missingSetupDependencies(includeCloudflared);
  if (missing.length === 0) {
    console.error("✓ Required helper tools are ready.");
    return true;
  }

  console.error(`Missing helper tools: ${missing.map((d) => d.label).join(", ")}`);
  if (process.platform !== "win32") {
    console.error("Install the missing tools from their official package source, then run setup again.");
    return false;
  }

  const wingetReady = await checkCommand("winget", ["--version"]);
  if (!prompt || !wingetReady) {
    console.error("On Windows, install the missing tools with Windows Package Manager (winget), then run setup again:");
    for (const d of missing) console.error(`  winget install --id ${d.wingetId} -e`);
    return false;
  }

  console.error("Windows Package Manager will be asked to install only these fixed package IDs:");
  for (const d of missing) console.error(`  ${d.label}: ${d.wingetId}`);
  const approved = await askYesNo(
    prompt,
    "Install the missing tools now with Windows Package Manager? JK will only request the official package IDs shown above.",
    true,
  );
  if (!approved) {
    console.error("No changes were made. Install the missing tools when ready, then run setup again.");
    return false;
  }

  for (const d of missing) {
    console.error(`\nInstalling ${d.label} (${d.wingetId})...`);
    const exitCode = await runVisibleProcess("winget", [
      "install",
      "--id",
      d.wingetId,
      "-e",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);
    if (exitCode !== 0) {
      console.error(`${d.label} installation did not complete (exit=${exitCode}).`);
      return false;
    }
  }

  await refreshWindowsPath();
  missing = await missingSetupDependencies(includeCloudflared);
  if (missing.length > 0) {
    console.error(`Installed, but this terminal cannot see: ${missing.map((d) => d.label).join(", ")}.`);
    console.error(`Close this terminal, open a new one, and run \`${SETUP_COMMAND}\` again.`);
    return false;
  }
  console.error("✓ Required helper tools are ready.");
  return true;
}

async function cmdSetup(flags: Record<string, string | boolean>): Promise<void> {
  const prompt = setupIsInteractive() ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let workspaceRoot: string;
  let connectionCode: string | undefined;
  let publicUrl: string | undefined;
  const noStart = flags["no-start"] === true;

  try {
    console.error("JK setup");
    console.error("You do not need to understand MCP, OAuth, or Cloudflare to continue.");
    console.error("");

    workspaceRoot = await chooseSetupWorkspace(flags, prompt);
    publicUrl = await chooseSetupPublicUrl(flags, prompt);

    if (!(await ensureSetupDependencies(prompt, !publicUrl && !noStart))) {
      process.exitCode = 1;
      return;
    }

    const stateDir = defaultStateDir();
    const store = new Store(stateDir);
    const ledger = new Ledger(stateDir);
    const registry = await scanWorkspace(workspaceRoot);
    await store.saveProjects(registry);
    await store.setSession({ activeProjectId: null, mode: "observe", lease: null });
    await ledger.append({ type: "workspace.opened", workspaceRoot });
    await saveSetupConfig(workspaceRoot, publicUrl);
    console.error(`✓ Allowed folder: ${workspaceRoot}`);

    if (registry.length > 0) {
      const visible = registry.slice(0, 5).map((entry) => entry.name).join(", ");
      const extra = registry.length > 5 ? ` (+${registry.length - 5} more)` : "";
      console.error(`✓ Found ${registry.length} project(s): ${visible}${extra}`);
    } else {
      console.error("! No projects were detected inside the allowed folder.");
      console.error("  JK detects folders containing .git, package.json, requirements.txt, Cargo.toml, go.mod, pubspec.yaml, or .jk.");
      console.error("  To register a plain folder, create an empty .jk file inside it, then run setup again.");
    }

    const tokenExists = await hasOwnerToken(stateDir);
    let resetCode = flags["reset-code"] === true || flags["rotate-owner-token"] === true;
    if (tokenExists && !resetCode && prompt) {
      console.error("");
      console.error("A connection code already exists. JK stores only its hash and cannot display the old code again.");
      resetCode = await askYesNo(
        prompt,
        "Create and show a new connection code now? ChatGPT will need to log in again (the connector stays registered).",
        false,
      );
    }

    if (!tokenExists || resetCode) {
      connectionCode = generateOwnerToken();
      await storeOwnerToken(stateDir, connectionCode);
      if (tokenExists) await new JsonOAuthStore(stateDir).clearTokens();
      console.error(`✓ ${tokenExists ? "New" : "Private"} connection code created. It will be shown below once.`);
    } else {
      console.error("✓ Existing connection code kept.");
    }
  } finally {
    prompt?.close();
  }

  if (noStart) {
    console.error("");
    console.error(`Setup saved. Start JK later with \`jk start\` or \`${SETUP_COMMAND}\`.`);
    if (publicUrl) console.error(`Saved fixed connector address: ${publicUrl}/mcp`);
    if (connectionCode) {
      console.error("Connection code (shown once):");
      console.error(connectionCode);
    }
    return;
  }

  const serveFlags: Record<string, string | boolean> = { ...flags, workspace: workspaceRoot };
  if (publicUrl) serveFlags["public-url"] = publicUrl;
  else serveFlags["quick-tunnel"] = true;
  delete serveFlags["no-start"];
  delete serveFlags["reset-code"];
  delete serveFlags["rotate-owner-token"];
  await cmdServeHttp(serveFlags, (info) => {
    for (const line of formatSetupReady(info, connectionCode)) console.error(line);
  });
}

/**
 * `jk start`: run with the saved setup. An explicit --public-url or
 * --quick-tunnel wins; otherwise a saved fixed domain is reused; otherwise
 * a Quick Tunnel is opened (use `jk serve --http` for loopback-only).
 */
async function cmdStart(flags: Record<string, string | boolean>): Promise<void> {
  const serveFlags: Record<string, string | boolean> = { ...flags };
  if (typeof serveFlags["public-url"] === "string") {
    serveFlags["public-url"] = normalizeSetupPublicUrl(serveFlags["public-url"]);
  } else if (serveFlags["quick-tunnel"] !== true) {
    const saved = await loadSetupPublicUrl();
    if (saved) serveFlags["public-url"] = saved;
    else serveFlags["quick-tunnel"] = true;
  }
  await cmdServeHttp(serveFlags, (info) => {
    for (const line of formatSetupReady(info, undefined)) console.error(line);
  });
}

async function cmdInit(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const workspaceRoot = path.resolve(workspace);
  const stateDir = defaultStateDir();

  const store = new Store(stateDir);
  const ledger = new Ledger(stateDir);

  const registry = await scanWorkspace(workspaceRoot);
  await store.saveProjects(registry);
  await store.setSession({ activeProjectId: null, mode: "observe", lease: null });
  await ledger.append({ type: "workspace.opened", workspaceRoot });

  console.error(
    `jk init: initialized state dir ${stateDir} with ${registry.length} project(s) from ${workspaceRoot}`,
  );

  // PRD §11 SR-04: owner secret lives only as a hash on disk; the plaintext
  // is generated here and shown to the operator exactly once. Re-running
  // `init` rotates it unless --keep-owner-token is passed.
  const alreadyHasToken = await hasOwnerToken(stateDir);
  if (alreadyHasToken && !flags["rotate-owner-token"]) {
    console.error(
      "jk init: owner token already set (pass --rotate-owner-token to generate a new one).",
    );
  } else {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    // Rotation must revoke sessions issued under the previous token; the
    // connector (client registration) is preserved so only login repeats.
    if (alreadyHasToken) await new JsonOAuthStore(stateDir).clearTokens();
    console.error("");
    console.error("jk init: generated a new HTTP owner token (shown once, never logged again):");
    console.error("");
    console.error(`  ${ownerToken}`);
    console.error("");
    console.error(
      "Store this securely (e.g. a password manager). It is required to approve the OAuth /authorize prompt when a ChatGPT/MCP client connects over `jk serve --http`.",
    );
  }
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

async function cmdOwnerToken(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const stateDir = defaultStateDir();

  if (flags.status) {
    console.log(JSON.stringify({ configured: await hasOwnerToken(stateDir), stateDir }));
    return;
  }

  if (flags["set-stdin"]) {
    const token = (await readStdin()).trim();
    await storeOwnerToken(stateDir, token);
    await new JsonOAuthStore(stateDir).clearTokens();
    console.log(JSON.stringify({ configured: true, rotated: true, stateDir }));
    return;
  }

  if (flags.generate || flags.rotate) {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    await new JsonOAuthStore(stateDir).clearTokens();
    console.log(JSON.stringify({ configured: true, rotated: true, ownerToken, stateDir }));
    return;
  }

  console.error("usage: jk owner-token --status|--generate|--set-stdin [--workspace <path>]");
  console.error(`workspace: ${path.resolve(workspace)}`);
  process.exitCode = 1;
}

/**
 * `jk control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]`
 *
 * The local-only human-approval surface for Option B desktop control
 * (src/control/queue.ts). This is the mechanism a local approver (today:
 * this CLI directly; eventually the macOS status-bar app via the same
 * runCli pattern it already uses) uses to move a queued click/type/key
 * request from `pending` to `approved`/`rejected`, kill the session
 * outright, or turn on a bounded auto-approve scope (src/control/auto.ts).
 * ChatGPT/MCP clients cannot reach any of this: there is no MCP tool or
 * HTTP route that calls approveAction, setKill, or setAuto.
 */
async function cmdControl(positional: string[], flags: Record<string, string | boolean> = {}): Promise<void> {
  const stateDir = defaultStateDir();
  const [sub, actionId] = positional;
  switch (sub) {
    case "list": {
      const actions = await listActions(stateDir);
      console.log(JSON.stringify(actions.map(toSummary), null, 2));
      return;
    }
    case "approve": {
      if (!actionId) {
        console.error("usage: jk control approve <actionId>");
        process.exitCode = 1;
        return;
      }
      const record = await approveAction(stateDir, actionId);
      console.log(JSON.stringify(toSummary(record), null, 2));
      return;
    }
    case "approve-all": {
      // Local human batch-approve: only pending actions targeting a
      // non-sensitive, allowlisted app are approved. Everything else is
      // reported back as skipped rather than silently approved, and a kill
      // mid-loop stops the whole batch immediately.
      const approved: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      if (await isKilled(stateDir)) {
        console.log(JSON.stringify({ approved, skipped, killed: true }, null, 2));
        return;
      }
      const allowlist = controlAllowlist();
      const pending = (await listActions(stateDir)).filter((a) => a.status === "pending");
      for (const action of pending) {
        if (await isKilled(stateDir)) break;
        if (isSensitiveApp(action.appName) || !isAppAllowed(action.appName, allowlist)) {
          skipped.push({ id: action.actionId, reason: "blocked-not-eligible" });
          continue;
        }
        try {
          await approveAction(stateDir, action.actionId);
          approved.push(action.actionId);
        } catch (err) {
          skipped.push({ id: action.actionId, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      console.log(JSON.stringify({ approved, skipped }, null, 2));
      return;
    }
    case "auto": {
      const mode = actionId;
      switch (mode) {
        case "on": {
          if (!isControlEnabled()) {
            console.error("Desktop control is not enabled (JK_CONTROL); refusing to enable auto-approve.");
            process.exitCode = 1;
            return;
          }
          const apps =
            typeof flags.apps === "string"
              ? flags.apps
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0)
              : [];
          if (apps.length === 0) {
            console.error(
              "usage: jk control auto on --apps <a,b,...> [--minutes N] [--kinds click,type,key,scroll] [--max N]",
            );
            process.exitCode = 1;
            return;
          }
          const minutes = typeof flags.minutes === "string" ? Number(flags.minutes) : undefined;
          const kinds =
            typeof flags.kinds === "string"
              ? (flags.kinds
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry): entry is AutoActionKind => entry === "click" || entry === "type" || entry === "key" || entry === "scroll"))
              : undefined;
          const maxCountRaw = typeof flags.max === "string" ? Number(flags.max) : undefined;
          const maxCount = maxCountRaw !== undefined && !Number.isNaN(maxCountRaw) ? maxCountRaw : undefined;
          const scope = await setAuto(stateDir, {
            apps,
            minutes: clampMinutes(minutes),
            kinds: kinds && kinds.length > 0 ? kinds : undefined,
            maxCount,
          });
          if (scope.apps.length === 0) {
            console.error(
              "warning: none of the requested --apps are on the control allowlist (or all are sensitive apps); auto-approve is on but matches nothing.",
            );
          }
          console.log(JSON.stringify(scope, null, 2));
          return;
        }
        case "off": {
          await clearAuto(stateDir);
          console.log(JSON.stringify({ autoEnabled: false }));
          return;
        }
        case "status": {
          const scope = await readAuto(stateDir);
          if (!scope) {
            console.log(JSON.stringify({ autoEnabled: false }));
            return;
          }
          const now = Date.now();
          const active = now < scope.expiresAt;
          console.log(
            JSON.stringify({ autoEnabled: active, remainingMs: Math.max(0, scope.expiresAt - now), ...scope }, null, 2),
          );
          return;
        }
        default:
          console.error(
            "usage: jk control auto <on --apps a,b [--minutes N] [--kinds click,type,key,scroll] [--max N] | off | status>",
          );
          process.exitCode = 1;
          return;
      }
    }
    case "reject": {
      if (!actionId) {
        console.error("usage: jk control reject <actionId>");
        process.exitCode = 1;
        return;
      }
      const record = await rejectAction(stateDir, actionId, "rejected-by-local-approver");
      console.log(JSON.stringify(toSummary(record), null, 2));
      return;
    }
    case "kill": {
      await setKill(stateDir);
      console.log(JSON.stringify({ killed: true }));
      return;
    }
    case "preflight": {
      // Live Accessibility/Screen Recording trust check exposed for local
      // operators and doctor-style diagnosis (src/control/mac-input.ts
      // preflightPermissions). Reports a clear reason instead of a control
      // action failing silently partway through; never throws a raw
      // NOT_IMPLEMENTED stack trace off darwin, always structured JSON.
      try {
        const result = await preflightPermissions();
        console.log(JSON.stringify(result, null, 2));
        if (!result.accessibilityTrusted || !result.screenRecordingAllowed) {
          process.exitCode = 1;
        }
      } catch (err) {
        console.log(
          JSON.stringify(
            {
              accessibilityTrusted: false,
              screenRecordingAllowed: false,
              source: "unavailable",
              reason: err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.error("usage: jk control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]");
      process.exitCode = 1;
  }
}

async function checkCommand(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
    return stdout.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

async function cmdDoctor(): Promise<void> {
  const nodeVersion = process.version;
  const rgVersion = await checkCommand("rg", ["--version"]);
  const gitVersion = await checkCommand("git", ["--version"]);
  const workspacePath = process.cwd();

  let toolCount = "unknown";
  try {
    // Import lazily so a broken registration path doesn't crash doctor.
    const { createServer } = await import("./server/mcp-server.js");
    const ctx = await buildToolContext(workspacePath);
    const server = await createServer(ctx);
    const serverAny = server as unknown as {
      _registeredTools?: Record<string, unknown>;
    };
    const registered = serverAny._registeredTools;
    toolCount = registered ? String(Object.keys(registered).length) : "unknown";
  } catch (err) {
    toolCount = `error: ${(err as Error).message}`;
  }

  const stateDir = defaultStateDir();
  const ownerTokenReady = await hasOwnerToken(stateDir);
  const intake = await checkIntakeAvailability();

  console.log(`node: ${nodeVersion}`);
  console.log(`ripgrep: ${rgVersion ?? "not found"}`);
  console.log(`git: ${gitVersion ?? "not found"}`);
  console.log(`workspace: ${workspacePath}`);
  console.log(`state dir: ${stateDir}`);
  console.log(`registered tools: ${toolCount}`);
  console.log(
    `http/oauth: owner token ${ownerTokenReady ? "configured" : "NOT SET — run `jk init` to generate one"}`,
  );
  console.log(`http default endpoint: http://127.0.0.1:7979/mcp (start via \`jk serve --http\`)`);
  console.log(
    `image intake: pngpaste ${intake.pngpasteAvailable ? "found" : "not found — clipboard image intake unavailable"}, ` +
      `~/Downloads ${intake.downloadsDirExists ? "found" : "NOT FOUND — download intake unavailable"}`,
  );
  console.log(
    "ChatGPT image app flow: open_chatgpt_images_app opens/prepares the first-party Images app; save_chatgpt_image imports from passed URL, copied URL, clipboard image, latest download, or path; " +
      "URL fetches remain SSRF-hardened (blocks loopback/private/link-local/metadata targets, re-validates redirects, 50MB/15s caps).",
  );
}

async function cmdExecutor(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const hubUrl =
    typeof flags.hub === "string" ? flags.hub : process.env.JK_HUB_URL ?? "";
  if (!hubUrl.trim()) {
    throw new Error("Executor hub is not configured. Set JK_HUB_URL or pass --hub <url>.");
  }
  const executorId =
    typeof flags["executor-id"] === "string" ? flags["executor-id"] : process.env.JK_EXECUTOR_ID ?? "windows-main";
  const tokenFile =
    typeof flags["token-file"] === "string" ? flags["token-file"] : process.env.JK_EXECUTOR_TOKEN_FILE;
  const executorToken = process.env.JK_EXECUTOR_TOKEN ?? (tokenFile ? await readExecutorToken(tokenFile) : "");
  if (!executorToken) {
    throw new Error(
      "Executor authentication is not configured. Set JK_EXECUTOR_TOKEN or --token-file <path>.",
    );
  }
  const stateDir = typeof flags["state-dir"] === "string" ? path.resolve(flags["state-dir"])
    : process.env.JK_EXECUTOR_STATE_DIR?.trim() ? path.resolve(process.env.JK_EXECUTOR_STATE_DIR.trim()) : defaultStateDir();
  await runExecutorWorker({
    stateDir,
    hubUrl,
    executorToken,
    executorId,
    workspaceRoot: workspace,
    label: typeof flags.label === "string" ? flags.label : executorId,
    onStatus: (message) => console.error(`[executor] ${message}`),
  });
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      break;
    case "setup":
      await cmdSetup(flags);
      break;
    case "start":
      await cmdStart(flags);
      break;
    case "serve":
      await cmdServe(flags);
      break;
    case "init":
      await cmdInit(flags);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "owner-token":
      await cmdOwnerToken(flags);
      break;
    case "control":
      await cmdControl(positional, flags);
      break;
    case "executor":
      await cmdExecutor(flags);
      break;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
