import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverE2eAutomation } from "./tools.js";

describe("E2E automation discovery", () => {
  let roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
  });

  async function makeProject(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-e2e-auto-"));
    roots.push(root);
    return root;
  }

  it("builds and opens Tauri projects as desktop apps instead of browser-only smoke tests", async () => {
    const root = await makeProject();
    await mkdir(path.join(root, "src-tauri"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite",
          build: "tsc && vite build",
          tauri: "tauri",
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "src-tauri", "tauri.conf.json"),
      JSON.stringify({
        productName: "PingFit",
        build: { devUrl: "http://localhost:1420" },
      }),
      "utf8",
    );

    const automation = await discoverE2eAutomation(root);

    expect(automation.targetKind).toBe("desktop-app");
    expect(automation.targetAppName).toBe("PingFit");
    expect(automation.devCommand).toBeUndefined();
    expect(automation.command).toBe("npm run tauri -- build");
    expect(automation.targetAppPath).toBe(path.join(await realpath(root), "src-tauri", "target", "release", "bundle", "macos", "PingFit.app"));
  });

  it("keeps browser-region smoke tests for plain web projects", async () => {
    const root = await makeProject();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite",
          build: "vite build",
        },
      }),
      "utf8",
    );

    const automation = await discoverE2eAutomation(root);

    expect(automation.targetKind).toBe("web");
    expect(automation.command).toBe("npm run build");
    expect(automation.devCommand).toMatch(/^npm run dev -- --host 127\.0\.0\.1 --port \d+$/u);
    expect(automation.devUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
  });
});
