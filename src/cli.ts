#!/usr/bin/env node
/**
 * chatgpt2codex CLI entrypoint.
 *
 * Minimal hand-rolled argv parsing (no commander dependency) for the three
 * MVP subcommands defined in PRD §5:
 *
 *   chatgpt2codex serve  --workspace <path>
 *   chatgpt2codex init   --workspace <path>
 *   chatgpt2codex doctor
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
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

const execFileAsync = promisify(execFile);

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

/** Default state dir per PRD §10: `~/.local/share/chatgpt2codex/`. */
function defaultStateDir(): string {
  // Portable/override mode: lets sandboxed runs, USB-portable installs, and
  // multi-instance setups redirect all state without touching $HOME.
  const override = process.env.CHATGPT2CODEX_STATE_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".local", "share", "chatgpt2codex");
}

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
  await fs.writeFile(
    setupConfigPath(stateDir),
    `${JSON.stringify(saved, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function loadSavedSetupConfig(): Promise<SavedSetupConfig | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(setupConfigPath(), "utf8")) as SavedSetupConfig;
    if (!parsed || typeof parsed.workspaceRoot !== "string" || !parsed.workspaceRoot.trim()) {
      throw new Error("JK's saved setup is invalid. Run `jk setup` again.");
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
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
  const parsed = await loadSavedSetupConfig();
  const value = parsed?.publicUrl;
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
  console.error(`chatgpt2codex serve: listening on stdio (workspace=${ctx.workspaceRoot})`);
}

interface QuickTunnelHandle {
  child: ChildProcess;
  publicUrl: string;
}

interface HttpReadyInfo {
  connectorUrl: string;
  workspaceRoot: string;
}

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

async function startQuickTunnel(port: number): Promise<QuickTunnelHandle> {
  return await new Promise<QuickTunnelHandle>((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let settled = false;
    let recentOutput = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for Cloudflare Quick Tunnel. Run `cloudflared --version` and retry."));
    }, 20_000);

    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error(message));
    };
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
      if (!settled) finishError(`cloudflared exited before a Quick Tunnel URL was issued (exit=${code ?? "unknown"}).`);
    });
  });
}

/**
 * HTTP mode (PRD §4 Transport Gateway, §5 CLI): `chatgpt2codex serve --http
 * [--port 7979] [--public-url <origin>]`. Exposes the SAME registerTools(ctx)
 * catalog as stdio mode over a Streamable HTTP `/mcp` endpoint, gated by
 * OAuth 2.1 (see src/server/http.ts, src/auth/oauth-provider.ts).
 */
async function cmdServeHttp(
  flags: Record<string, string | boolean>,
  onReady?: (info: HttpReadyInfo) => void,
): Promise<void> {
  const workspace = await resolveRuntimeWorkspace(flags);
  const ctx = await buildToolContext(workspace);

  if (!(await hasOwnerToken(ctx.stateDir))) {
    console.error(
      "chatgpt2codex serve --http: no owner token found. Run `chatgpt2codex init` first to generate one.",
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
      console.error("chatgpt2codex serve --http: idle timeout reached; stopping.");
      shutdown(0);
    },
  });
  const running = createHttpServer(ctx, httpConfig);
  const { app } = running;
  closeHttpServer = running.close;

  httpServer = app.listen(port, host, () => {
    console.error(`chatgpt2codex serve --http: listening on http://${host}:${port}/mcp`);
    console.error(`chatgpt2codex serve --http: public URL ${publicUrl}/mcp`);
    console.error(`chatgpt2codex serve --http: workspace=${ctx.workspaceRoot}`);
    if (idleShutdownMs !== undefined) {
      console.error(`chatgpt2codex serve --http: idle shutdown after ${idleShutdownMinutes} minute(s) without sessions`);
    }
    onReady?.({ connectorUrl: `${publicUrl}/mcp`, workspaceRoot: ctx.workspaceRoot });
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
  {
    label: "Cloudflare Quick Tunnel",
    command: "cloudflared",
    args: ["--version"],
    wingetId: "Cloudflare.cloudflared",
  },
];

function setupIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function expandUserPath(value: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
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

function normalizeSetupPublicUrl(value: string): string {
  const raw = value.trim().replace(/^['"]|['"]$/g, "");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Enter a valid HTTPS address, for example: https://jk.example.com");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("A fixed ChatGPT connector address must use HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Use only the public HTTPS origin, for example: https://jk.example.com");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname && pathname !== "/mcp") {
    throw new Error("Use the domain only (or a trailing /mcp), for example: https://jk.example.com");
  }
  return parsed.origin;
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
  console.error("  1. Quick Tunnel (recommended) - no domain needed; address can change after restart.");
  console.error("  2. Fixed HTTPS domain - for users who already configured a Named Tunnel or HTTPS reverse proxy.");
  while (true) {
    const mode = (await prompt.question("Connection mode (Enter = 1, or type 2): ")).trim();
    if (!mode || mode === "1") return undefined;
    if (mode !== "2") {
      console.error("Type 1 for Quick Tunnel or 2 for a fixed HTTPS domain.");
      continue;
    }

    console.error("");
    console.error("Your domain must already forward HTTPS traffic to JK at http://127.0.0.1:7979.");
    console.error("A domain name by itself is not enough; configure Cloudflare Named Tunnel or another HTTPS reverse proxy first.");
    while (true) {
      const answer = await prompt.question("Fixed HTTPS address (example: https://jk.example.com): ");
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
    const selected = stdout.trim();
    return selected || undefined;
  } catch {
    return undefined;
  }
}

async function defaultSetupWorkspace(): Promise<string> {
  const current = path.resolve(process.cwd());
  const filesystemRoot = path.parse(current).root;
  let unsafeDefault = current === filesystemRoot;

  if (process.platform === "win32") {
    const windowsDir = process.env.WINDIR ?? process.env.SystemRoot;
    if (windowsDir) {
      const relativeToWindows = path.relative(path.resolve(windowsDir), current);
      if (relativeToWindows === "" || (!relativeToWindows.startsWith("..") && !path.isAbsolute(relativeToWindows))) {
        unsafeDefault = true;
      }
    }
  }

  if (!unsafeDefault) return current;

  const documents = path.join(os.homedir(), "Documents");
  const documentsStat = await fs.stat(documents).catch(() => null);
  if (documentsStat?.isDirectory()) return documents;
  return os.homedir();
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
    const answer = await prompt.question(`Folder (Enter = ${current}${browseHint}): `);
    let candidate = answer.trim();
    if (!candidate) candidate = current;
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
    // A fresh terminal will pick up PATH changes even if the current process cannot.
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
  const dependencies = includeCloudflared
    ? SETUP_DEPENDENCIES
    : SETUP_DEPENDENCIES.filter((dependency) => dependency.command !== "cloudflared");
  const missing: SetupDependency[] = [];
  for (const dependency of dependencies) {
    if (!(await checkCommand(dependency.command, dependency.args))) missing.push(dependency);
  }
  return missing;
}

async function ensureSetupDependencies(prompt: SetupPrompt | null, includeCloudflared: boolean): Promise<boolean> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    console.error(`Node.js 22 or newer is required (current: ${process.version}).`);
    console.error("Install the current Node.js LTS release, open a new terminal, then run `npx -y jk-mcp setup` again.");
    return false;
  }

  let missing = await missingSetupDependencies(includeCloudflared);
  if (missing.length === 0) {
    console.error("✓ Required helper tools are ready.");
    return true;
  }

  console.error(`Missing helper tools: ${missing.map((dependency) => dependency.label).join(", ")}`);
  if (process.platform !== "win32") {
    console.error("Install the missing tools from their official package source, then run setup again.");
    return false;
  }

  const wingetReady = await checkCommand("winget", ["--version"]);
  if (!prompt || !wingetReady) {
    console.error("On Windows, install the missing tools with Windows Package Manager (winget), then run setup again:");
    for (const dependency of missing) console.error(`  winget install --id ${dependency.wingetId} -e`);
    return false;
  }

  console.error("Windows Package Manager will be asked to install only these fixed package IDs:");
  for (const dependency of missing) console.error(`  ${dependency.label}: ${dependency.wingetId}`);

  const approved = await askYesNo(
    prompt,
    "Install the missing tools now with Windows Package Manager? JK will only request the official package IDs shown above.",
    true,
  );
  if (!approved) {
    console.error("No changes were made. Install the missing tools when ready, then run setup again.");
    return false;
  }

  for (const dependency of missing) {
    console.error(`\nInstalling ${dependency.label} (${dependency.wingetId})...`);
    const exitCode = await runVisibleProcess("winget", [
      "install",
      "--id",
      dependency.wingetId,
      "-e",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);
    if (exitCode !== 0) {
      console.error(`${dependency.label} installation did not complete (exit=${exitCode}).`);
      return false;
    }
  }

  await refreshWindowsPath();
  missing = await missingSetupDependencies(includeCloudflared);
  if (missing.length > 0) {
    console.error(`Installed, but this terminal cannot see: ${missing.map((dependency) => dependency.label).join(", ")}.`);
    console.error("Close this terminal, open a new PowerShell window, and run `npx -y jk-mcp setup` again.");
    return false;
  }
  console.error("✓ Required helper tools are ready.");
  return true;
}

function printSetupReady(info: HttpReadyInfo, connectionCode: string | undefined): void {
  console.error("");
  console.error("============================================================");
  console.error("JK is ready for ChatGPT");
  console.error("============================================================");
  console.error("1. Keep this window open while you use JK.");
  console.error("2. In ChatGPT, open Apps / Connectors and add a custom MCP connector.");
  console.error("3. Paste this address:");
  console.error("");
  console.error(`   ${info.connectorUrl}`);
  console.error("");
  if (connectionCode) {
    console.error("If ChatGPT asks for your private connection code, use this once and save it somewhere private:");
    console.error("");
    console.error(`   ${connectionCode}`);
    console.error("");
  } else {
    console.error("Your existing private connection code is still active.");
    console.error("If you no longer have it, stop JK with Ctrl+C and run `npx -y jk-mcp setup --reset-code`.");
    console.error("");
  }
  console.error(`Allowed folder: ${info.workspaceRoot}`);
  console.error("After connecting, you can simply ask ChatGPT: `@jk inspect this project`.");
  console.error("Next time, run the same command again: `npx -y jk-mcp setup`.");
  console.error("============================================================");
}

async function cmdSetup(flags: Record<string, string | boolean>): Promise<void> {
  const interactive = setupIsInteractive();
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let workspaceRoot: string;
  let connectionCode: string | undefined;
  let publicUrl: string | undefined;
  const noStart = flags["no-start"] === true;

  try {
    console.error("JK first-time setup");
    console.error("You do not need to understand MCP, OAuth, or Cloudflare to continue.");
    console.error("");

    workspaceRoot = await chooseSetupWorkspace(flags, prompt);
    publicUrl = await chooseSetupPublicUrl(flags, prompt);
    const useQuickTunnel = !publicUrl;

    if (!(await ensureSetupDependencies(prompt, useQuickTunnel && !noStart))) {
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
      console.error("  JK detects folders containing .git, package.json, requirements.txt, Cargo.toml, go.mod, pubspec.yaml, or .chatgpt2codex.");
      console.error("  To register a plain folder, create an empty .chatgpt2codex file inside that folder, then run setup again.");
    }

    const tokenExists = await hasOwnerToken(stateDir);
    let resetCode = flags["reset-code"] === true || flags["rotate-owner-token"] === true;
    if (tokenExists && !resetCode && prompt) {
      console.error("");
      console.error("A private connection code already exists. For security, JK stores only its hash and cannot display the old code again.");
      resetCode = await askYesNo(
        prompt,
        "Create and show a new connection code now? Existing authorized sessions will need to reconnect.",
        false,
      );
    }

    if (!tokenExists || resetCode) {
      connectionCode = generateOwnerToken();
      await storeOwnerToken(stateDir, connectionCode);
      if (tokenExists) await new JsonOAuthStore(stateDir).clearTokens();
      console.error(`✓ ${tokenExists ? "New" : "Private"} connection code created. It will be shown below once.`);
    } else {
      console.error("✓ Existing private connection code kept.");
    }
  } finally {
    prompt?.close();
  }

  if (noStart) {
    console.error("");
    console.error("Setup saved. Start JK later with: `npx -y jk-mcp setup`");
    if (publicUrl) console.error(`Saved fixed connector address: ${publicUrl}/mcp`);
    if (connectionCode) {
      console.error("Private connection code (shown once):");
      console.error(connectionCode);
    } else {
      console.error("Existing private connection code kept. Run setup with --reset-code if you need a new visible code.");
    }
    return;
  }

  const serveFlags: Record<string, string | boolean> = { ...flags, workspace: workspaceRoot };
  if (publicUrl) serveFlags["public-url"] = publicUrl;
  else serveFlags["quick-tunnel"] = true;
  delete serveFlags["no-start"];
  delete serveFlags["reset-code"];
  delete serveFlags["rotate-owner-token"];
  await cmdServeHttp(serveFlags, (info) => printSetupReady(info, connectionCode));
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
    `chatgpt2codex init: initialized state dir ${stateDir} with ${registry.length} project(s) from ${workspaceRoot}`,
  );

  // PRD §11 SR-04: owner secret lives only as a hash on disk; the plaintext
  // is generated here and shown to the operator exactly once. Re-running
  // `init` rotates it unless --keep-owner-token is passed.
  const alreadyHasToken = await hasOwnerToken(stateDir);
  if (alreadyHasToken && !flags["rotate-owner-token"]) {
    console.error(
      "chatgpt2codex init: owner token already set (pass --rotate-owner-token to generate a new one).",
    );
  } else {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    console.error("");
    console.error("chatgpt2codex init: generated a new HTTP owner token (shown once, never logged again):");
    console.error("");
    console.error(`  ${ownerToken}`);
    console.error("");
    console.error(
      "Store this securely (e.g. a password manager). It is required to approve the OAuth /authorize prompt when a ChatGPT/MCP client connects over `chatgpt2codex serve --http`.",
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

  console.error("usage: chatgpt2codex owner-token --status|--generate|--set-stdin [--workspace <path>]");
  console.error(`workspace: ${path.resolve(workspace)}`);
  process.exitCode = 1;
}

/**
 * `chatgpt2codex control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]`
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
        console.error("usage: chatgpt2codex control approve <actionId>");
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
            console.error("Desktop control is not enabled (CHATGPT2CODEX_CONTROL); refusing to enable auto-approve.");
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
              "usage: chatgpt2codex control auto on --apps <a,b,...> [--minutes N] [--kinds click,type,key] [--max N]",
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
                  .filter((entry): entry is AutoActionKind => entry === "click" || entry === "type" || entry === "key"))
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
            "usage: chatgpt2codex control auto <on --apps a,b [--minutes N] [--kinds click,type,key] [--max N] | off | status>",
          );
          process.exitCode = 1;
          return;
      }
    }
    case "reject": {
      if (!actionId) {
        console.error("usage: chatgpt2codex control reject <actionId>");
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
      console.error("usage: chatgpt2codex control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]");
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
  const cloudflaredVersion = await checkCommand("cloudflared", ["--version"]);
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
  console.log(`cloudflared: ${cloudflaredVersion ?? "not found — only required for --quick-tunnel"}`);
  console.log(`workspace: ${workspacePath}`);
  console.log(`state dir: ${stateDir}`);
  console.log(`registered tools: ${toolCount}`);
  console.log(
    `http/oauth: owner token ${ownerTokenReady ? "configured" : "NOT SET — run `chatgpt2codex init` to generate one"}`,
  );
  console.log(`http default endpoint: http://127.0.0.1:7979/mcp (start via \`chatgpt2codex serve --http\`)`);
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
  const executorId =
    typeof flags["executor-id"] === "string" ? flags["executor-id"] : process.env.JK_EXECUTOR_ID ?? "windows-main";
  const tokenFile =
    typeof flags["token-file"] === "string" ? flags["token-file"] : process.env.JK_EXECUTOR_TOKEN_FILE;
  const executorToken = process.env.JK_EXECUTOR_TOKEN ?? (tokenFile ? await readExecutorToken(tokenFile) : "");
  if (!hubUrl) {
    throw new Error("Executor hub is not configured. Set JK_HUB_URL or pass --hub <url>.");
  }
  if (!executorToken) {
    throw new Error(
      "Executor authentication is not configured. Set JK_EXECUTOR_TOKEN or --token-file <path>.",
    );
  }
  await runExecutorWorker({
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
    case "start":
      await cmdServeHttp(flags);
      break;
    case "setup":
      await cmdSetup(flags);
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
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.error(
        "usage: jk <setup|start|serve|init|doctor|owner-token|control|executor> [--workspace <path>] [--quick-tunnel | --public-url <origin>] [--port 7979] [--no-start]",
      );
      break;
    default:
      console.error(
        "usage: jk <setup|start|serve|init|doctor|owner-token|control|executor> [--workspace <path>] [--quick-tunnel | --public-url <origin>] [--port 7979] [--no-start]",
      );
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
