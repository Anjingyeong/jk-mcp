import { describe, expect, it } from "vitest";
import { WINDOWS_EXECUTOR_SUPERVISOR_JS } from "./windows-supervisor.js";

describe("Windows executor supervisor bootstrap", () => {
  it("owns worker lifecycle outside the worker process", () => {
    expect(WINDOWS_EXECUTOR_SUPERVISOR_JS).toContain("executor-supervisor.lock");
    expect(WINDOWS_EXECUTOR_SUPERVISOR_JS).toContain("executor-restart.request");
    expect(WINDOWS_EXECUTOR_SUPERVISOR_JS).toContain("discoverWorkerPids");
    expect(WINDOWS_EXECUTOR_SUPERVISOR_JS).toContain("terminateAllWorkers");
    expect(WINDOWS_EXECUTOR_SUPERVISOR_JS).toContain('cp.execFileSync("taskkill"');
    expect(WINDOWS_EXECUTOR_SUPERVISOR_JS).toContain("Date.now()+10000");
    expect(WINDOWS_EXECUTOR_SUPERVISOR_JS).toContain("managedPid=startWorker()");
    expect(WINDOWS_EXECUTOR_SUPERVISOR_JS).not.toContain("},1000).unref()");
  });
});
