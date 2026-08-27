import { describe, expect, it } from "vitest";
import {
  buildTaskSafetyGate,
  inferCommandExecutionKind,
  inferTaskExecutionKind,
  makeDefaultTaskSafety,
  mergeTaskSafety,
} from "./task-safety.js";

describe("goal_loop task safety", () => {
  it("does not misclassify discussion about deployment safeguards as an actual deployment task", () => {
    expect(inferTaskExecutionKind("Improve goal_loop deploy/release rollback expectations and runtime proof rules")).toBe("workspace");
    expect(inferTaskExecutionKind("배포 전에 검증하는 로직을 개선한다")).toBe("workspace");
    expect(inferTaskExecutionKind("이 앱 배포까지 진행해")).toBe("release-deploy");
    expect(inferTaskExecutionKind("JK 런타임 재시작해")).toBe("live-runtime");
  });

  it("keeps the reload preflight check read-only while classifying the real reload as live runtime", () => {
    expect(inferCommandExecutionKind("bash scripts/reload-jk-runtime.sh --check")).toBe("workspace");
    expect(inferCommandExecutionKind("bash scripts/reload-jk-runtime.sh")).toBe("live-runtime");
    expect(inferCommandExecutionKind("systemctl restart jk-cloud.service")).toBe("live-runtime");
  });

  it("blocks approval until preflight, exact target, plan, rollback, and release collision checks pass", () => {
    const initial = mergeTaskSafety(makeDefaultTaskSafety(), { executionKind: "release-deploy" }, "release-deploy");
    expect(buildTaskSafetyGate(initial).approvalReady).toBe(false);

    const ready = mergeTaskSafety(initial, {
      preflightStatus: "pass",
      preflightEvidence: ["wrangler auth and release version checked"],
      executionTarget: {
        machine: "windows-main",
        projectRoot: "C:\\JK\\cleantube",
        branch: "main",
        dirty: true,
        runtimeTarget: "updates.example.com",
      },
      approvalPlan: ["npx wrangler deploy --config update-proxy/wrangler.jsonc"],
      rollbackStatus: "pass",
      releaseCollisionStatus: "pass",
    }, "release-deploy");
    expect(buildTaskSafetyGate(ready).approvalReady).toBe(true);
    expect(buildTaskSafetyGate(ready).terminalReady).toBe(false);
  });

  it("requires runtime proof and zero unresolved operational drift before terminal success", () => {
    const safety = mergeTaskSafety(makeDefaultTaskSafety(), {
      executionKind: "live-runtime",
      preflightStatus: "pass",
      preflightEvidence: ["reload --check passed"],
      executionTarget: {
        machine: "oci",
        projectRoot: "/opt/jk/workspace/chatgpt2codex",
        branch: "main",
        dirty: true,
        runtimeTarget: "jk-cloud.service",
      },
      approvalPlan: ["bash scripts/reload-jk-runtime.sh"],
      rollbackStatus: "pass",
      runtimeProofStatus: "pass",
      runtimeProofEvidence: ["PID changed and dist marker matched"],
      operationalDrift: ["NeedDaemonReload=yes"],
    }, "live-runtime");
    expect(buildTaskSafetyGate(safety).terminalReady).toBe(false);

    const cleared = mergeTaskSafety(safety, { operationalDrift: [] }, "live-runtime");
    expect(buildTaskSafetyGate(cleared).terminalReady).toBe(true);
  });

  it("resets newly-required gates when execution kind escalates", () => {
    const release = mergeTaskSafety(makeDefaultTaskSafety(), { executionKind: "release-deploy" }, "release-deploy");
    expect(release.preflightStatus).toBe("unknown");
    expect(release.rollbackStatus).toBe("unknown");
    expect(release.releaseCollisionStatus).toBe("unknown");
    expect(release.runtimeProofStatus).toBe("unknown");
  });

  it("never downgrades an existing live/release safety contract back to workspace", () => {
    const release = mergeTaskSafety(makeDefaultTaskSafety(), { executionKind: "release-deploy" }, "release-deploy");
    const attemptedDowngrade = mergeTaskSafety(release, { executionKind: "workspace" }, "workspace");
    expect(attemptedDowngrade.executionKind).toBe("release-deploy");
  });
});
