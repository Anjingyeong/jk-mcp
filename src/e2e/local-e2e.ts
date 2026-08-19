import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DomainError, ErrorCode } from "../types.js";
import { resolveInProject } from "../policy/paths.js";
import { redact } from "../policy/secrets.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { guardShellCommand } from "../exec/local-shell.js";
import { CdpWebSocketClient } from "./cdp-websocket.js";

export interface E2eScreenshotResult {
  path: string;
  bytes: number;
  opened: boolean;
  captureMode: "screen" | "browser-region" | "app-window";
  targetUrl?: string;
  targetAppName?: string;
  shotLabel?: string;
  diagnostics?: {
    consoleErrors: string[];
    failedRequests: string[];
  };
}

interface ActiveE2eServer {
  runId: string;
  pid: number;
  cwd: string;
  logPath: string;
  command: string;
  waitUrl?: string;
}

const activeE2eServers = new Map<string, ActiveE2eServer>();

function isProcessAlive(pid: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Mirrors src/server/tools.ts's isLocalHttpUrl (duplicated rather than
 * imported to avoid a circular import: tools.ts already imports from this
 * module). Every current tools.ts caller of openE2eTarget/
 * captureE2eUrlScreenshot's `url` already validates it with that same
 * predicate before calling in (e2e_open_target, e2e_open_url_screenshot,
 * e2e_test_and_show_screenshot) — except e2e_run_command's `screenshotUrl`
 * input, which reached captureE2eUrlScreenshot with no caller-side check at
 * all. Re-validating here, at the two url-accepting entry points
 * themselves, closes that gap and means no future/alternate caller can
 * reopen it either: without this, an attacker-controlled url (file://,
 * cloud-metadata/internal http, chrome://) would drive the owner's real,
 * cookie-bearing Chrome via osascript/`open` and the rendered content would
 * be returned as a screenshot (SSRF + local-file-read). */
function isLocalHttpUrl(value: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(value);
}

function assertLocalHttpUrl(url: string, fnName: string): void {
  if (!isLocalHttpUrl(url)) {
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      `${fnName} only opens local loopback http(s) URLs; external/file/custom-scheme URLs require local approval.`,
    );
  }
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return clean || "e2e";
}

function e2eId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `e2e-${Date.now()}-${digest}`;
}

async function e2eDir(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, ".chatgpt2codex", "e2e");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: buildSafeChildEnv(), windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function captureRegionScreenshot(
  projectRoot: string,
  input: {
    label: string;
    region: string;
    openAfterCapture?: boolean;
    captureMode: "browser-region" | "app-window";
    targetUrl?: string;
    targetAppName?: string;
    shotLabel?: string;
  },
): Promise<E2eScreenshotResult> {
  const root = await fs.realpath(projectRoot);
  const dir = path.join(await e2eDir(root), "screenshots");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${slug(input.label)}.png`);
  await execFileAsync("/usr/sbin/screencapture", ["-x", "-R", input.region, file]);
  const stat = await fs.stat(file);
  if (stat.size === 0) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "macOS Screen Recording permission is required for E2E screenshots. Open ChatGPT To Codex > Screenshot Permission, enable ChatGPT To Codex in System Settings > Privacy & Security > Screen Recording, then retry.",
      { permission: "screen-recording" },
    );
  }
  const opened = input.openAfterCapture === true;
  if (opened) {
    await execFileAsync("/usr/bin/open", [file]);
  }
  return {
    path: file,
    bytes: stat.size,
    opened,
    captureMode: input.captureMode,
    targetUrl: input.targetUrl,
    targetAppName: input.targetAppName,
    shotLabel: input.shotLabel,
  };
}

async function getAppWindowRegion(appName: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application ${appleScriptString(appName)} to activate
    tell application "System Events"
      repeat 80 times
        if exists process ${appleScriptString(appName)} then
          tell process ${appleScriptString(appName)}
            set frontmost to true
            if (count of windows) > 0 then
              set winPos to position of front window
              set winSize to size of front window
              return ((item 1 of winPos) as integer) & "," & ((item 2 of winPos) as integer) & "," & ((item 1 of winSize) as integer) & "," & ((item 2 of winSize) as integer)
            end if
          end tell
        end if
        delay 0.25
      end repeat
    end tell
    error "app window not found"
    `,
  ]);
  const parts = stdout.match(/-?\d+/g);
  if (!parts || parts.length < 4) {
    throw new Error(`invalid app window bounds: ${stdout.trim()}`);
  }
  return parts.slice(0, 4).join(",");
}

