import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import {
  captureE2eUrlScreenshot,
  openE2eTarget,
  startE2eServer,
  stopE2eServer,
} from "./local-e2e.js";

/**
 * captureE2eUrlScreenshot/openE2eTarget drive the owner's real, authenticated
 * Chrome (via osascript) or macOS's `open` to whatever URL they're given.
 * e2e_open_target and e2e_open_url_screenshot's tool handlers (src/server/
 * tools.ts) already validate the URL with isLocalHttpUrl before calling
 * in — but e2e_run_command's `screenshotUrl` input reached
 * captureUrlScreenshot with no caller-side check at all. These tests exercise
 * the defense-in-depth guard added directly inside this module (so every
 * current and future caller is covered, not just the ones that remember to
 * check), proving file://, internal-http, and other non-loopback URLs are
 * refused before any osascript/`open` invocation happens. There was
 * previously no test coverage for this file at all.
 */

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-local-e2e-"));
});

afterEach(async () => {
  // Windows can hold a handle (AV scan / late child exit) briefly after the
  // test body finishes; retry instead of failing cleanup.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(projectRoot, { recursive: true, force: true });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
});

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Poll until the URL stops responding (bounded) instead of asserting
 * immediately after taskkill — Windows releases the listener socket slightly
 * later than the process-exit signal. */
async function expectPortClosed(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      lastError = new Error("still responding");
    } catch {
      return; // connection refused/reset => closed
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError ?? new Error("port never closed");
}

describe("startE2eServer lifecycle", () => {
  it("reuses the same work-session slot and replaces the old server when its command changes", async () => {
    const firstPort = await freeLoopbackPort();
    const secondPort = await freeLoopbackPort();
    const script = path.join(projectRoot, "fixture-server.cjs");
    await fs.writeFile(
      script,
      "require('node:http').createServer((_q,s)=>s.end('ok')).listen(Number(process.argv[2]),'127.0.0.1');",
      "utf8",
    );
    const reuseKey = "proj:ws_test:primary";
    let activePid = 0;

    try {
      const first = await startE2eServer(projectRoot, {
        command: `node fixture-server.cjs ${firstPort}`,
        waitUrl: `http://127.0.0.1:${firstPort}`,
        waitTimeoutSec: 10,
        reuseKey,
      });
      activePid = first.pid;
      expect(first.wait?.ok).toBe(true);

      const reused = await startE2eServer(projectRoot, {
        command: `node fixture-server.cjs ${firstPort}`,
        waitUrl: `http://127.0.0.1:${firstPort}`,
        waitTimeoutSec: 10,
        reuseKey,
      });
      expect(reused.reused).toBe(true);
      expect(reused.pid).toBe(first.pid);

      const replacement = await startE2eServer(projectRoot, {
        command: `node fixture-server.cjs ${secondPort}`,
        waitUrl: `http://127.0.0.1:${secondPort}`,
        waitTimeoutSec: 10,
        reuseKey,
      });
      activePid = replacement.pid;
      expect(replacement.replacedPid).toBe(first.pid);
      expect(replacement.pid).not.toBe(first.pid);
      expect(replacement.wait?.ok).toBe(true);
        await expect(fetch(`http://127.0.0.1:${secondPort}`)).resolves.toMatchObject({ status: 200 });
        await expectPortClosed(firstPort);
    } finally {
      if (activePid) await stopE2eServer({ pid: activePid });
    }
  }, 30_000);
});

