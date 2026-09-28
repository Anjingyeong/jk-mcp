import { Script } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_HTML } from "./ui.js";

describe("Control Center dashboard links and mobile layout", () => {
  it("keeps the modern JK product shell and brand hierarchy", () => {
    expect(CONTROL_CENTER_HTML).toContain("JK Control Center");
    expect(CONTROL_CENTER_HTML).toContain('class="brand-mark" aria-hidden="true">JK');
    expect(CONTROL_CENTER_HTML).toContain("--sidebar: 244px");
    expect(CONTROL_CENTER_HTML).toContain("backdrop-filter: blur(18px) saturate(130%)");
    expect(CONTROL_CENTER_HTML).toContain("linear-gradient(180deg,#0b1017,#0d121a)");
  });

  it("keeps Quick Links limited to external service entry points", () => {
    expect(CONTROL_CENTER_HTML).toContain("Quick Links");
    expect(CONTROL_CENTER_HTML).toContain("hiddenQuickLinkTitles = ['CleanTube APK', 'Gecko QA APK']");
    expect(CONTROL_CENTER_HTML).not.toContain("{title:'JK Dashboard'");
    expect(CONTROL_CENTER_HTML).not.toContain("href:location.origin + '/approvals'");
    expect(CONTROL_CENTER_HTML).toContain("별도 서비스와 배포 진입점만 모았습니다.");
  });

  it("shows the Computer Control app allowlist only as part of explicit activation", () => {
    expect(CONTROL_CENTER_HTML).toContain('value="control"');
    expect(CONTROL_CENTER_HTML).toContain('id="control-apps"');
    expect(CONTROL_CENTER_HTML).toContain("controlApps");
    expect(CONTROL_CENTER_HTML).toContain("Computer Control armed");
  });

  it("keeps compact mobile chrome and approval actions responsive", () => {
    expect(CONTROL_CENTER_HTML).toContain("#top-role { display: none; }");
    expect(CONTROL_CENTER_HTML).toContain("@media (max-width: 480px)");
    expect(CONTROL_CENTER_HTML).toContain(".approval-card .role-head { flex-direction: column;");
    expect(CONTROL_CENTER_HTML).toContain(".quick-links { grid-template-columns: 1fr; }");
  });

  it.each([true, false])("renders the recommended supervision control only when eligible (network=%s)", (needsNetwork) => {
    const script = CONTROL_CENTER_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("Dashboard script missing");
    const parsed = ts.createSourceFile("dashboard.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const findRenderer = (node: ts.Node): ts.FunctionDeclaration | undefined =>
      ts.isFunctionDeclaration(node) && node.name?.text === "approvalsPage" ? node : ts.forEachChild(node, findRenderer);
    const renderer = findRenderer(parsed);
    if (!renderer) throw new Error("Approval renderer missing");
    const rendered: unknown = new Script(`(${renderer.getText(parsed)})()`).runInNewContext({
      state: { projects: [], jobs: [], approvals: [{ id: "qa", projectId: "proj", reason: "fixture", needsNetwork, destructive: false }] },
      esc: String, fmtRemaining: () => "", fmtAge: () => "",
      approvalTarget: () => null, executionLocationHtml: () => "",
    });
    if (typeof rendered !== "string") throw new Error("Approval renderer must return HTML");
    const control = rendered.match(/<button\b[^>]*data-approval-decision="supervise"[^>]*>/)?.[0];
    if (needsNetwork) {
      expect(control).toBeDefined();
      expect(control).toContain('class="btn primary"');
      expect(control).toContain('data-approval-id="qa"');
    } else {
      expect(control).toBeUndefined();
    }
    expect(CONTROL_CENTER_HTML).toContain("같은 goal/workSession의 비파괴 네트워크 후속만 재사용");
    expect(CONTROL_CENTER_HTML).toContain("파괴적 명령은 위 묶음에 표시된 exact 명령만 허용");
    expect(CONTROL_CENTER_HTML).toContain("1회만 승인");
    expect(CONTROL_CENTER_HTML).toContain("승인한 queued job은 즉시 자동 실행");
  });

  it("distinguishes fixed JK maintenance scopes from read-only approval sessions", () => {
    expect(CONTROL_CENTER_HTML).toContain("JK 유지보수 승인");
    expect(CONTROL_CENTER_HTML).toContain("15분 JK 유지보수 승인");
    expect(CONTROL_CENTER_HTML).toContain("JK가 고정한 유지보수 명령");
    expect(CONTROL_CENTER_HTML).toContain("임의 삭제·reset/force·다른 destructive 명령에는 적용되지 않습니다.");
  });

  it("shows compact optional deployment health without a provider-specific label", () => {
    expect(CONTROL_CENTER_HTML).toContain("Deployment");
    expect(CONTROL_CENTER_HTML).toContain("Upstream ");
    expect(CONTROL_CENTER_HTML).toContain("Build ");
    expect(CONTROL_CENTER_HTML).toContain("Health ");
    expect(CONTROL_CENTER_HTML).toContain("Network ");
  });

  it("shows recent Standard vs Dispatcher coordination performance without exposing raw telemetry", () => {
    expect(CONTROL_CENTER_HTML).toContain("Coordination 성능");
    expect(CONTROL_CENTER_HTML).toContain('data-dashboard-region="coordination-performance"');
    expect(CONTROL_CENTER_HTML).toContain("selector 튜닝 최소 표본 20/20");
    expect(CONTROL_CENTER_HTML).toContain("Payload Δ");
    expect(CONTROL_CENTER_HTML).toContain("Failure / Retry");
    expect(CONTROL_CENTER_HTML).toContain("coord-perf-track");
  });

  it("offers a bounded one-click JK runtime sync that still requires one owner approval", () => {
    expect(CONTROL_CENTER_HTML).toContain('id="sync-jk-runtime"');
    expect(CONTROL_CENTER_HTML).toContain("서버 동기화 · 재시작");
    expect(CONTROL_CENTER_HTML).toContain("승인 1회만 필요합니다.");
    expect(CONTROL_CENTER_HTML).toContain("/api/jk/control/deployment/sync");
    expect(CONTROL_CENTER_HTML).toContain("bash scripts/sync-jk-oci.sh --reload-current");
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
    expect(CONTROL_CENTER_HTML).toContain("api('/api/jk/control/approvals/summary')");
    expect(CONTROL_CENTER_HTML).toContain("summary.revision !== state.approvalRevision");
  });

  it("offers Computer Control as an explicit manual activation preset", () => {
    expect(CONTROL_CENTER_HTML).toContain('<option value="control"');
    expect(CONTROL_CENTER_HTML).toContain('Computer Control');
  });

  it("renders core dashboard data before deferred approval and log signals", () => {
    expect(CONTROL_CENTER_HTML).toContain("const [projects, status, execution, goals] = await Promise.all([");
    expect(CONTROL_CENTER_HTML).toContain("async function loadSecondarySignals()");
    expect(CONTROL_CENTER_HTML).toContain("setTimeout(() => { void loadSecondarySignals(); }, 0);");
    const coreLoad = CONTROL_CENTER_HTML.slice(
      CONTROL_CENTER_HTML.indexOf("async function loadAll"),
      CONTROL_CENTER_HTML.indexOf("function updateChrome"),
    );
    expect(coreLoad).not.toContain("api('/api/jk/control/approvals')");
    expect(coreLoad).not.toContain("api('/api/jk/control/logs?limit=80')");
  });

  it("visualizes MASS ULW lanes, dependencies, elapsed time, blockers, and recent events", () => {
    expect(CONTROL_CENTER_HTML).toContain('class="run-dag"');
    expect(CONTROL_CENTER_HTML).toContain('data-lane-status=');
    expect(CONTROL_CENTER_HTML).toContain('class="run-dag-edge"');
    expect(CONTROL_CENTER_HTML).toContain('class="run-dag-node status-');
    expect(CONTROL_CENTER_HTML).toContain('aria-label="MASS ULW dependency graph viewport"');
    expect(CONTROL_CENTER_HTML).toContain('marker-end="url(#run-dag-arrow)"');
    expect(CONTROL_CENTER_HTML).toContain("massUlwNodeIcon");
    expect(CONTROL_CENTER_HTML).toContain("왜 기다리나");
    expect(CONTROL_CENTER_HTML).toContain('data-run-started-at=');
    expect(CONTROL_CENTER_HTML).toContain("RECENT EVENTS");
    expect(CONTROL_CENTER_HTML).toContain("병렬 작업 ");
    expect(CONTROL_CENTER_HTML).toContain(".run-event { grid-template-columns: 1fr auto; }");
    expect(CONTROL_CENTER_HTML).toContain(".run-dag-scroll { margin-inline:");
  });

  it("puts the DAG on a full-width stage with wave bands, edge states, legend, and focus highlighting", () => {
    expect(CONTROL_CENTER_HTML).toContain('class="dag-stage" data-dashboard-region="dag"');
    expect(CONTROL_CENTER_HTML).toContain('data-edge-state="');
    expect(CONTROL_CENTER_HTML).toContain('class="run-dag-wave" data-wave-state="');
    expect(CONTROL_CENTER_HTML).toContain('class="run-legend"');
    expect(CONTROL_CENTER_HTML).toContain("installMassUlwGraphFocus");
    expect(CONTROL_CENTER_HTML).toContain('.run-dag-edge[data-edge-state="active"]');
    // The phase rail no longer embeds the graph; it renders once, on the stage.
    const rail = CONTROL_CENTER_HTML.slice(CONTROL_CENTER_HTML.indexOf("function workflowRailHtml()"), CONTROL_CENTER_HTML.indexOf("async function refreshExecution()"));
    expect(rail).not.toContain("massUlwStatusHtml(e)");
  });
});