async function scrollAppWindow(appName: string): Promise<void> {
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application "System Events"
      if exists process ${appleScriptString(appName)} then
        tell process ${appleScriptString(appName)}
          set frontmost to true
          key code 121
        end tell
      end if
    end tell
    `,
  ]);
}

async function scrollChromePage(fraction: number): Promise<void> {
  const clamped = Math.max(0, Math.min(1, fraction));
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `
    tell application "Google Chrome"
      execute active tab of front window javascript "window.scrollTo(0, Math.max(0, (document.documentElement.scrollHeight - window.innerHeight) * ${clamped}));"
    end tell
    `,
  ]);
}

async function waitForUrl(url: string, timeoutSec: number): Promise<{ ok: boolean; status?: number; error?: string; elapsedMs: number }> {
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.status < 500) {
        return { ok: true, status: res.status, elapsedMs: Date.now() - started };
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  return { ok: false, error: lastError || "timeout", elapsedMs: Date.now() - started };
}

export async function startE2eServer(
  projectRoot: string,
  input: {
    command: string;
    cwd?: string;
    label?: string;
    waitUrl?: string;
    waitTimeoutSec?: number;
    reuseKey?: string;
  },
): Promise<{
  runId: string;
  pid: number;
  cwd: string;
  logPath: string;
  reused?: boolean;
  replacedPid?: number;
  wait?: { ok: boolean; status?: number; error?: string; elapsedMs: number };
}> {
  guardShellCommand(input.command);
  const root = await fs.realpath(projectRoot);
  const commandCwd = input.cwd ? await resolveInProject(root, input.cwd, { allowSymlink: false }) : root;
  const stat = await fs.stat(commandCwd).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "cwd is not a project directory", { cwd: input.cwd });
  }

  const reuseKey = input.reuseKey?.trim() || undefined;
  let replacedPid: number | undefined;
  if (reuseKey) {
    const existing = activeE2eServers.get(reuseKey);
    if (existing && isProcessAlive(existing.pid)) {
      const sameServer =
        existing.command === input.command &&
        existing.cwd === (path.relative(root, commandCwd) || ".") &&
        existing.waitUrl === input.waitUrl;
      if (sameServer) {
        const wait = input.waitUrl ? await waitForUrl(input.waitUrl, input.waitTimeoutSec ?? 30) : undefined;
        return { ...existing, reused: true, wait };
      }
      replacedPid = existing.pid;
      await stopE2eServer({ pid: existing.pid });
    }
    activeE2eServers.delete(reuseKey);
  }

  const dir = await e2eDir(root);
  const runId = e2eId(input.command);
  const logPath = path.join(dir, `${runId}-${slug(input.label ?? "server")}.log`);
  const out = await fs.open(logPath, "a");
  const shell =
    process.platform === "win32"
      ? process.env.ComSpec || process.env.COMSPEC || "cmd.exe"
      : process.platform === "darwin"
        ? "/bin/zsh"
        : "/bin/sh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];
  const child = spawn(shell, shellArgs, {
    cwd: commandCwd,
    env: buildSafeChildEnv(),
    detached: true,
    stdio: ["ignore", out.fd, out.fd],
    windowsHide: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    await out.close().catch(() => undefined);
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Unable to start E2E server with ${shell}`, {
      cause: summarizeE2eError(error),
    });
  }
  child.unref();
  await out.close();

  const wait = input.waitUrl ? await waitForUrl(input.waitUrl, input.waitTimeoutSec ?? 30) : undefined;
  const result = {
    runId,
    pid: child.pid ?? 0,
    cwd: path.relative(root, commandCwd) || ".",
    logPath,
    replacedPid,
    wait,
  };
  if (reuseKey && result.pid > 0) {
    activeE2eServers.set(reuseKey, {
      runId: result.runId,
      pid: result.pid,
      cwd: result.cwd,
      logPath: result.logPath,
      command: input.command,
      waitUrl: input.waitUrl,
    });
  }
  return result;
}

