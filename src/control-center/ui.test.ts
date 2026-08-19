import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_HTML } from "./ui.js";

describe("Control Center dashboard links and mobile layout", () => {
  it("keeps built-in Quick Links generic and host-local links external", () => {
    expect(CONTROL_CENTER_HTML).toContain("Quick Links");
    expect(CONTROL_CENTER_HTML).toContain("JK Dashboard");
    expect(CONTROL_CENTER_HTML).toContain("/approvals");
  });

  it("keeps compact mobile chrome and approval actions responsive", () => {
    expect(CONTROL_CENTER_HTML).toContain("#top-role { display: none; }");
    expect(CONTROL_CENTER_HTML).toContain("@media (max-width: 480px)");
    expect(CONTROL_CENTER_HTML).toContain(".approval-card .role-head { flex-direction: column;");
    expect(CONTROL_CENTER_HTML).toContain(".quick-links { grid-template-columns: 1fr; }");
  });

  it("makes supervised task approval the recommended path and explains queued auto-run", () => {
    expect(CONTROL_CENTER_HTML).toContain("이 작업 30분 승인 · 권장");
    expect(CONTROL_CENTER_HTML).toContain("1회만 승인");
    expect(CONTROL_CENTER_HTML).toContain("승인한 queued job은 즉시 자동 실행");
  });

  it("shows compact optional deployment health without a provider-specific label", () => {
    expect(CONTROL_CENTER_HTML).toContain("Deployment");
    expect(CONTROL_CENTER_HTML).toContain("Upstream ");
    expect(CONTROL_CENTER_HTML).toContain("Build ");
    expect(CONTROL_CENTER_HTML).toContain("Health ");
    expect(CONTROL_CENTER_HTML).toContain("Network ");
  });

  it("labels reconciled stale approval history separately from live failures", () => {
    expect(CONTROL_CENTER_HTML).toContain("stale history");
    expect(CONTROL_CENTER_HTML).toContain("이전 실행 기록 정리");
  });
});
