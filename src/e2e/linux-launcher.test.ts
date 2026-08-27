import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

describe("Linux launcher", () => {
  let root: string | undefined;
  let launcher: ChildProcessWithoutNullStreams | undefined;
  const linuxIt = process.platform === "linux" ? it : it.skip;

  afterEach(async () => {
    launcher?.kill("SIGTERM");
    if (root) await rm(root, { recursive: true, force: true });
  });

  linuxIt("starts with external tunnel metadata when --no-tunnel is selected", async () => {
    // Given: an isolated packaged launcher and a fake Node boundary.
    root = await mkdtemp(join(tmpdir(), "jk-linux-launcher-"));
    const binDir = join(root, "bin");
    const workspace = join(root, "workspace");
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await copyFile(
      new URL("../../linux/start-chatgpt2codex.sh", import.meta.url),
      join(root, "start-chatgpt2codex.sh"),
    );
    await writeFile(join(root, "dist", "cli.js"), "", "utf8");
    await writeFile(
      join(binDir, "node"),
      [
        "#!/usr/bin/env bash",
        "if [ \"${1:-}\" = \"-e\" ]; then exit 0; fi",
        "if [[ \" $* \" == *\" doctor \"* ]]; then echo 'owner token configured'; exit 0; fi",
        "if [[ \" $* \" == *\" serve \"* ]]; then exec tail -f /dev/null; fi",
        "exit 1",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );

    // When: the real Bash launcher starts in externally managed tunnel mode.
    launcher = spawn(
      "bash",
      [
        join(root, "start-chatgpt2codex.sh"),
        "--no-tunnel",
        "--public-hostname",
        "mcp.example.test",
        "--port",
        "17979",
        "--workspace",
        workspace,
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    let stdout = "";
    let stderr = "";
    launcher.stdout.setEncoding("utf8");
    launcher.stderr.setEncoding("utf8");
    launcher.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    launcher.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`launcher readiness timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 5_000);
      const onData = (): void => {
        if (
          stdout.includes("chatgpt2codex is ready") &&
          stdout.includes("https://mcp.example.test/mcp") &&
          stdout.includes("PUBLIC_HOSTNAME is metadata only")
        ) {
          clearTimeout(timeout);
          launcher?.off("exit", onExit);
          resolve();
        }
      };
      const onExit = (code: number | null): void => {
        clearTimeout(timeout);
        reject(new Error(`launcher exited before ready (${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      };
      launcher?.stdout.on("data", onData);
      launcher?.once("exit", onExit);
    });

    // Then: the launcher publishes the external hostname without owning the tunnel.
    expect(stderr).toBe("");
    expect(stdout).toContain("PUBLIC_HOSTNAME is metadata only");
  });
});