export async function stopE2eServer(input: { pid: number }): Promise<{ stopped: boolean; error?: string }> {
  if (!input.pid || input.pid < 1) {
    return { stopped: false, error: "missing pid" };
  }
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/pid", String(input.pid), "/t", "/f"]);
      for (const [key, server] of activeE2eServers) if (server.pid === input.pid) activeE2eServers.delete(key);
      return { stopped: true };
    } catch (error) {
      const message = summarizeE2eError(error);
      if (/not found|no running instance|not running/i.test(message)) {
        for (const [key, server] of activeE2eServers) if (server.pid === input.pid) activeE2eServers.delete(key);
        return { stopped: true };
      }
      return { stopped: false, error: message };
    }
  }
  try {
    process.kill(-input.pid, "SIGTERM");
    await delay(500);
    for (const [key, server] of activeE2eServers) if (server.pid === input.pid) activeE2eServers.delete(key);
    return { stopped: true };
  } catch (error) {
    const message = summarizeE2eError(error);
    if (/not found|no such process|not running/i.test(message)) {
      for (const [key, server] of activeE2eServers) if (server.pid === input.pid) activeE2eServers.delete(key);
      return { stopped: true };
    }
    return { stopped: false, error: message };
  }
}

export async function openE2eTarget(input: { url?: string; appName?: string; appPath?: string; args?: string[] }): Promise<{
  launched: string;
}> {
  if (input.url) {
    assertLocalHttpUrl(input.url, "openE2eTarget");
    if (process.platform === "win32") {
      await execFileAsync("rundll32.exe", ["url.dll,FileProtocolHandler", input.url]);
    } else {
      await execFileAsync("/usr/bin/open", [input.url]);
    }
    return { launched: input.url };
  }
  if (input.appPath) {
    if (process.platform === "win32") {
      const child = spawn(input.appPath, input.args ?? [], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        env: buildSafeChildEnv(),
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } else {
      await execFileAsync("/usr/bin/open", [input.appPath, ...(input.args?.length ? ["--args", ...input.args] : [])]);
    }
    return { launched: input.appPath };
  }
  if (input.appName) {
    if (process.platform === "win32") {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "On Windows, pass appPath instead of appName for desktop-app E2E.");
    }
    await execFileAsync("/usr/bin/open", ["-a", input.appName, ...(input.args?.length ? ["--args", ...input.args] : [])]);
    return { launched: input.appName };
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Provide url, appName, or appPath");
}

export interface E2eScreenshotPreview {
  path: string;
  bytes: number;
  mimeType: "image/jpeg";
}

type WindowsUrlScreenshotInput = {
  url: string;
  label?: string;
  waitMs?: number;
  openAfterCapture?: boolean;
  width?: number;
  height?: number;
};

type WindowsViewport = {
  name: "desktop" | "mobile";
  width: number;
  height: number;
  mobile: boolean;
};

type WindowsShot = {
  name: "top" | "middle" | "bottom";
  fraction: number;
};

type WindowsDebugTarget = {
  id: string;
  type: string;
  webSocketDebuggerUrl?: string;
};

const PREVIEW_MAX_DIMENSION = "1200";
const PREVIEW_JPEG_QUALITY = "70";

/**
 * Downscaled JPEG preview of a captured PNG screenshot, written next to the
 * original as `<name>-preview.jpg`. Full-resolution retina PNGs are too large
 * to inline into chat clients; the preview keeps inline delivery (widget data
 * URIs, MCP image content) small. Returns null when sips is unavailable or
 * conversion fails so callers can fall back to the original PNG.
 */
export async function createE2eScreenshotPreview(screenshotPath: string): Promise<E2eScreenshotPreview | null> {
  if (!screenshotPath.endsWith(".png")) return null;
  const previewPath = `${screenshotPath.slice(0, -4)}-preview.jpg`;
  try {
    const existing = await fs.stat(previewPath).catch(() => null);
    if (!existing?.isFile() || existing.size === 0) {
      await execFileAsync("/usr/bin/sips", [
        "--resampleHeightWidthMax",
        PREVIEW_MAX_DIMENSION,
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        PREVIEW_JPEG_QUALITY,
        screenshotPath,
        "--out",
        previewPath,
      ]);
    }
    const stat = await fs.stat(previewPath);
    if (!stat.isFile() || stat.size === 0) return null;
    return { path: previewPath, bytes: stat.size, mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

async function findWindowsBrowserExecutable(): Promise<string> {
  const systemDrive = process.env.SystemDrive ?? "C:";
  const candidates = [
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"]!, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(systemDrive, "Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(systemDrive, "Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"]!, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(systemDrive, "Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(systemDrive, "Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next well-known install location.
    }
  }

  throw new DomainError(
    ErrorCode.NOT_IMPLEMENTED,
    "Windows URL screenshots require an installed Microsoft Edge or Google Chrome browser.",
  );
}

async function waitForWindowsDevToolsPort(profileDir: string, browserProcess: ReturnType<typeof spawn>): Promise<number> {
  const activePortFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null) {
      throw new Error(`Chromium exited before DevTools became ready (exit ${browserProcess.exitCode})`);
    }
    try {
      const contents = await fs.readFile(activePortFile, "utf8");
      const port = Number(contents.split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch {
      // DevToolsActivePort is created asynchronously after Chromium starts.
    }
    await delay(75);
  }
  throw new Error("Timed out waiting for Chromium DevToolsActivePort");
}

async function getWindowsPageTarget(port: number): Promise<WindowsDebugTarget> {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Chromium DevTools target list returned HTTP ${response.status}`);
  const targets = (await response.json()) as WindowsDebugTarget[];
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error("Chromium DevTools did not expose a page target websocket");
  return page;
}

async function waitForWindowsDocumentReady(cdp: CdpWebSocketClient, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evaluated = await cdp.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      { expression: "document.readyState", returnByValue: true },
      3_000,
    );
    const readyState = evaluated.result?.value;
    if (readyState === "complete" || readyState === "interactive") return;
    await delay(75);
  }
  throw new Error("Timed out waiting for the browser document to become ready");
}

async function captureWindowsViewportShots(
  cdp: CdpWebSocketClient,
  dir: string,
  input: WindowsUrlScreenshotInput,
  viewport: WindowsViewport,
  shots: WindowsShot[],
): Promise<E2eScreenshotResult[]> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: viewport.mobile,
    maxTouchPoints: viewport.mobile ? 5 : 1,
  });
  const navigation = await cdp.send<{ errorText?: string }>("Page.navigate", { url: input.url }, 20_000);
  if (navigation.errorText) throw new Error(`Chromium navigation failed: ${navigation.errorText}`);
  await waitForWindowsDocumentReady(cdp);
  if (input.waitMs && input.waitMs > 0) await delay(Math.min(input.waitMs, 30_000));

  const metrics = await cdp.send<{ result?: { value?: { scrollHeight?: number } } }>("Runtime.evaluate", {
    expression:
      "({scrollHeight: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0)})",
    returnByValue: true,
  });
  const scrollHeight = Math.max(viewport.height, Number(metrics.result?.value?.scrollHeight ?? viewport.height));
  const maxScrollY = Math.max(0, scrollHeight - viewport.height);
  const results: E2eScreenshotResult[] = [];

  for (const shot of shots) {
    const scrollY = Math.round(maxScrollY * shot.fraction);
    await cdp.send("Runtime.evaluate", {
      expression: `new Promise((resolve) => { document.documentElement.style.scrollBehavior = 'auto'; if (document.body) document.body.style.scrollBehavior = 'auto'; window.scrollTo(0, ${scrollY}); requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); })`,
      awaitPromise: true,
      returnByValue: true,
    });
    await delay(Math.min(input.waitMs ?? 350, 1_000));

    const captured = await cdp.send<{ data?: string }>(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true },
      20_000,
    );
    if (!captured.data) throw new Error("Chromium DevTools returned an empty screenshot payload");

    const shotLabel = `${viewport.name}-${shot.name}`;
    const file = path.join(dir, `${Date.now()}-${slug(`${input.label ?? "url"}-${shotLabel}`)}.png`);
    await fs.writeFile(file, Buffer.from(captured.data, "base64"));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) throw new Error("Chromium produced an empty Windows E2E screenshot");

    // Keep ChatGPT connector payloads small without requiring macOS `sips`.
    // The normal preview helper will reuse this file when it already exists.
    try {
      const preview = await cdp.send<{ data?: string }>(
        "Page.captureScreenshot",
        { format: "jpeg", quality: Number(PREVIEW_JPEG_QUALITY), fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true },
        20_000,
      );
      if (preview.data) {
        await fs.writeFile(`${file.slice(0, -4)}-preview.jpg`, Buffer.from(preview.data, "base64"));
      }
    } catch {
      // Preview generation is best effort; the full-resolution PNG is still valid proof.
    }
    results.push({
      path: file,
      bytes: stat.size,
      opened: false,
      captureMode: "browser-region",
      targetUrl: input.url,
      shotLabel,
    });
  }
  return results;
}

async function captureWindowsUrlScreenshotSetInternal(
  projectRoot: string,
  input: WindowsUrlScreenshotInput,
  viewports: WindowsViewport[],
  shots: WindowsShot[],
): Promise<E2eScreenshotResult[]> {
  const root = await fs.realpath(projectRoot);
  const dir = path.join(await e2eDir(root), "screenshots");
  await fs.mkdir(dir, { recursive: true });
  const browserExecutable = await findWindowsBrowserExecutable();
  const profileDir = path.join(await e2eDir(root), `browser-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(profileDir, { recursive: true });
  let browserProcess: ReturnType<typeof spawn> | undefined;
  let cdp: CdpWebSocketClient | undefined;
  let stderr = "";
  try {
    browserProcess = spawn(browserExecutable, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ], {
      env: buildSafeChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    browserProcess.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8").slice(0, 8_000 - stderr.length);
    });

    const port = await waitForWindowsDevToolsPort(profileDir, browserProcess);
    const pageTarget = await getWindowsPageTarget(port);
    cdp = await CdpWebSocketClient.connect(pageTarget.webSocketDebuggerUrl!);
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const requestUrls = new Map<string, string>();
    cdp.on("Network.requestWillBeSent", (params) => {
      const event = params as { requestId?: string; request?: { url?: string } } | undefined;
      if (event?.requestId && event.request?.url) requestUrls.set(event.requestId, event.request.url);
    });
    cdp.on("Network.loadingFailed", (params) => {
      const event = params as { requestId?: string; errorText?: string; canceled?: boolean } | undefined;
      if (!event || event.canceled) return;
      const url = event.requestId ? requestUrls.get(event.requestId) : undefined;
      failedRequests.push(`${event.errorText ?? "request failed"}${url ? ` ${url}` : ""}`.slice(0, 1_200));
    });
    cdp.on("Network.responseReceived", (params) => {
      const event = params as { response?: { status?: number; url?: string } } | undefined;
      const status = Number(event?.response?.status ?? 0);
      if (status >= 400) failedRequests.push(`HTTP ${status} ${event?.response?.url ?? ""}`.slice(0, 1_200));
    });
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const event = params as { type?: string; args?: Array<{ value?: unknown; description?: string }> } | undefined;
      if (!event || (event.type !== "error" && event.type !== "warning")) return;
      const text = (event.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? ""))
        .filter(Boolean)
        .join(" ");
      if (text) consoleErrors.push(`${event.type}: ${text}`.slice(0, 1_000));
    });
    cdp.on("Runtime.exceptionThrown", (params) => {
      const event = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined;
      const text = event?.exceptionDetails?.exception?.description ?? event?.exceptionDetails?.text;
      if (text) consoleErrors.push(`exception: ${text}`.slice(0, 1_000));
    });
    cdp.on("Log.entryAdded", (params) => {
      const event = params as { entry?: { level?: string; text?: string } } | undefined;
      if (!event?.entry || (event.entry.level !== "error" && event.entry.level !== "warning")) return;
      if (event.entry.text) consoleErrors.push(`${event.entry.level}: ${event.entry.text}`.slice(0, 1_000));
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Log.enable");

    const results: E2eScreenshotResult[] = [];
    for (const viewport of viewports) {
      results.push(...(await captureWindowsViewportShots(cdp, dir, input, viewport, shots)));
    }
    const diagnostics = {
      consoleErrors: [...new Set(consoleErrors)].slice(0, 50),
      failedRequests: [...new Set(failedRequests)].slice(0, 50),
    };
    for (const result of results) result.diagnostics = diagnostics;
    if (input.openAfterCapture && results[0]) {
      await execFileAsync("explorer.exe", [results[0].path]).catch(() => undefined);
      results[0].opened = true;
    }
    return results;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Windows Chromium E2E screenshot capture failed.", {
      cause: summarizeE2eError(error),
      browserStderr: redact(stderr.trim()).slice(0, 2_000),
    });
  } finally {
    cdp?.close();
    await delay(50);
    if (browserProcess?.pid && browserProcess.exitCode === null) {
      await new Promise<void>((resolve) => {
        execFile("taskkill.exe", ["/pid", String(browserProcess!.pid), "/t", "/f"], { windowsHide: true }, () => resolve());
      });
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fs.rm(profileDir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM") break;
        await delay(100 * (attempt + 1));
      }
    }
  }
}

