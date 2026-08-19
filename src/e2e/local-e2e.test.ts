import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import {
  captureE2eUrlScreenshot,
  captureE2eUrlScreenshotSet,
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
  await fs.rm(projectRoot, { recursive: true, force: true });
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
      await expect(fetch(`http://127.0.0.1:${firstPort}`)).rejects.toBeDefined();
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

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("captures a loopback page with installed Edge/Chrome on Windows", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><h1>Windows E2E Screenshot</h1></body></html>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const url = `http://127.0.0.1:${address.port}/`;
      const result = await captureE2eUrlScreenshot(projectRoot, {
        url,
        label: "windows-loopback",
        waitMs: 250,
        width: 800,
        height: 600,
      });

      expect(result.captureMode).toBe("browser-region");
      expect(result.targetUrl).toBe(url);
      expect(result.bytes).toBeGreaterThan(0);
      const signature = (await fs.readFile(result.path)).subarray(0, 8).toString("hex");
      expect(signature).toBe("89504e470d0a1a0a");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  windowsIt("captures desktop and mobile top/middle/bottom screenshot sets on Windows", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="margin:0">
          <section style="height:1100px;background:#eee"><h1>Top</h1></section>
          <section style="height:1100px;background:#ccc"><h1>Middle</h1></section>
          <section style="height:1100px;background:#aaa"><h1>Bottom</h1></section>
        </body></html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const url = `http://127.0.0.1:${address.port}/`;
      const results = await captureE2eUrlScreenshotSet(projectRoot, {
        url,
        label: "windows-set",
        waitMs: 100,
        width: 900,
        height: 600,
      });

      expect(results.map((result) => result.shotLabel)).toEqual([
        "desktop-top",
        "desktop-middle",
        "desktop-bottom",
        "mobile-top",
        "mobile-middle",
        "mobile-bottom",
      ]);
      for (const result of results) {
        const png = await fs.readFile(result.path);
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        const expected = result.shotLabel?.startsWith("mobile-") ? { width: 390, height: 844 } : { width: 900, height: 600 };
        expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual(expected);
        const preview = await fs.readFile(`${result.path.slice(0, -4)}-preview.jpg`);
        expect(preview.subarray(0, 2).toString("hex")).toBe("ffd8");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  windowsIt("collects browser console and network failures on Windows", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/missing") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("missing");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body><h1>Diagnostics</h1><script>
        console.error("diagnostic-console-error");
        fetch("/missing").catch(() => {});
      </script></body></html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const url = `http://127.0.0.1:${address.port}/`;
      const result = await captureE2eUrlScreenshot(projectRoot, { url, waitMs: 250 });
      expect(result.diagnostics?.consoleErrors.some((entry) => entry.includes("diagnostic-console-error"))).toBe(true);
      expect(result.diagnostics?.failedRequests.some((entry) => entry.includes("404") && entry.includes("/missing"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