describe("captureE2eUrlScreenshot URL guard", () => {
  const nonLocalUrls = [
    "file:///etc/passwd",
    "file:///Users/someone/.ssh/id_rsa",
    "http://169.254.169.254/latest/meta-data/",
    "http://internal-dashboard.corp.example/",
    "https://evil.example/",
    "chrome://settings",
  ];

  for (const url of nonLocalUrls) {
    it(`refuses ${url} before touching osascript/Chrome`, async () => {
      await expect(captureE2eUrlScreenshot(projectRoot, { url })).rejects.toMatchObject({
        code: ErrorCode.APPROVAL_REQUIRED,
      });
    });
  }

  it("still throws a typed DomainError (not a raw string) for a rejected URL", async () => {
    await expect(captureE2eUrlScreenshot(projectRoot, { url: "file:///etc/passwd" })).rejects.toBeInstanceOf(DomainError);
  });

  // Full browser captures are opt-in (JK_E2E_BROWSER=1): the real Edge run
  // happens in the child-process harness below, which needs a clean
  // environment that some CI/worker sandboxes do not provide. Run
  // `npm run windows:e2e:browser` for the full experience.
  const windowsIt = process.platform === "win32" && process.env.JK_E2E_BROWSER === "1" ? it : it.skip;
  // The real Edge/Chromium launch is executed in a child process harness
  // (capture-fixture.mjs): the vitest worker's event loop interferes with the
  // CDP socket lifecycle, but the identical code path is stable as a plain
  // child process. The URL-guard assertions above still exercise this module
  // directly; these tests prove the full Windows capture pipeline end-to-end.
  interface HarnessResult {
    ok: boolean;
    bytes?: number;
    pngSignature?: string;
    targetUrl?: string;
    captureMode?: string;
    error?: string;
    consoleErrors?: string[];
    failedRequests?: string[];
    shots?: Array<{ shotLabel?: string; pngSignature?: string; width?: number; height?: number; mobile?: boolean; hasPreview?: boolean }>;
  }
  const runCaptureHarness = (mode = "single"): Promise<HarnessResult> =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, ["src/e2e/capture-fixture.mjs", mode], { cwd: process.cwd(), timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error && !stdout) { reject(error); return; }
        try { resolve(JSON.parse(stdout.trim().split("\n").pop()!)); } catch (parseError) { reject(parseError as Error); }
      });
    });

  windowsIt("captures a loopback page with installed Edge/Chrome on Windows", async () => {
    const result = await runCaptureHarness();
    expect(result.ok).toBe(true);
    expect(result.captureMode).toBe("browser-region");
    expect(result.bytes!).toBeGreaterThan(0);
    expect(result.pngSignature).toBe("89504e470d0a1a0a");
  });

  windowsIt("captures desktop and mobile top/middle/bottom screenshot sets on Windows", async () => {
    const result = await runCaptureHarness("set");
    expect(result.ok).toBe(true);
    expect(result.shots?.map((shot) => shot.shotLabel)).toEqual([
      "desktop-top",
      "desktop-middle",
      "desktop-bottom",
      "mobile-top",
      "mobile-middle",
      "mobile-bottom",
    ]);
    for (const shot of result.shots ?? []) {
      expect(shot.pngSignature).toBe("89504e470d0a1a0a");
      const expected = shot.mobile ? { width: 390, height: 844 } : { width: 900, height: 600 };
      expect({ width: shot.width, height: shot.height }).toEqual(expected);
      expect(shot.hasPreview).toBe(true);
    }
  });

  windowsIt("collects browser console and network failures on Windows", async () => {
    const result = await runCaptureHarness("diagnostics");
    expect(result.ok).toBe(true);
    expect(result.consoleErrors?.some((entry) => entry.includes("diagnostic-console-error"))).toBe(true);
    expect(result.failedRequests?.some((entry) => entry.includes("404") && entry.includes("/missing"))).toBe(true);
  });
});

describe("openE2eTarget URL guard", () => {
  it("refuses a non-loopback url before calling /usr/bin/open", async () => {
    await expect(openE2eTarget({ url: "file:///etc/passwd" })).rejects.toMatchObject({
      code: ErrorCode.APPROVAL_REQUIRED,
    });
    await expect(openE2eTarget({ url: "smb://evil.example/share" })).rejects.toMatchObject({
      code: ErrorCode.APPROVAL_REQUIRED,
    });
  });
});
