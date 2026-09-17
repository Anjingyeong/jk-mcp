import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_HTML } from "./ui.js";

describe("Control Center dashboard links and mobile layout", () => {
  it("keeps Quick Links limited to external service entry points", () => {
    expect(CONTROL_CENTER_HTML).toContain("Quick Links");
    expect(CONTROL_CENTER_HTML).not.toContain("hiddenQuickLinkTitles");
    expect(CONTROL_CENTER_HTML).not.toContain("{title:'JK Dashboard'");
    expect(CONTROL_CENTER_HTML).not.toContain("href:location.origin + '/approvals'");
    expect(CONTROL_CENTER_HTML).toContain("별도 서비스와 배포 진입점만 모았습니다.");
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

  it("keeps maintainer-specific deployment actions out of the public control center", () => {
    expect(CONTROL_CENTER_HTML).not.toContain('id="sync-jk-runtime"');
    expect(CONTROL_CENTER_HTML).not.toContain("/api/jk/control/deployment/sync");
    expect(CONTROL_CENTER_HTML).not.toContain("sync-jk-oci.sh");
    expect(CONTROL_CENTER_HTML).toContain("Local + Workers");
    expect(CONTROL_CENTER_HTML).toContain('<span class="badge default">Local</span>');
    expect(CONTROL_CENTER_HTML).not.toContain('<span class="badge default">OCI</span>');
  });

  it("labels reconciled stale approval history separately from live failures", () => {
    expect(CONTROL_CENTER_HTML).toContain("stale history");
    expect(CONTROL_CENTER_HTML).toContain("이전 실행 기록 정리");
  });

  it("keeps live dashboard execution and signals on short foreground refresh intervals", () => {
    expect(CONTROL_CENTER_HTML).toContain("if (document.hidden) return;");
    expect(CONTROL_CENTER_HTML).toContain("if (state.page === 'dashboard') {\n        render();");
    expect(CONTROL_CENTER_HTML).toContain("setInterval(refreshExecution,1500);");
    expect(CONTROL_CENTER_HTML).toContain("setInterval(refreshSignals,2500);");
    expect(CONTROL_CENTER_HTML).toContain("setInterval(() => loadAll({quiet:true}), 15000);");
  });
});
