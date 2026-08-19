import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WINDOWS_EXECUTOR_BOOTSTRAP_JS } from "./windows-bootstrap.js";

describe("standalone Windows executor bootstrap", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  it("discovers a project, heartbeats, executes code_search, and returns the result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jk-bootstrap-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "example-service" }));
    const project = path.join(root, "example-app");
    await mkdir(path.join(project, "src"), { recursive: true });
    const nestedAndroid = path.join(project, "mobile", "android");
    await mkdir(nestedAndroid, { recursive: true });
    await writeFile(path.join(project, "package.json"), "{}\n");
    await writeFile(path.join(project, "src", "player.ts"), "const seekGuard = true;\n");
    await writeFile(path.join(nestedAndroid, "build.gradle"), "// nested module\n");
    const workerFile = path.join(root, "worker.cjs");
    const tokenFile = path.join(root, "token.txt");
    await writeFile(workerFile, WINDOWS_EXECUTOR_BOOTSTRAP_JS);
    await writeFile(tokenFile, "test-token");

    let heartbeat: any = null;
    let result: any = null;
    let pollCount = 0;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

    const server = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/executors/heartbeat") {
          heartbeat = body;
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === "/api/executors/windows-main/poll") {
          pollCount += 1;
          res.end(JSON.stringify({ job: pollCount === 1 ? {
            jobId: "job-1",
            executorId: "windows-main",
            tool: "code_search",
            payload: { sourceProjectId: "example-app", query: "seekGuard", maxResults: 10 },
            createdAt: Date.now(),
          } : null }));
          return;
        }
        if (req.url === "/api/executors/windows-main/jobs/job-1/result") {
          result = body;
          res.end(JSON.stringify({ ok: true }));
          resolveDone();
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
        rejectDone(error as Error);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock hub did not bind");

    const child = spawn(process.execPath, [workerFile], {
      env: {
        ...process.env,
        JK_HUB_URL: `http://127.0.0.1:${address.port}`,
        JK_EXECUTOR_ID: "windows-main",
        JK_EXECUTOR_WORKSPACE: root,
        JK_EXECUTOR_TOKEN_FILE: tokenFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => { if (!child.killed) child.kill("SIGKILL"); });

    await Promise.race([
      done,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("bootstrap worker timed out")), 8_000)),
    ]);

    expect(heartbeat?.executorId).toBe("windows-main");
    expect(heartbeat?.projects?.find((item: any) => path.resolve(item.root) === path.resolve(root))?.aliases).toContain("example-service");
    expect(heartbeat?.projects?.some((item: any) => item.projectId === "example-app")).toBe(true);
    expect(heartbeat?.projects?.some((item: any) => path.resolve(item.root) === path.resolve(nestedAndroid))).toBe(false);
    expect(heartbeat?.capabilities).toContain("local_shell_run");
    expect(heartbeat?.capabilities).toContain("executor_restart");
    expect(result?.error).toBeUndefined();
    expect(result?.result?.matches?.[0]).toMatchObject({ path: "src/player.ts", line: 1 });
  }, 10_000);

  it("bounds heartbeat requests so a stuck hub response cannot wedge future heartbeats", () => {
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("new AbortController()");
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("clearTimeout(timer)");
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toMatch(/heartbeat\(registry\).*?,5000\)/);
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("setInterval(async()=>");
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("},8000)");
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain('fs.openSync(LOCK_FILE,"wx")');
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain('cp.execFileSync("tasklist"');
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain('job.tool==="executor_restart"');
    expect(WINDOWS_EXECUTOR_BOOTSTRAP_JS).toContain("executor-restart.request");
  });
});
