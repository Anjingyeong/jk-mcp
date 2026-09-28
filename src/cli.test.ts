import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

describe("JK CLI help", () => {
  it("prints the top-level command surface and exits successfully for --help", async () => {
    // Given: the real TypeScript CLI entry point.
    // When: a user asks for top-level help.
    const result = await execFileAsync(process.execPath, ["--import", "tsx", cli, "--help"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeout: 30_000,
    });

    // Then: help is a successful stdout response naming the usable commands and options.
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: jk <setup|start|serve|init|doctor|owner-token|control|executor>");
    expect(result.stdout).toContain("--workspace <path>");
    expect(result.stdout).toContain("--http");
  }, 30_000);

  it("keeps an unknown top-level command as a usage error", async () => {
    // Given: the real TypeScript CLI entry point.
    // When/Then: an unknown command remains nonzero and explains the valid surface.
    await expect(execFileAsync(process.execPath, ["--import", "tsx", cli, "unknown-command"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeout: 30_000,
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("usage: jk <setup|start|serve|init|doctor|owner-token|control|executor>"),
    });
  }, 30_000);
});
