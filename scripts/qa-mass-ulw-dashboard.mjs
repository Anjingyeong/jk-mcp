import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, watch } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { resolveMassUlwExecutionId } from "../dist/orchestration/mass-ulw-identity-index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const evidenceDir = path.join(repoRoot, "evidence", "mass-ulw", "dashboard");
const browserExecutable =
  process.env.JK_QA_BROWSER ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const requiredLabels = [
  "Current MASS ULW wave",
  "Running MASS ULW lanes",
  "Blocked MASS ULW dependencies",
  "MASS ULW verification",
];

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve a TCP port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForFile(target) {
  try {
    await stat(target);
    return;
  } catch {
    // Subscribe before the producer creates the file.
  }
  const directory = path.dirname(target);
  const watcher = watch(directory);
  try {
    await withTimeout((async () => {
      for await (const event of watcher) {
        if (event.filename === path.basename(target)) return;
      }
    })(), 15_000, `file event for ${target}`);
  } finally {
    await watcher.return?.();
  }
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    socket.addEventListener("message", (event) => this.onMessage(JSON.parse(String(event.data))));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await withTimeout(once(socket, "open"), 15_000, "CDP websocket open");
    return new CdpClient(socket);
  }

  onMessage(message) {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    const waiters = this.waiters.get(message.method) ?? [];
    this.waiters.delete(message.method);
    for (const resolve of waiters) resolve(message.params);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method) {
    return new Promise((resolve) => {
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), resolve]);
    });
  }

  close() {
    this.socket.close();
  }
}

async function stopChild(child) {
  if (!child) return;
  const closed = once(child, "close");
  if (child.exitCode === null) child.kill();
  try {
    await withTimeout(closed, 5_000, `process ${child.pid} close`);
    return;
  } catch (error) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
  await withTimeout(closed, 5_000, `forced process ${child.pid} close`);
}

let tempRoot;
let server;
let browser;
let page;
const report = {
  pass: false,
  scenario: "live Control Center MASS ULW status",
  labels: [],
  actionLog: [],
  screenshot: path.join(evidenceDir, "mass-ulw-dashboard.png"),
  cleanup: { serverStopped: false, browserStopped: false, tempRemoved: false },
};

