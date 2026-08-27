// Standalone capture harness used by local-e2e.test.ts on Windows. Running
// the real Edge/Chromium capture inside a vitest worker is flaky (the worker
// event loop interferes with the CDP socket lifecycle), but the identical
// code path run in a plain child process is stable. The test spawns this
// script and asserts on the JSON result printed to stdout.
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const mode = process.argv[2] ?? "single";
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-capture-fx-"));
const server = http.createServer((q, r) => {
  if (mode === "diagnostics" && q.url === "/missing") {
    r.writeHead(404, { "content-type": "text/plain" });
    r.end("missing");
    return;
  }
  r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (mode === "set") {
  r.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0">' +
    '<section style="height:1100px;background:#eee"><h1>Top</h1></section>' +
    '<section style="height:1100px;background:#ccc"><h1>Middle</h1></section>' +
    '<section style="height:1100px;background:#aaa"><h1>Bottom</h1></section>' +
    '</body></html>');
    return;
  }
  if (mode === "diagnostics") {
  r.end('<!doctype html><html><body><h1>Diagnostics</h1><script>' +
    'console.error("diagnostic-console-error");' +
    'fetch("/missing").catch(() => {});' +
    '</script></body></html>');
    return;
  }
  r.end("<!doctype html><html><body><h1>capture-fixture</h1></body></html>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
try {
  const mod = await import("../../dist/e2e/local-e2e.js");
  if (mode === "set") {
    const results = await mod.captureE2eUrlScreenshotSet(projectRoot, {
      url: "http://127.0.0.1:" + port + "/",
      label: "windows-set-harness",
      waitMs: 100,
      width: 900,
      height: 600,
    });
    const shots = [];
    for (const result of results) {
      const png = await fs.readFile(result.path);
      shots.push({
        shotLabel: result.shotLabel,
        pngSignature: png.subarray(0, 8).toString("hex"),
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        mobile: result.shotLabel?.startsWith("mobile-") ?? false,
        hasPreview: await fs.access(result.path.slice(0, -4) + "-preview.jpg").then(() => true, () => false),
      });
    }
    process.stdout.write(JSON.stringify({ ok: true, shots }) + "\\n");
  } else {
    const result = await mod.captureE2eUrlScreenshot(projectRoot, {
      url: "http://127.0.0.1:" + port + "/",
      label: mode === "diagnostics" ? "windows-diag-harness" : "windows-harness",
      waitMs: 250,
      width: 800,
      height: 600,
    });
    const png = await fs.readFile(result.path);
    process.stdout.write(JSON.stringify({
      ok: true,
      bytes: result.bytes,
      pngSignature: png.subarray(0, 8).toString("hex"),
      targetUrl: result.targetUrl,
      captureMode: result.captureMode,
      consoleErrors: result.diagnostics?.consoleErrors ?? [],
      failedRequests: result.diagnostics?.failedRequests ?? [],
    }) + "\\n");
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }) + "\\n");
} finally {
  server.close();
  await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
}