async function captureWindowsUrlScreenshot(
  projectRoot: string,
  input: WindowsUrlScreenshotInput,
  label: string,
  shotLabel?: string,
): Promise<E2eScreenshotResult> {
  const [result] = await captureWindowsUrlScreenshotSetInternal(
    projectRoot,
    { ...input, label, openAfterCapture: input.openAfterCapture },
    [{ name: "desktop", width: input.width ?? 1440, height: input.height ?? 900, mobile: false }],
    [{ name: "top", fraction: 0 }],
  );
  if (!result) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Windows Chromium did not return an E2E screenshot.");
  result.shotLabel = shotLabel;
  return result;
}

export async function captureE2eScreenshot(
  projectRoot: string,
  input: { label?: string; waitMs?: number; openAfterCapture?: boolean },
): Promise<E2eScreenshotResult> {
  if (process.platform !== "darwin") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "screencapture-based E2E screenshots are currently supported on macOS");
  }
  if (input.waitMs && input.waitMs > 0) {
    await delay(Math.min(input.waitMs, 30_000));
  }
  const root = await fs.realpath(projectRoot);
  const dir = path.join(await e2eDir(root), "screenshots");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${slug(input.label ?? "screen")}.png`);
  try {
    await execFileAsync("/usr/sbin/screencapture", ["-x", file]);
  } catch (error) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "macOS Screen Recording permission is required for E2E screenshots. Open ChatGPT To Codex > Screenshot Permission, enable ChatGPT To Codex in System Settings > Privacy & Security > Screen Recording, then retry.",
      { permission: "screen-recording", cause: summarizeE2eError(error) },
    );
  }
  const stat = await fs.stat(file);
  if (stat.size === 0) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "macOS Screen Recording permission is required for E2E screenshots. Open ChatGPT To Codex > Screenshot Permission, enable ChatGPT To Codex in System Settings > Privacy & Security > Screen Recording, then retry.",
      { permission: "screen-recording" },
    );
  }
  const opened = input.openAfterCapture === true;
  if (opened) {
    await execFileAsync("/usr/bin/open", [file]);
  }
  return { path: file, bytes: stat.size, opened, captureMode: "screen" };
}

export async function captureE2eUrlScreenshot(
  projectRoot: string,
  input: {
    url: string;
    label?: string;
    waitMs?: number;
    openAfterCapture?: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  },
): Promise<E2eScreenshotResult> {
  assertLocalHttpUrl(input.url, "captureE2eUrlScreenshot");
  if (process.platform === "win32") {
    return captureWindowsUrlScreenshot(projectRoot, input, input.label ?? "url", input.label);
  }
  if (process.platform !== "darwin") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "browser-region E2E screenshots are currently supported on macOS and Windows");
  }
  const x = input.x ?? 80;
  const y = input.y ?? 80;
  const width = input.width ?? 1440;
  const height = input.height ?? 900;

  try {
    const right = x + width;
    const bottom = y + height;
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      `
      tell application "Google Chrome"
        activate
        if (count of windows) = 0 then make new window
        set bounds of front window to {${x}, ${y}, ${right}, ${bottom}}
        set URL of active tab of front window to ${appleScriptString(input.url)}
      end tell
      `,
    ]);
  } catch {
    await openE2eTarget({ url: input.url });
    return captureE2eScreenshot(projectRoot, {
      label: input.label ?? "url-fallback",
      waitMs: input.waitMs ?? 1500,
      openAfterCapture: input.openAfterCapture,
    });
  }

  if (input.waitMs && input.waitMs > 0) {
    await delay(Math.min(input.waitMs, 30_000));
  }
  return captureRegionScreenshot(projectRoot, {
    label: input.label ?? "url",
    region: `${x},${y},${width},${height}`,
    openAfterCapture: input.openAfterCapture,
    captureMode: "browser-region",
    targetUrl: input.url,
    shotLabel: input.label,
  });
}

export async function captureE2eUrlScreenshotSet(
  projectRoot: string,
  input: {
    url: string;
    label?: string;
    waitMs?: number;
    openAfterCapture?: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  },
): Promise<E2eScreenshotResult[]> {
  assertLocalHttpUrl(input.url, "captureE2eUrlScreenshotSet");
  if (process.platform === "win32") {
    return captureWindowsUrlScreenshotSetInternal(
      projectRoot,
      input,
      [
        { name: "desktop", width: input.width ?? 1440, height: input.height ?? 900, mobile: false },
        { name: "mobile", width: 390, height: 844, mobile: true },
      ],
      [
        { name: "top", fraction: 0 },
        { name: "middle", fraction: 0.5 },
        { name: "bottom", fraction: 1 },
      ],
    );
  }
  const x = input.x ?? 80;
  const y = input.y ?? 80;
  const width = input.width ?? 1440;
  const height = input.height ?? 900;
  const shots: E2eScreenshotResult[] = [];
  shots.push(
    await captureE2eUrlScreenshot(projectRoot, {
      ...input,
      label: `${input.label ?? "url"}-top`,
      openAfterCapture: false,
    }),
  );
  for (const [shotLabel, fraction] of [
    ["middle", 0.5],
    ["bottom", 1],
  ] as const) {
    try {
      await scrollChromePage(fraction);
      await delay(input.waitMs ?? 900);
      shots.push(
        await captureRegionScreenshot(projectRoot, {
          label: `${input.label ?? "url"}-${shotLabel}`,
          region: `${x},${y},${width},${height}`,
          openAfterCapture: false,
          captureMode: "browser-region",
          targetUrl: input.url,
          shotLabel,
        }),
      );
    } catch {
      // A page may not be scrollable or Chrome automation may be unavailable.
    }
  }
  if (input.openAfterCapture && shots[0]) {
    await execFileAsync("/usr/bin/open", [shots[0].path]);
    shots[0].opened = true;
  }
  return shots;
}

export async function captureE2eAppScreenshot(
  projectRoot: string,
  input: {
    appName: string;
    label?: string;
    waitMs?: number;
    openAfterCapture?: boolean;
  },
): Promise<E2eScreenshotResult> {
  if (process.platform !== "darwin") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "app-window E2E screenshots are currently supported on macOS");
  }
  if (input.waitMs && input.waitMs > 0) {
    await delay(Math.min(input.waitMs, 30_000));
  }

  let region = "";
  try {
    region = await getAppWindowRegion(input.appName);
  } catch (error) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      `macOS Accessibility permission is required to capture the ${input.appName} app window. Enable ChatGPT To Codex in System Settings > Privacy & Security > Accessibility, then retry.`,
      { permission: "accessibility", appName: input.appName, cause: summarizeE2eError(error) },
    );
  }

  return captureRegionScreenshot(projectRoot, {
    label: input.label ?? input.appName,
    region,
    openAfterCapture: input.openAfterCapture,
    captureMode: "app-window",
    targetAppName: input.appName,
    shotLabel: input.label,
  });
}

export async function captureE2eAppScreenshotSet(
  projectRoot: string,
  input: {
    appName: string;
    label?: string;
    waitMs?: number;
    openAfterCapture?: boolean;
  },
): Promise<E2eScreenshotResult[]> {
  const shots: E2eScreenshotResult[] = [];
  shots.push(
    await captureE2eAppScreenshot(projectRoot, {
      ...input,
      label: `${input.label ?? input.appName}-top`,
      openAfterCapture: false,
    }),
  );
  for (const shotLabel of ["middle", "bottom"] as const) {
    try {
      await scrollAppWindow(input.appName);
      await delay(input.waitMs ?? 900);
      shots.push(
        await captureE2eAppScreenshot(projectRoot, {
          ...input,
          label: `${input.label ?? input.appName}-${shotLabel}`,
          openAfterCapture: false,
        }),
      );
    } catch {
      // Some app windows do not accept Page Down; keep the successful shots.
    }
  }
  if (input.openAfterCapture && shots[0]) {
    await execFileAsync("/usr/bin/open", [shots[0].path]);
    shots[0].opened = true;
  }
  return shots;
}

export function summarizeE2eError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