try {
  await mkdir(evidenceDir, { recursive: true });
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "mass-ulw-dashboard-"));
  const home = path.join(tempRoot, "home");
  const workspace = path.join(tempRoot, "workspace");
  const project = path.join(workspace, "demo");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "mass-ulw-dashboard-demo" }));

  const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
  const cli = path.join(repoRoot, "dist", "cli.js");
  const initialized = spawnSync(process.execPath, [cli, "init", "--workspace", workspace], {
    cwd: repoRoot,
    env: childEnv,
    encoding: "utf8",
  });
  if (initialized.status !== 0) throw new Error(initialized.stderr || initialized.stdout);
  const generatedToken = spawnSync(process.execPath, [cli, "owner-token", "--generate", "--workspace", workspace], {
    cwd: repoRoot,
    env: childEnv,
    encoding: "utf8",
  });
  if (generatedToken.status !== 0) throw new Error(generatedToken.stderr || generatedToken.stdout);
  const ownerToken = JSON.parse(generatedToken.stdout).ownerToken;
  if (typeof ownerToken !== "string") throw new Error("owner-token --generate did not return a token");

  const stateDir = path.join(home, ".local", "share", "chatgpt2codex");
  const projects = JSON.parse(await readFile(path.join(stateDir, "projects.json"), "utf8"));
  const projectId = projects.projects?.[0]?.projectId ?? projects[0]?.projectId;
  if (typeof projectId !== "string") throw new Error("init did not register the demo project");

  const port = await reservePort();
  server = spawn(process.execPath, [cli, "serve", "--http", "--port", String(port), "--workspace", workspace], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  const ready = new Promise((resolve) => {
    server.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("listening on")) resolve();
    });
  });
  await withTimeout(ready, 15_000, "JK HTTP server ready");
  report.actionLog.push({ action: "server-ready", url: `http://127.0.0.1:${port}` });

  const goalResponse = await fetch(`http://127.0.0.1:${port}/actions/goal-loop`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      goal: "Render a live MASS ULW dashboard fixture",
      projectId,
      pending: ["backend", "frontend", "integration"],
      fanoutCandidates: [
        { id: "backend", task: "Backend lane", estimatedWeight: 4, writeScopes: ["src/backend"] },
        { id: "frontend", task: "Frontend lane", estimatedWeight: 4, writeScopes: ["src/frontend"] },
        {
          id: "integration",
          task: "Integration lane",
          estimatedWeight: 4,
          readScopes: ["src/backend", "src/frontend"],
          writeScopes: ["src/integration"],
          dependsOn: ["backend", "frontend"],
        },
      ],
    }),
  });
  const goalBody = await goalResponse.json();
  if (!goalResponse.ok || goalBody.ok !== true) throw new Error(`goal-loop failed: ${JSON.stringify(goalBody)}`);
  const loopId = goalBody.structuredContent?.loopId;
  if (typeof loopId !== "string") throw new Error("goal-loop did not return loopId");

  const executionId = await resolveMassUlwExecutionId(stateDir, {
    projectId,
    externalLoopId: loopId,
  });
  if (!executionId) throw new Error("goal-loop did not persist a scoped MASS ULW identity index");
  const statePath = path.join(stateDir, "orchestration", "mass-ulw", `${executionId}.json`);
  const execution = JSON.parse(await readFile(statePath, "utf8"));
  execution.currentWave = 0;
  execution.waves[0].status = "in-flight";
  execution.lanes.backend.status = "failed";
  execution.lanes.backend.attempts = 1;
  execution.lanes.frontend.status = "in-flight";
  execution.lanes.frontend.attempts = 1;
  execution.integrationVerification = {
    status: "in-flight",
    attemptId: "qa-integration-verification",
    fingerprint: "qa-verification-fingerprint",
    startedAt: Date.now(),
  };
  await writeFile(statePath, `${JSON.stringify(execution, null, 2)}\n`, { mode: 0o600 });
  report.actionLog.push({ action: "persisted-running-fixture", loopId });

  const profile = path.join(tempRoot, "browser-profile");
  await mkdir(profile, { recursive: true });
  browser = spawn(browserExecutable, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });
  const activePortPath = path.join(profile, "DevToolsActivePort");
  await waitForFile(activePortPath);
  const [debugPort] = (await readFile(activePortPath, "utf8")).trim().split(/\r?\n/u);
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about%3Ablank`, { method: "PUT" })).json();
  page = await CdpClient.connect(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const loaded = page.waitFor("Page.loadEventFired");
  await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await withTimeout(loaded, 15_000, "dashboard load");

  const visible = await withTimeout(page.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const required = ${JSON.stringify(requiredLabels)};
      const check = () => {
        const labels = [...document.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label'));
        if (required.every((label) => labels.includes(label))) {
          resolve({ labels: required, text: document.body.innerText });
          return true;
        }
        return false;
      };
      if (check()) return;
      const observer = new MutationObserver(() => {
        if (check()) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })`,
  }), 15_000, "MASS ULW dashboard labels");
  const pageValue = visible.result.value;
  if (!requiredLabels.every((label) => pageValue.labels.includes(label))) {
    throw new Error(`missing dashboard labels: ${JSON.stringify(pageValue.labels)}`);
  }
  for (const text of ["Wave 0", "Running frontend", "Blocked backend", "Verification in-flight"]) {
    if (!pageValue.text.includes(text)) throw new Error(`dashboard text missing ${text}`);
  }
  report.labels = pageValue.labels;
  report.actionLog.push({ action: "assert-visible", text: ["Wave 0", "Running frontend", "Blocked backend", "Verification in-flight"] });

  const capture = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const screenshot = Buffer.from(capture.data, "base64");
  if (screenshot.length === 0) throw new Error("dashboard screenshot is empty");
  await writeFile(report.screenshot, screenshot);
  if ((await stat(report.screenshot)).size === 0) throw new Error("dashboard screenshot was not written");
  report.pass = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  page?.close();
  try {
    await stopChild(browser);
    report.cleanup.browserStopped = true;
    await stopChild(server);
    report.cleanup.serverStopped = true;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    report.cleanup.tempRemoved = tempRoot ? await stat(tempRoot).then(() => false, () => true) : true;
  } catch (error) {
    report.error = `${report.error ?? ""}\ncleanup: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    report.pass = report.pass && report.cleanup.browserStopped && report.cleanup.serverStopped && report.cleanup.tempRemoved;
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "action-log.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
