import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    pool: "forks",
    // The suite launches real child processes (Node, Git, browser helpers,
    // approval jobs). Letting Vitest use every logical core on Windows can
    // intermittently exhaust process-launch resources and make otherwise
    // deterministic approval/E2E tests fail. Keep Linux/macOS defaults while
    // bounding Windows concurrency to a proven-stable level.
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    minWorkers: process.platform === "win32" ? 1 : undefined,
    // Windows browser E2E (real Edge/Chromium launch + profile cleanup) can
    // exceed the 5s default on cold starts; the probe run measured ~12s for a
    // single capture on this host.
    testTimeout: 60_000,
    hookTimeout: 20_000,
  },
});
