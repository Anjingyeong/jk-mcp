import { MASS_ULW_DASHBOARD_SCRIPT } from "./mass-ulw-ui.js";

export const CONTROL_CENTER_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2320211f'/%3E%3Ctext x='16' y='21' text-anchor='middle' font-size='13' font-family='Arial' font-weight='700' fill='%23c9a66b'%3EJK%3C/text%3E%3C/svg%3E" />
  <title>JK Control Center</title>
  <meta name="description" content="JK 개인 작업 현황, 승인 요청, 실행 위치와 최근 결과를 확인하는 command center." />
  <style>
    :root {
      --bg: #0b0d12; --panel: #11151d; --panel-2: #171c26;
      --panel-inset: #0d1118; --panel-hover: #1c2330;
      --line: #252c38; --line-strong: #3b4658;
      --text: #f5f7fb; --muted: #929daf;
      --accent: #d2aa67; --accent-hover: #e2bf82; --accent-soft: #2b2318; --on-accent: #19140c;
      --ok: #70d69c; --ok-soft: #12251b; --warn: #e5bd72;
      --danger: #ff9292; --danger-soft: #2d171a; --info: #7db7ff; --info-soft: #142237;
      --sidebar: 244px; --radius: 14px; --radius-small: 10px;
      --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
      --space-5: 20px; --space-6: 24px; --space-8: 32px;
      --deferred-block-size: 500px;
      --motion-fast: 140ms; --motion-state: 240ms; --motion-event: 420ms; --ease-out: cubic-bezier(.16,1,.3,1);
      font-family: "Segoe UI Variable", "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif;
      font-size: 14px; line-height: 1.6; font-variant-numeric: tabular-nums;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
    body { min-height: 100dvh; background: radial-gradient(circle at 78% -10%, rgba(210,170,103,.09), transparent 32%), radial-gradient(circle at 8% 12%, rgba(125,183,255,.05), transparent 30%), var(--bg); }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .app { height: 100dvh; display: grid; grid-template-columns: var(--sidebar) minmax(0,1fr); grid-template-rows: minmax(0,1fr); }
    .sidebar { min-height: 0; overflow-y: auto; border-right: 1px solid rgba(255,255,255,.06); background: linear-gradient(180deg,#0d1118 0%,#0a0d12 100%); padding: 22px 14px 18px; display: flex; flex-direction: column; gap: 20px; box-shadow: 18px 0 44px rgba(0,0,0,.16); }
    .brand { display: flex; align-items: center; gap: 12px; padding: 0 8px 12px; }
    .brand-mark { width: 42px; height: 42px; border: 1px solid rgba(226,191,130,.32); border-radius: 13px; display: grid; place-items: center; font-weight: 900; letter-spacing: -1.5px; color: #f6dfb7; background: linear-gradient(145deg,#292316,#15181e 72%); box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 8px 24px rgba(0,0,0,.28); }
    .brand-copy { min-width: 0; }
    .brand strong { display: block; font-size: 15px; line-height: 1.25; letter-spacing: -.01em; }
    .brand span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; letter-spacing: .02em; }
    .nav { display: grid; gap: 5px; }
    .nav button { width: 100%; border: 1px solid transparent; background: transparent; color: var(--muted); text-align: left; padding: 11px 12px; border-radius: 11px; display: flex; align-items: center; gap: 11px; font-weight: 600; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
    .nav button:hover { background: rgba(255,255,255,.045); color: var(--text); }
    .nav button.active { background: linear-gradient(90deg,rgba(210,170,103,.14),rgba(210,170,103,.045)); color: #f9efd9; border-color: rgba(210,170,103,.16); box-shadow: inset 3px 0 0 var(--accent); }
    .nav .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); }
    .nav button.active .dot { background: var(--accent); }
    .sidebar-foot { margin-top: auto; border-top: 1px solid rgba(255,255,255,.06); padding: 16px 8px 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
    .online { color: var(--ok); }
    .main { min-width: 0; min-height: 0; overflow-y: auto; }
    .topbar { height: 72px; border-bottom: 1px solid rgba(255,255,255,.055); display: flex; align-items: center; justify-content: space-between; padding: 0 36px; position: sticky; top: 0; background: rgba(11,13,18,.84); backdrop-filter: blur(18px) saturate(130%); z-index: 10; }
    .crumb { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .crumb strong { font-size: 14px; }
    .project-pill { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .top-actions { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 0 0 auto; }
    .status-chip { border: 1px solid var(--line); color: var(--muted); padding: 6px 10px; border-radius: 999px; background: rgba(17,21,29,.8); font-size: 11px; box-shadow: inset 0 1px 0 rgba(255,255,255,.035); }
    .status-chip strong { color: var(--text); }
    .content { padding: 34px 38px 44px; max-width: 1480px; margin: 0 auto; }
    .page-head { display: flex; justify-content: space-between; gap: 18px; align-items: flex-end; margin-bottom: 22px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; font-weight: 760; letter-spacing: -.035em; }
    .sub { margin-top: var(--space-2); color: var(--muted); font-size: 14px; line-height: 1.6; word-break: keep-all; overflow-wrap: anywhere; }
    .btn { min-height: 36px; border: 1px solid var(--line); background: linear-gradient(180deg,var(--panel-2),var(--panel)); color: var(--text); padding: var(--space-2) var(--space-3); border-radius: 10px; font-size: 12px; font-weight: 650; box-shadow: inset 0 1px 0 rgba(255,255,255,.045); transition: transform var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
    .btn:hover { border-color: var(--line-strong); background: var(--panel-hover); }
    .btn:active:not(:disabled) { transform: translateY(1px); }
    .btn:focus-visible, .nav button:focus-visible, .mobile-head button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .btn.primary { background: linear-gradient(180deg,var(--accent-hover),var(--accent)); color: var(--on-accent); border-color: var(--accent); font-weight: 800; box-shadow: 0 8px 22px rgba(210,170,103,.16); }
    .btn.danger { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
    .btn.ghost { background: transparent; }
    .btn.small { padding: 6px 8px; font-size: 12px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }
    .metric, .panel { min-width: 0; border: 1px solid rgba(255,255,255,.055); background: linear-gradient(180deg,rgba(23,28,38,.94),rgba(17,21,29,.94)); border-radius: 16px; box-shadow: 0 14px 36px rgba(0,0,0,.12), inset 0 1px 0 rgba(255,255,255,.025); }
    .metric { position: relative; overflow: hidden; padding: 17px 18px; min-height: 116px; display: flex; flex-direction: column; justify-content: space-between; transition: transform var(--motion-state) var(--ease-out), border-color var(--motion-state) var(--ease-out); }
    .metric.changed { animation: metric-change var(--motion-event) var(--ease-out); border-color: var(--accent); }
    .metric .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .metric .value { font-size: 21px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .metric .meta { color: var(--muted); font-size: 12px; }
    .coord-perf { margin-top: var(--space-5); }
    .coord-perf-bars { display: grid; gap: 10px; margin-top: 14px; }
    .coord-perf-row { display: grid; grid-template-columns: 92px minmax(0,1fr) auto; gap: 10px; align-items: center; color: var(--muted); font-size: 11px; }
    .coord-perf-track { height: 7px; border-radius: 999px; background: var(--panel-inset); overflow: hidden; }
    .coord-perf-fill { height: 100%; min-width: 2px; border-radius: inherit; background: var(--accent); }
    .coord-perf-fill.standard { background: var(--info); }
    @keyframes metric-change { from { opacity: .55; } to { opacity: 1; } }
    .panel { padding: 18px; }
    .section-title { margin: 0 0 14px; font-size: 14px; color: var(--text); }
    .split { display: grid; grid-template-columns: minmax(0,1.35fr) minmax(280px,.65fr); gap: 12px; margin-top: 12px; }
    .role-card, .project-row, .log-row, .goal-row { min-width: 0; border: 0; border-bottom: 1px solid var(--line); background: transparent; border-radius: 0; }
    .role-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
    .role-card { padding: 14px; display: grid; gap: 11px; }
    .role-card.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .role-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .role-name { font-weight: 700; font-size: 14px; }
    .role-desc { color: var(--muted); font-size: 12px; min-height: 34px; }
    .badges { display: flex; flex-wrap: wrap; gap: 5px; }
    .badge { border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; color: var(--muted); background: rgba(255,255,255,.025); font-size: 10px; font-weight: 650; }
    .badge.active { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
    .badge.default { color: var(--info); border-color: var(--info); background: var(--info-soft); }
    .badge.ok { color: var(--ok); border-color: var(--ok); background: var(--ok-soft); }
    .badge.warn { color: var(--warn); border-color: var(--accent); background: var(--accent-soft); }
    .badge.danger { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .project-list, .goal-list, .log-list { display: grid; gap: 0; }
    .project-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 14px; align-items: center; padding: 13px 14px; }
    .project-name { font-weight: 650; font-size: 14px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--muted); word-break: break-all; }
    .goal-row { padding: 14px; display: grid; gap: 9px; }
    .goal-title { font-size: 14px; font-weight: 650; }
    .goal-meta { display: flex; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
    .progress-list { margin: 0; padding-left: 18px; color: var(--text); font-size: 12px; display: grid; gap: 5px; }
    .log-row { padding: 10px 12px; display: grid; grid-template-columns: minmax(0,1fr) minmax(0,2fr) auto; gap: 12px; align-items: start; }
    .log-type { min-width: 0; overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); }
    .log-detail { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { border-top: 1px solid var(--line); padding: var(--space-5) 0; text-align: left; color: var(--muted); font-size: 12px; }
    .kv { display: grid; grid-template-columns: minmax(80px,.4fr) minmax(0,1fr); gap: 8px 14px; font-size: 12px; }
    .kv dt { color: var(--muted); }
    .kv dd { margin: 0; word-break: break-word; }
    .skill-cloud { display: flex; flex-wrap: wrap; gap: 7px; }
    .skill { border: 1px solid var(--line); background: var(--panel); padding: 7px 9px; border-radius: var(--radius); font-size: 12px; }
    .guide-hero { display: grid; grid-template-columns: minmax(0,1.25fr) minmax(280px,.75fr); gap: 12px; align-items: stretch; }
    .guide-hero-copy { display: grid; align-content: center; gap: 12px; min-height: 220px; }
    .guide-hero-copy h1 { font-size: 28px; word-break: keep-all; text-wrap: balance; }
    .guide-flow { min-height: 220px; display: grid; place-items: center; overflow: hidden; }
    .guide-flow svg { width: min(100%, 420px); height: auto; }
    .guide-steps { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; margin-top: 12px; }
    .guide-step { border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius); padding: 14px; min-height: 132px; }
    .guide-step .num { width: 26px; height: 26px; display: grid; place-items: center; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 800; margin-bottom: 12px; }
    .guide-step strong { display: block; font-size: 14px; margin-bottom: 7px; }
    .guide-step p, .guide-note { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
    .guide-role { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 12px; align-items: start; padding: 10px 0; border-top: 1px solid var(--line); }
    .guide-role:first-of-type { border-top: 0; padding-top: 0; }
    .prompt-list { display: grid; gap: 7px; }
    .prompt { border: 1px solid var(--line); background: var(--panel-inset); border-radius: var(--radius); padding: 10px 12px; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); }
    .guide-safety { display: grid; grid-template-columns: 150px minmax(0,1fr); gap: 18px; align-items: center; }
    .guide-safety svg { width: 130px; height: 130px; margin: 0 auto; }
    .workflow-panel { margin-top: 12px; overflow: hidden; }
    .workflow-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
    .workflow-head .sub { margin-top: 4px; }
    .workflow-strip { position: relative; display: grid; grid-template-columns: repeat(7, minmax(0,1fr)); gap: 0; padding: 7px 0 2px; }
    .workflow-strip::before { content: ""; position: absolute; left: 6%; right: 6%; top: 22px; height: 1px; background: var(--line); }
    .workflow-step { position: relative; z-index: 1; display: grid; justify-items: center; gap: 7px; min-width: 0; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .workflow-dot { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--line-strong); background: var(--panel);  }
    .workflow-step.done { color: var(--muted); }
    .workflow-step.done .workflow-dot { border-color: var(--line-strong); background: var(--panel-2); }
    .workflow-step.active { color: var(--accent); font-weight: 800; }
    .workflow-step.active .workflow-dot { border-color: var(--accent); background: var(--accent);  }
    .workflow-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .workflow-meta { margin-top: 10px; display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 11px; }
    .run-wait-reason { margin-top: var(--space-4); display: grid; grid-template-columns: auto minmax(0,1fr); gap: var(--space-3); align-items: start; padding: var(--space-3); border-left: 2px solid var(--line-strong); background: var(--panel-inset); }
    .run-wait-reason.waiting { border-left-color: var(--accent); }
    .run-wait-reason.problem { border-left-color: var(--danger); }
    .run-wait-reason strong { font-size: 12px; white-space: nowrap; }
    .run-wait-reason span { min-width: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .mass-run { margin-top: var(--space-5); padding: 18px; border: 1px solid rgba(210,170,103,.22); border-radius: 16px; background: linear-gradient(145deg,rgba(210,170,103,.065),rgba(13,17,24,.88) 42%,rgba(17,21,29,.92)); box-shadow: inset 0 1px 0 rgba(255,255,255,.035); }
    .mass-run-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
    .mass-run-title { margin-top: var(--space-1); font-size: 14px; font-weight: 700; }
    .run-stats { display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-5); margin-top: var(--space-4); color: var(--muted); font-size: 12px; }
    .run-stats strong { margin-right: var(--space-1); color: var(--text); font-size: 15px; }
    .danger-text, .danger-text strong { color: var(--danger); }
    .run-dag { min-width: 0; margin-top: var(--space-4); padding: 14px; border: 1px solid rgba(255,255,255,.06); border-radius: 14px; background: linear-gradient(180deg,#0b1017,#0d121a); box-shadow: inset 0 1px 0 rgba(255,255,255,.025); }
    .run-dag-scroll { max-width: 100%; min-height: 136px; overflow: auto; padding-bottom: var(--space-2); outline: none; scrollbar-gutter: stable; }
    .run-dag-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .run-dag-graph { position: relative; min-width: 100%; }
    .run-dag-edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
    .run-dag-edge { fill: none; stroke: #667489; stroke-width: 2; vector-effect: non-scaling-stroke; opacity: .72; }
    #run-dag-arrow path { fill: #78879d; }
    .run-dag-node { position: absolute; z-index: 1; display: grid; grid-template-rows: auto minmax(0,1fr) auto; gap: var(--space-2); padding: 12px 13px; border: 1px solid #303a49; border-radius: 12px; background: linear-gradient(180deg,#171d27,#121720); box-shadow: 0 10px 24px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.035); overflow: hidden; }
    .run-dag-node-head { min-width: 0; display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: var(--space-2); align-items: center; }
    .run-dag-icon { width: 20px; height: 20px; display: grid; place-items: center; color: var(--muted); }
    .run-dag-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .run-dag-node .run-lane-task { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
    .run-dag-node-meta { display: flex; justify-content: space-between; gap: var(--space-2); color: var(--muted); font-size: 10px; }
    .run-dag-node.status-ready { border-color: var(--info); }
    .run-dag-node.status-in-flight { border-color: rgba(210,170,103,.7); box-shadow: inset 3px 0 0 var(--accent), 0 0 0 1px rgba(210,170,103,.08), 0 12px 30px rgba(0,0,0,.26); }
    .run-dag-node.status-in-flight .run-dag-icon { color: var(--accent); }
    .run-dag-node.status-completed { border-color: var(--ok); }
    .run-dag-node.status-completed .run-dag-icon { color: var(--ok); }
    .run-dag-node.status-review { border-color: var(--info); }
    .run-dag-node.status-failed { border-color: var(--danger); }
    .run-dag-node.status-failed .run-dag-icon { color: var(--danger); }
    .run-dag-node.status-blocked { border-color: var(--warn); }
    .run-dag-node.status-blocked .run-dag-icon { color: var(--warn); }
    .run-lane { min-width: 0; display: grid; grid-template-columns: 22px minmax(0,1fr); position: relative; }
    .run-lane-rail { position: relative; display: grid; justify-items: center; }
    .run-lane-rail::before { content: ''; position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line); }
    .run-lane:first-child .run-lane-rail::before { top: 18px; }
    .run-lane:last-child .run-lane-rail::before { bottom: calc(100% - 18px); }
    .run-lane-rail span { z-index: 1; width: 9px; height: 9px; margin-top: 14px; border-radius: 50%; border: 2px solid var(--line-strong); background: var(--panel); }
    .run-lane.status-in-flight .run-lane-rail span { border-color: var(--accent); background: var(--accent); }
    .run-lane.status-completed .run-lane-rail span { border-color: var(--ok); background: var(--ok); }
    .run-lane.status-failed .run-lane-rail span { border-color: var(--danger); background: var(--danger); }
    .run-lane.status-blocked .run-lane-rail span { border-color: var(--warn); background: var(--warn); }
    .run-lane-card { min-width: 0; margin-bottom: var(--space-2); padding: var(--space-3); border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-inset); }
    .run-lane.status-in-flight .run-lane-card { border-color: var(--accent); }
    .run-lane.status-failed .run-lane-card { border-color: var(--danger); }
    .run-lane.status-blocked .run-lane-card { border-color: var(--warn); }
    .run-lane-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
    .run-lane-title { min-width: 0; display: grid; gap: 2px; }
    .run-lane-id { color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .run-lane-task { font-size: 12px; font-weight: 650; line-height: 1.5; overflow-wrap: anywhere; }
    .run-lane-meta, .run-lane-deps { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-top: var(--space-2); color: var(--muted); font-size: 11px; }
    .run-lane-deps.root { opacity: .72; }
    .run-dep { padding: 1px 5px; border: 1px solid var(--line); border-radius: var(--radius-small); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .run-events { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--line); }
    .run-event-list { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
    .run-event { min-width: 0; display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: var(--space-2); color: var(--muted); font-size: 11px; }
    .run-event .event-type { color: var(--text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .run-event .event-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log-row.fresh, .goal-row.fresh { animation: row-arrive var(--motion-event) var(--ease-out); }
    @keyframes row-arrive { from { opacity: .35; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .attention { animation: attention-in var(--motion-event) var(--ease-out); }
    @keyframes attention-in { from { opacity: .55; } to { opacity: 1; } }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .select, .input, .textarea { min-width: 0; min-height: 36px; width: 100%; background: var(--panel-inset); border: 1px solid var(--line-strong); color: var(--text); border-radius: var(--radius); padding: 9px 10px; outline: none; }
    .textarea { min-height: 110px; resize: vertical; }
    .select:focus, .input:focus, .textarea:focus { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .field { display: grid; gap: 6px; }
    .field.full { grid-column: 1 / -1; }
    .field label { color: var(--muted); font-size: 12px; }
    .check-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; }
    .check { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: var(--radius); padding: 8px; font-size: 12px; color: var(--text); }
    dialog { width: min(720px, calc(100vw - 32px)); border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: var(--radius); padding: 0; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
    dialog::backdrop { background: rgba(0,0,0,.72); }
    .dialog-head { padding: 16px 18px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
    .dialog-body { padding: 18px; }
    .dialog-foot { padding: 14px 18px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 8px; }
    .toast { position: fixed; right: 18px; bottom: 18px; z-index: 50; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 10px 12px; border-radius: var(--radius); font-size: 12px; opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity var(--motion-fast), transform var(--motion-fast); }
    .toast.show { opacity: 1; transform: translateY(0); }
    .hidden { display: none !important; }
    .mobile-head { display: none; }
    .dashboard-hero { display: flex; align-items: center; justify-content: space-between; gap: 28px; margin-bottom: 14px; padding: 24px; border-color: var(--accent); background: var(--panel); }
    .dashboard-hero-copy { min-width: 0; }
    .dashboard-eyebrow { color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .dashboard-task { margin-top: 8px; font-size: clamp(24px, 3vw, 36px); font-weight: 600; letter-spacing: -.025em; line-height: 1.25; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
    .dashboard-hero-status { display: grid; justify-items: end; gap: 8px; min-width: 170px; }
    .dashboard-hero-status strong { font-size: 15px; }
    .run-summary { display: grid; gap: 10px; }
    .run-summary-title { font-size: 15px; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
    .run-summary-note { color: var(--muted); font-size: 12px; line-height: 1.6; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
    .advanced-links { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
    .surface-row { display: flex; align-items: center; gap: 7px; color: var(--muted); }
    .surface-row strong { color: var(--text); font-weight: 650; }
    .approval-card { border-color: var(--accent); background: var(--panel); }
    .approval-command { margin-top: 8px; padding: 11px 12px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--panel-inset); white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
    .approval-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .quick-links-panel { margin-top: 12px; }
    .quick-links-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .quick-links { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px; }
    .quick-link { min-width: 0; min-height: 78px; display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--text); text-decoration: none; transition: transform var(--motion-fast) var(--ease-out); }
    .quick-link:hover { background: var(--panel-hover); border-color: var(--line-strong); }
    .quick-link:active { transform: translateY(1px); }
    .quick-link-copy { min-width: 0; }
    .quick-link-title { font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quick-link-note { margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .quick-link-arrow { color: var(--muted); font-size: 14px; }
    :is(button, a, input, select, textarea, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .btn.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
    .btn:disabled, :is(input, select, textarea):disabled { opacity: .55; cursor: not-allowed; }
    .btn[aria-busy="true"] { cursor: progress; }
    .btn[data-state="success"] { color: var(--ok); background: var(--ok-soft); }
    .btn[data-state="error"], [aria-invalid="true"] { border-color: var(--danger); }
    input[type="checkbox"] { accent-color: var(--accent); }
    .nav button, .project-nav button { min-height: 40px; }
    .nav button:active, .project-nav button:active { background: var(--panel-hover); }
    .nav-label { margin: var(--space-6) var(--space-2) var(--space-2); font-size: 11px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
    .project-nav { display: grid; gap: var(--space-1); }
    .project-nav button { min-width: 0; display: flex; gap: var(--space-2); align-items: center; width: 100%; padding: var(--space-2); border: 0; border-radius: var(--radius-small); background: transparent; color: var(--muted); text-align: left; font-size: 12px; }
    .project-nav button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-nav button:hover, .project-nav button[aria-current] { color: var(--text); background: var(--panel-2); }
    .project-nav button[aria-current]::before { content: ''; width: 4px; height: 4px; flex: 0 0 auto; background: var(--accent); }
    .skip-link { position: fixed; top: -100%; left: var(--space-4); z-index: 50; padding: var(--space-3); background: var(--accent); color: var(--on-accent); }
    .skip-link:focus { top: var(--space-3); }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-4); }
    .section-head .section-title { margin: 0; }
    .work-surface { min-width: 0; padding: var(--space-6); background: var(--panel); border-radius: var(--radius); }
    .work-surface .dashboard-task { display: block; margin: var(--space-5) 0; overflow: visible; line-height: 1.3; letter-spacing: -.03em; word-break: keep-all; text-wrap: balance; }
    .work-surface .dashboard-task.long-task { font-size: 18px; line-height: 1.6; letter-spacing: 0; text-wrap: pretty; }
    .workflow-head > .badge, .section-head > .badge { flex-shrink: 0; white-space: nowrap; }
    .work-surface .dashboard-eyebrow { color: var(--muted); font-weight: 600; }
    .work-ledger { display: flex; flex-wrap: wrap; gap: var(--space-4) var(--space-6); padding: var(--space-4) 0; margin: 0; border-block: 1px solid var(--line); }
    .work-ledger > div { min-width: 0; flex: 1 1 120px; }
    .work-ledger dt { color: var(--muted); font-size: 12px; }
    .work-ledger dd { margin: var(--space-1) 0 0; font-size: 14px; overflow-wrap: anywhere; }
    .work-result { padding-top: var(--space-5); }
    .work-result .run-summary-title { font-size: 18px; font-weight: 600; display: block; }
    .work-result .run-summary-note { display: block; max-width: 65ch; font-size: 14px; overflow-wrap: anywhere; }
    .attention-surface { min-width: 0; border-left: 2px solid var(--accent); background: var(--accent-soft); padding: var(--space-4); border-radius: 0 var(--radius) var(--radius) 0; }
    .attention-row { min-width: 0; padding: var(--space-4) 0; border-top: 1px solid var(--line); }
    .attention-row .goal-title { overflow-wrap: anywhere; }
    .attention-row .mono { margin-top: var(--space-2); }
    .attention-empty { display: flex; align-items: center; gap: var(--space-2); color: var(--muted); font-size: 12px; padding-block: var(--space-3); border-bottom: 1px solid var(--line); }
    .attention-empty::before { content: ''; width: 6px; height: 6px; background: var(--ok); border-radius: 50%; flex: 0 0 auto; }
    .host-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: var(--space-2); align-items: start; padding: var(--space-4) 0; border-bottom: 1px solid var(--line); }
    .host-row strong { font-size: 14px; font-weight: 600; }
    .host-row .sub { font-size: 12px; margin-top: var(--space-1); }
    .host-row .mono { grid-column: 1 / -1; }
    .section-block { min-width: 0; padding-top: var(--space-6); }
    .disclosure { border-top: 1px solid var(--line); margin-top: var(--space-4); padding-top: var(--space-3); }
    .disclosure summary { cursor: pointer; color: var(--muted); font-size: 12px; min-height: 36px; }
    .disclosure summary:hover { color: var(--text); }
    .approval-card { border-left: 2px solid var(--accent); padding: var(--space-5); background: var(--panel); }
    .role-head > div, .workflow-head > div { min-width: 0; }
    .role-head { flex-wrap: wrap; }
    .badge { max-width: 100%; overflow-wrap: anywhere; }
    .log-detail { white-space: normal; overflow-wrap: anywhere; }
    .quick-link { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; }
    dialog { max-height: calc(100dvh - 32px); overflow-y: auto; }
    @media (hover: none), (pointer: coarse) {
      .btn, .btn.small, .nav button, .project-nav button, .select, .input, .check, summary { min-height: 44px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .btn:active:not(:disabled), .quick-link:active { transform: none; }
    }
    .command-layout { display: grid; grid-template-columns: minmax(0,1fr) minmax(288px,336px); align-items: start; gap: var(--space-6); }
    .command-rail { min-width: 0; }
    .command-rail, [data-dashboard-region="activity"], [data-dashboard-region="quick-links"] { content-visibility: auto; contain-intrinsic-block-size: auto var(--deferred-block-size); }
    .work-counts { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-5); margin-top: var(--space-5); color: var(--muted); font-size: 12px; }
    .work-counts strong { font-size: 18px; font-weight: 600; color: var(--text); margin-right: var(--space-1); }
    .work-surface .workflow-panel { padding: var(--space-5) 0 0; margin-top: var(--space-5); border-top: 1px solid var(--line); border-radius: 0; }
    .work-surface .workflow-head .sub { font-size: 12px; }
    .work-surface .workflow-strip { gap: var(--space-1); }
    .workflow-strip::before { top: 12px; }
    .workflow-meta { flex-wrap: wrap; }
    .attention-surface > .btn { width: 100%; margin-bottom: var(--space-3); }
    .attention-surface .section-head { margin-bottom: var(--space-3); }
    .attention-command { margin-block: var(--space-3); overflow-wrap: anywhere; }
    .attention-row .mono { font-size: 12px; line-height: 1.6; }
    .host-note { font-size: 12px; line-height: 1.6; color: var(--muted); margin: var(--space-3) 0 0; }
    .command-rail .section-block { padding-top: var(--space-5); }
    .page-head .sub { max-width: 65ch; }
    .quick-links-panel { border-top: 1px solid var(--line); margin-top: var(--space-6); }
    .quick-links-panel .sub { font-size: 12px; }
    .project-list:empty::before { content: '등록된 프로젝트가 없습니다.'; color: var(--muted); padding-block: var(--space-4); }
    @media (max-width: 1180px) {
      .command-layout { grid-template-columns: 1fr; }
    }
    @media (max-width: 980px) {
      .guide-hero, .project-row { grid-template-columns: 1fr; }
      .grid-4 { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .role-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .guide-steps { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .quick-links { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .split { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .app { display: block; height: auto; min-height: 100dvh; }
      .main { overflow: visible; }
      .sidebar { display: none; }
      .topbar { display: grid; grid-template-columns: minmax(0,1fr); height: auto; min-height: 58px; padding: 10px 14px; gap: 8px; }
      .mobile-head { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--bg); }
      .mobile-head::-webkit-scrollbar { display: none; }
      .mobile-head .btn { white-space: nowrap; font-weight: 600; }
      .content { padding: var(--space-6) var(--space-4); }
      .work-surface { padding: var(--space-5); }
      .topbar { flex-wrap: wrap; position: static; }
      .crumb { flex: 1 1 160px; }
      .top-actions { flex-wrap: wrap; min-height: 44px; }
      .workflow-strip { grid-template-columns: repeat(3, minmax(0,1fr)); }
      .page-head { align-items: flex-start; flex-direction: column; }
      .page-head .toolbar { width: 100%; }
      .page-head .toolbar .btn { flex: 1 1 auto; min-height: 40px; }
      .grid-4, .grid-2, .role-grid, .form-grid { grid-template-columns: 1fr; }
      .quick-links { grid-template-columns: 1fr; }
      .guide-hero, .guide-steps, .guide-safety { grid-template-columns: 1fr; }
      .guide-hero-copy { min-height: auto; }
      .guide-flow { min-height: 180px; }
      .project-row { grid-template-columns: 1fr; }
      .log-row { grid-template-columns: 1fr; gap: 4px; }
      .check-grid { grid-template-columns: 1fr 1fr; }
      .top-actions .status-chip:nth-child(1) { display: none; }
      #top-role { display: none; }
      .dashboard-hero { align-items: flex-start; flex-direction: column; }
      .dashboard-hero-status { justify-items: start; min-width: 0; }
      .workflow-strip { grid-template-columns: repeat(4, minmax(0,1fr)); row-gap: 14px; }
      .workflow-strip::before, .workflow-step.active::after { display: none; }
      .mass-run-head, .run-lane-head { align-items: flex-start; flex-direction: column; }
      .mass-run-head .badges { width: 100%; }
      .run-lane-head .badge { align-self: flex-start; }
      .run-event { grid-template-columns: 1fr auto; }
      .run-event .event-detail { grid-column: 1 / -1; white-space: normal; overflow-wrap: anywhere; }
      .run-dag-scroll { margin-inline: calc(var(--space-2) * -1); padding-inline: var(--space-2); }
      .run-dag-node { padding: var(--space-2); }
    }
    @media (max-width: 480px) {
      .approval-card .role-head { flex-direction: column; align-items: stretch; }
      .approval-actions { width: 100%; justify-content: stretch; }
      .approval-actions .btn { flex: 1 1 100%; min-height: 42px; }
      .quick-links-head { align-items: flex-start; flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
<a class="skip-link" href="#content">본문으로 이동</a>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="brand-mark" aria-hidden="true">JK</div><div class="brand-copy"><strong>JK Control Center</strong><span id="brand-runtime">Runtime surface</span></div></div>
    <nav class="nav" id="nav" aria-label="Main navigation">
      <button data-page="dashboard" class="active"><span class="dot"></span>Dashboard</button>
      <button data-page="projects"><span class="dot"></span>Projects</button>
      <button data-page="approvals"><span class="dot"></span>Approvals</button>
      <button data-page="logs"><span class="dot"></span>Activity</button>
      <button data-page="system"><span class="dot"></span>Settings</button>
    </nav>
    <div><div class="nav-label">Projects</div><nav class="project-nav" id="project-nav" aria-label="Project navigation"></nav></div>
    <div class="sidebar-foot"><div class="surface-row" id="sidebar-surface"><span class="online">●</span><strong>Connecting…</strong></div><div id="sidebar-runtime">Runtime checking…</div></div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div class="crumb"><strong id="top-title">Dashboard</strong><span class="project-pill" id="top-project">—</span></div>
      <div class="top-actions"><button class="btn small hidden" id="top-approvals" title="Open pending approvals"></button><span class="status-chip" id="top-role">Auto <strong>Ready</strong></span><span class="status-chip" id="top-health">Connecting…</span><button class="btn small" id="refresh-all">Refresh</button></div>
    </header>
    <nav class="mobile-head" id="mobile-nav" aria-label="Mobile navigation"></nav>
    <section class="content" id="content" tabindex="-1"><div class="empty" role="status">작업 현황을 불러오는 중…</div></section>
  </main>
</div>
<dialog id="role-dialog" aria-labelledby="role-dialog-title">
  <div class="dialog-head"><strong id="role-dialog-title">Create Role</strong><button class="btn small ghost" data-close-dialog>Close</button></div>
  <div class="dialog-body">
    <div class="form-grid">
      <div class="field"><label for="role-name">Name</label><input class="input" id="role-name" maxlength="100" /></div>
      <div class="field"><label for="role-permission">Permission</label><select class="select" id="role-permission"><option value="inherit">Project Default</option><option value="read-only">Read Only</option><option value="tests-only">Tests Only</option><option value="full-write">Full Write</option><option value="image-only">Image Only</option></select></div>
      <div class="field full"><label for="role-description">Description</label><input class="input" id="role-description" maxlength="500" /></div>
      <div class="field full"><label for="role-instructions">Instructions</label><textarea class="textarea" id="role-instructions"></textarea></div>
      <div class="field full"><label for="workflow-preset">Workflow preset</label><select class="select" id="workflow-preset"><option value="">Custom</option></select></div>
      <div class="field full"><label for="role-workflow">Workflow preference</label><textarea class="textarea" id="role-workflow"></textarea></div>
      <div class="field full"><label>Tools</label><div class="check-grid" id="role-tools"></div></div>
      <div class="field full"><label for="role-skills">Skills (comma separated)</label><input class="input" id="role-skills" /></div>
    </div>
  </div>
  <div class="dialog-foot"><button class="btn" data-close-dialog>Cancel</button><button class="btn primary" id="save-role">Save Role</button></div>
</dialog>
<input type="file" id="import-role-file" accept="application/json,.json" class="hidden" />
<div class="toast" id="toast" aria-live="polite"></div>
<script>
(() => {
  const allowedPages = ['dashboard','projects','roles','skills','guide','goals','approvals','logs','system'];
  const primaryPages = ['dashboard','projects','approvals','logs','system'];
  const pageLabels = {dashboard:'Dashboard',projects:'Projects',roles:'Roles',skills:'Skills',guide:'Guide',goals:'Goals',approvals:'Approvals',logs:'Activity',system:'Settings'};
  const requestedPage = location.pathname === '/approvals' ? 'approvals' : new URLSearchParams(location.search).get('page');
  const state = { page: allowedPages.includes(requestedPage) ? requestedPage : 'dashboard', projects: [], roles: [], roleContext: null, status: null, execution: null, goals: [], approvals: [], jobs: [], approvalRevision: null, logs: [], notifications: null, selectedProjectId: null, editingRole: null, workflowPresets: [], activationPreset: null, controlApps: '', runtimeSampleAt: 0, reconnectTimer: null };
  const content = document.getElementById('content');
  const nav = document.getElementById('nav');
  const mobileNav = document.getElementById('mobile-nav');
  const toastEl = document.getElementById('toast');
  const pendingDecisions = new Set();
  const tools = ['code_search','file_read','tests','file_write','git','browser'];
  const workflowPhases = ['discover','plan','patch','verify','review','recovery','release'];
  const localHostnames = new Set(['localhost','127.0.0.1','::1']);
  const isLocalSurface = localHostnames.has(location.hostname) || location.hostname.endsWith('.localhost');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';
  const fmtAge = (ms) => { if (!ms) return '—'; const d = Math.max(0, Date.now() - ms); if (d < 60000) return Math.floor(d/1000) + 's ago'; if (d < 3600000) return Math.floor(d/60000) + 'm ago'; if (d < 86400000) return Math.floor(d/3600000) + 'h ago'; return Math.floor(d/86400000) + 'd ago'; };
  const fmtElapsed = (ms) => { if (!ms) return '—'; const d = Math.max(0, Date.now() - ms); const s = Math.floor(d / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60; return h ? h + '시간 ' + m + '분' : m ? m + '분 ' + sec + '초' : sec + '초'; };
  const fmtRemaining = (ms) => { if (!ms) return '—'; const d = Math.max(0, ms - Date.now()); if (d < 60000) return Math.ceil(d/1000) + 's'; return Math.ceil(d/60000) + 'm'; };
  const permissionLabel = (p) => ({'full-write':'Full Write','read-only':'Read Only','tests-only':'Tests Only','image-only':'Image Only','control':'Computer Control','inherit':'Project Default'})[p] || (p || '—');
  const permissionClass = (p) => p === 'full-write' ? 'ok' : p === 'read-only' ? 'warn' : p === 'tests-only' ? 'default' : '';
  const modeLabel = (mode) => ({implement:'Implement',debug:'Debug',research:'Research',review:'Review',plan:'Plan'})[mode] || 'Ready';
  function toast(message) { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2200); }
  async function api(path, options) { const res = await fetch(path, { cache:'no-store', headers: {'Content-Type':'application/json', ...(options && options.headers || {})}, ...options }); const text = await res.text(); const contentType = (res.headers.get('content-type') || '').toLowerCase(); let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; } if (res.status === 401 && body.code === 'OWNER_LOGIN_REQUIRED') { const current = location.pathname + location.search; location.href = '/login?return=' + encodeURIComponent(current); throw new Error('관리자 로그인이 필요합니다.'); } if (!res.ok) { const transient = res.status >= 500 || contentType.includes('text/html'); const err = new Error(transient ? 'JK 서버가 재시작 중입니다. 자동으로 다시 연결합니다.' : (body.error || ('HTTP ' + res.status))); err.transient = transient; err.status = res.status; throw err; } return body; }
  function scheduleReconnect() { if (state.reconnectTimer) return; state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; loadAll({quiet:true}); }, 1500); }
  async function loadProjectContext(projectId) {
    const roles = await api('/api/jk/roles?projectId=' + encodeURIComponent(projectId || ''));
    state.roles = roles.roles || [];
    state.roleContext = roles.activeRoleContext || null;
    state.workflowPresets = roles.workflowPresets || [];
  }
  async function loadSecondarySignals() {
    try {
      const previousDashboard = dashboardSnapshot();
      const [summary, logs, notifications] = await Promise.all([
        api('/api/jk/control/approvals/summary'), api('/api/jk/control/logs?limit=80'), api('/api/jk/control/notifications')
      ]);
      if (state.approvalRevision === null || summary.revision !== state.approvalRevision || state.page === 'approvals') {
        const approvals = await api('/api/jk/control/approvals');
        state.approvals = approvals.approvals || [];
        state.jobs = approvals.jobs || [];
        state.approvalRevision = approvals.revision || summary.revision || null;
      }
      state.logs = logs.logs || [];
      state.notifications = notifications.notifications || null;
      updateChrome();
      if (state.page === 'dashboard' || state.page === 'approvals' || state.page === 'logs' || state.page === 'system') render();
      if (state.page === 'dashboard') requestAnimationFrame(() => animateDashboardChanges(previousDashboard, dashboardSnapshot()));
    } catch (err) {
      if (err && err.transient) scheduleReconnect();
    }
  }
  async function loadAll({quiet=false}={}) {
    try {
      const previousDashboard = dashboardSnapshot();
      const [projects, status, execution, goals] = await Promise.all([
        api('/api/jk/projects'), api('/api/jk/control/status'), api('/api/jk/control/execution'), api('/api/jk/control/goals')
      ]);
      state.projects = projects.projects || [];
      state.status = status;
      state.runtimeSampleAt = Date.now();
      state.execution = execution;
      state.goals = goals.goals || [];
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
      state.activationPreset = state.activationPreset || status.session.leasePreset || 'read-only';
      if (!state.controlApps) state.controlApps = (status.session.controlAllowlist || []).join(', ');
      const desired = state.selectedProjectId || projects.activeProjectId || (state.projects[0] && state.projects[0].projectId) || null;
      state.selectedProjectId = state.projects.some(p => p.projectId === desired) ? desired : ((state.projects[0] && state.projects[0].projectId) || null);
      if (state.selectedProjectId) await loadProjectContext(state.selectedProjectId);
      updateChrome(); render();
      requestAnimationFrame(() => animateDashboardChanges(previousDashboard, dashboardSnapshot()));
      setTimeout(() => { void loadSecondarySignals(); }, 0);
      if (!quiet) toast('Refreshed');
    } catch (err) { if (err && err.transient) { if (!state.status) content.innerHTML = '<div class="empty">JK 서버 재연결 중…</div>'; scheduleReconnect(); return; } content.innerHTML = '<div class="empty" role="alert">Control Center API error: ' + esc(err.message) + '</div>'; }
  }
  function updateChrome() {
    const project = state.projects.find(p => p.projectId === state.selectedProjectId);
    const execution = state.execution && state.execution.execution || {};
    const runtimeCtx = state.status && state.status.roleContext || state.roleContext || {};
    const role = runtimeCtx.role || {};
    const manualOverride = runtimeCtx.selectionSource === 'last-used';
    document.getElementById('top-title').textContent = pageLabels[state.page] || 'JK';
    document.getElementById('top-project').textContent = project ? project.name + ' · ' + project.projectId : 'No project';
    document.getElementById('top-role').innerHTML = (manualOverride ? 'Override ' : 'Auto ') + '<strong>' + esc(manualOverride ? (role.name || 'Role') : modeLabel(execution.mode)) + '</strong>';
    document.getElementById('sidebar-runtime').textContent = state.status ? ('PID ' + state.status.runtime.pid + ' · ' + Math.floor(state.status.runtime.uptimeSec) + 's') : 'Runtime unavailable';
    document.getElementById('brand-runtime').textContent = isLocalSurface ? ('Local runtime · :' + (location.port || '7979')) : ('Cloud runtime · ' + location.hostname);
    const surface = document.getElementById('sidebar-surface');
    if (surface) surface.innerHTML = '<span class="online">●</span><strong>' + esc(isLocalSurface ? 'Local admin' : 'Secure remote admin') + '</strong>';
    const approvalButton = document.getElementById('top-approvals');
    if (approvalButton) {
      approvalButton.textContent = '승인 대기 ' + state.approvals.length;
      approvalButton.classList.toggle('hidden', state.approvals.length === 0);
      approvalButton.style.borderColor = state.approvals.length ? 'var(--accent)' : '';
      approvalButton.style.color = state.approvals.length ? 'var(--accent)' : '';
    }
    [...nav.querySelectorAll('button'), ...mobileNav.querySelectorAll('button')].forEach(b => {
      const selected = b.dataset.page === state.page;
      b.classList.toggle(nav.contains(b) ? 'active' : 'primary', selected);
      if (selected) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
    });
    document.getElementById('top-health').innerHTML = state.status ? '<span class="online">●</span> Online' : 'Connecting…';
    document.title = (pageLabels[state.page] || 'Dashboard') + ' · JK Control Center';
    const projectsNav = document.getElementById('project-nav');
    const projectItems = state.projects.map(p => '<button data-project-context="' + esc(p.projectId) + '"' + (p.projectId === state.selectedProjectId ? ' aria-current="true"' : '') + ' title="' + esc(p.name) + '"><span>' + esc(p.name) + '</span></button>').join('') || '<div class="sub">프로젝트 없음</div>';
    if (projectsNav.innerHTML !== projectItems && !projectsNav.contains(document.activeElement)) projectsNav.innerHTML = projectItems;
  }
  function projectSelector() {
    return '<select class="select" aria-label="Project context" id="project-context-select" style="max-width:320px">' + state.projects.map(p => '<option value="' + esc(p.projectId) + '" ' + (p.projectId === state.selectedProjectId ? 'selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>';
  }
  function executorInfo() { return state.status && state.status.executors || {local:null,items:[],routes:{}}; }
  function projectRouteLabel(project) {
    if (!project) return 'Unknown · 프로젝트 미선택';
    const info = executorInfo();
    const id = project.executorKind === 'remote' ? project.executorId : (info.routes || {})[project.projectId] || 'local';
    if (id === 'local' || id === 'oci-main') return info.local ? info.local.label || info.local.executorId : 'Unknown · Hub';
    const worker = (info.items || []).find(w => w.executorId === id);
    return (worker && worker.label || id || 'Unknown') + (worker ? worker.online ? '' : ' · Offline' : ' · Unknown');
  }
  function executionLocationHtml(target) {
    if (!target) return '<div class="mono" data-execution-location data-target-kind="unknown">실행 위치 Unknown · 저장된 대상 증거 없음</div>';
    const info = executorInfo();
    const host = target.kind === 'local' ? info.local : (info.items || []).find(w => w.executorId === target.executorId);
    const label = host && host.label || target.executorId;
    return '<div class="mono" data-execution-location data-target-kind="' + esc(target.kind) + '" data-executor-id="' + esc(target.executorId) + '">실행 위치 · ' + esc(label) + ' <span class="badge">' + esc(target.kind) + '</span><br>' + esc(target.projectRoot) + '</div>';
  }
  function approvalTarget(approval) {
    const job = state.jobs.find(j => (j.approvalId || j.id) === approval.id);
    return job && job.executionTarget;
  }
  function compactHostsHtml() {
    const info = executorInfo();
    const row = (host, label, purpose) => {
      const status = !host || typeof host.online !== 'boolean' ? 'unknown' : host.online ? 'online' : 'offline';
      return '<div class="host-row" data-executor-id="' + esc(host && host.executorId || label) + '" data-host-state="' + status + '"><div><strong>' + esc(host && host.label || label) + '</strong><div class="sub">' + esc(purpose) + '</div></div><span class="badge ' + (status === 'online' ? 'ok' : status === 'offline' ? 'warn' : '') + '">' + esc(status === 'unknown' ? 'Unknown' : status === 'online' ? 'Online' : 'Offline') + '</span>' + (host ? '<div class="mono">' + esc(host.platform || 'Unknown') + (host.lastSeenAtMs ? ' · ' + esc(fmtAge(host.lastSeenAtMs)) : '') + '</div>' : '') + '</div>';
    };
    const workers = info.items || [];
    return '<section class="section-block" data-dashboard-region="hosts" aria-labelledby="hosts-heading"><div class="section-head"><h2 class="section-title" id="hosts-heading">실행 호스트</h2><button class="btn ghost small" data-nav-page="projects">관리</button></div>' + row(info.local, 'OCI Hub', '연결 · 승인 관리') + (workers.length ? workers.map(w => row(w, w.executorId, '프로젝트 실행 · outbound worker')).join('') : row(null, 'Windows executor', '아직 연결된 실행기가 없습니다.')) + '<p class="host-note">지정된 실행기가 오프라인이면 실행을 중단합니다. 다른 호스트에서 대신 실행하지 않습니다.</p></section>';
  }
  function executorSummaryHtml() {
    const info = executorInfo();
    const local = info.local;
    const workers = info.items || [];
    const row = (item, localRow=false) => '<div class="project-row"><div><div class="project-name"><span class="badge ' + (item.online ? 'ok' : 'warn') + '">' + (item.online ? '● ONLINE' : '○ OFFLINE') + '</span> ' + esc(item.label || item.executorId) + '</div><div class="mono">' + esc(item.platform || 'unknown') + '</div><div class="sub">' + esc(localRow ? ((item.projectCount || 0) + ' OCI project(s)') : (((item.projects || []).length) + ' project(s) · heartbeat ' + fmtAge(item.lastSeenAtMs))) + '</div></div><div class="badges"><span class="badge">' + esc(item.executorId) + '</span>' + (localRow ? '<span class="badge default">Hub</span>' : '<span class="badge">Outbound worker</span>') + '</div></div>';
    return '<div class="panel" style="margin-top:12px"><div class="role-head"><div><h2 class="section-title">Executors</h2><div class="sub">Hub는 연결과 승인을 관리하고 PC는 outbound worker로 작업을 실행합니다. 지정된 worker가 오프라인이거나 대상 정보가 달라지면 실행을 중단합니다. OCI 사본으로 자동 전환하지 않습니다.</div></div><div class="toolbar"><span class="badge ' + (workers.some(x=>x.online) ? 'ok' : 'default') + '">' + esc(workers.filter(x=>x.online).length + ' remote online') + '</span><button class="btn small" id="pair-windows-executor">Windows 연결</button></div></div><div class="project-list" style="margin-top:12px">' + (local ? row(local, true) : '<div class="empty">Hub status Unknown</div>') + workers.map(w => row(w, false)).join('') + '</div></div>';
  }
  async function pairWindowsExecutor() {
    const workspace = window.prompt('Windows에서 JK가 접근할 workspace 경로를 입력하세요.', 'C:\\workspace');
    if (!workspace) return;
    const issued = await api('/api/jk/control/executors/windows-main/token', {method:'POST'});
    const token = issued.token;
    const hub = location.origin;
    const cleanWorkspace = workspace.replace(/"/g,'');
    const command = '$d=Join-Path $env:LOCALAPPDATA "JK"; New-Item -ItemType Directory -Force $d | Out-Null; $f=Join-Path $d "executor-token.txt"; Set-Content -NoNewline -Encoding ascii $f "' + token + '"; $env:JK_HUB_URL="' + hub + '"; $env:JK_EXECUTOR_ID="windows-main"; $env:JK_EXECUTOR_WORKSPACE="' + cleanWorkspace + '"; $env:JK_EXECUTOR_TOKEN_FILE=$f; [Environment]::SetEnvironmentVariable("JK_HUB_URL",$env:JK_HUB_URL,"User"); [Environment]::SetEnvironmentVariable("JK_EXECUTOR_ID",$env:JK_EXECUTOR_ID,"User"); [Environment]::SetEnvironmentVariable("JK_EXECUTOR_WORKSPACE",$env:JK_EXECUTOR_WORKSPACE,"User"); [Environment]::SetEnvironmentVariable("JK_EXECUTOR_TOKEN_FILE",$f,"User"); $env:JK_EXECUTOR_ONLY="1"; [Environment]::SetEnvironmentVariable("JK_EXECUTOR_ONLY","1","User"); $startup=[Environment]::GetFolderPath("Startup"); $legacy=Join-Path $startup "JK Executor.cmd"; if(Test-Path -LiteralPath $legacy){try{$raw=Get-Content -Raw -LiteralPath $legacy; if($raw -match "executor-supervisor\\.js"){Remove-Item -Force -LiteralPath $legacy}}catch{}}; Write-Host "JK Windows worker configured in executor-only mode. Restart JK once."';
    try { await navigator.clipboard.writeText(command); } catch {}
    window.prompt('아래 명령을 Windows PowerShell에서 한 번 실행한 뒤 JK 앱을 한 번 재시작하세요. 이제 worker 재시작과 장애 복구는 JK 앱이 직접 관리합니다. JK 설정의 Windows 시작 시 JK 실행을 켜두면 로그인 후 자동 연결됩니다. 클립보드에도 복사했습니다.', command);
  }
  function projectExecutorControl(p) {
    if (p.executorKind === 'remote') return '<div class="badges"><span class="badge ok">' + esc(p.executorId || 'remote') + '</span><span class="badge">Remote</span></div>';
    const info = executorInfo();
    const routes = info.routes || {};
    const selected = routes[p.projectId] || 'local';
    const workers = (info.items || []).filter(w => (w.projects || []).some(r => r.projectId === p.projectId));
    const options = '<option value="oci-main" ' + (selected === 'local' || selected === 'oci-main' ? 'selected' : '') + '>OCI Hub</option>' + workers.map(w => '<option value="' + esc(w.executorId) + '" ' + (selected === w.executorId ? 'selected' : '') + '>' + esc((w.label || w.executorId) + (w.online ? ' · online' : ' · offline')) + '</option>').join('');
    return '<label class="sub">Executor <select class="select" data-executor-route-project="' + esc(p.projectId) + '" style="width:170px;margin-left:6px">' + options + '</select></label>';
  }
  function quickLinksHtml() {
    const custom = state.status && Array.isArray(state.status.quickLinks) ? state.status.quickLinks : [];
    const hiddenQuickLinkTitles = ['CleanTube APK', 'Gecko QA APK'];
    const links = custom.filter(link => !hiddenQuickLinkTitles.includes(String(link.title || '')));
    const items = links.map(link => '<a class="quick-link" href="' + esc(link.href) + '" target="_blank" rel="noopener noreferrer"><div class="quick-link-copy"><div class="quick-link-title">' + esc(link.title) + '</div><div class="quick-link-note">' + esc(link.note) + '</div><div class="badges" style="margin-top:8px"><span class="badge ' + esc(link.badgeClass) + '">' + esc(link.badge) + '</span></div></div><span class="quick-link-arrow" aria-hidden="true">↗</span></a>').join('');
    return '<div class="section-block quick-links-panel" data-dashboard-region="quick-links"><div class="quick-links-head"><div><h2 class="section-title" style="margin-bottom:4px">Quick Links</h2><div class="sub">별도 서비스와 배포 진입점만 모았습니다.</div></div><span class="badge">' + esc(links.length) + ' links</span></div><div class="quick-links">' + (items || '<div class="empty">등록된 외부 링크가 없습니다.</div>') + '</div></div>';
  }
  function deploymentStatusHtml() {
    const d = state.status && state.status.deployment || null;
    if (!d) return '';
    const short = (sha) => sha ? String(sha).slice(0, 8) : '—';
    const synced = d.state === 'synced';
    const stateClass = synced ? 'ok' : (d.state === 'drift' || d.state === 'dirty') ? 'warn' : 'default';
    return '<div class="panel" style="margin-top:12px"><div class="role-head"><div><h2 class="section-title">Deployment</h2><div class="sub"><span class="mono">Upstream ' + esc(short(d.upstreamSha)) + '</span> → <span class="mono">Runtime ' + esc(short(d.deployedSha)) + '</span> · 마지막 배포 ' + esc(fmtAge(d.lastSyncAtMs)) + '</div></div><span class="badge ' + stateClass + '">' + esc((d.state || 'unknown').toUpperCase()) + '</span></div><div class="badges" style="margin-top:10px"><span class="badge ' + (d.build === 'pass' ? 'ok' : 'default') + '">Build ' + esc((d.build || 'unknown').toUpperCase()) + '</span><span class="badge ' + (d.health === 'pass' ? 'ok' : 'warn') + '">Health ' + esc((d.health || 'unknown').toUpperCase()) + '</span><span class="badge ' + (d.tunnel === 'pass' ? 'ok' : 'warn') + '">Network ' + esc((d.tunnel || 'unknown').toUpperCase()) + '</span></div></div>';
  }
  function deploymentActionHtml() {
    const command = 'bash scripts/sync-jk-oci.sh --reload-current';
    const approval = state.approvals.find(a => a.commandPreview === command);
    const job = state.jobs.find(j => j.commandPreview === command && (j.status === 'pending' || j.status === 'running'));
    const status = job && job.status || (approval ? 'pending' : 'ready');
    const label = status === 'pending' ? '승인 대기 중' : status === 'running' ? '동기화 중' : '서버 동기화 · 재시작';
    return '<div class="panel" style="margin-top:12px"><div class="role-head"><div><h2 class="section-title">JK Runtime</h2><div class="sub">Git upstream 확인 → fast-forward → build 검증 → runtime reload → health/tunnel QA를 한 작업으로 실행합니다. 고위험 단계는 승인 1회만 필요합니다.</div></div><span class="badge ' + (status === 'running' ? 'active' : status === 'pending' ? 'warn' : 'ok') + '">' + esc(status.toUpperCase()) + '</span></div><div class="actions" style="margin-top:12px"><button class="btn primary" id="sync-jk-runtime"' + (status === 'running' ? ' disabled' : '') + '>' + esc(label) + '</button><button class="btn" id="open-runtime-approvals">승인 보기</button></div></div>';
  }
  function dashboard() {
    const e = state.execution && state.execution.execution || {};
    const ctx = state.status && state.status.roleContext || {};
    const task = e.task || e.goal;
    const history = [...state.goals, ...state.jobs.filter(j => j.finishedAt && !j.interruptedByRestart)].sort((a,b) => (b.updatedAt || b.finishedAt || 0) - (a.updatedAt || a.finishedAt || 0))[0];
    const workState = task ? 'active' : history || e.lastProgressSummary ? 'history' : 'idle';
    const projectId = task ? e.projectId : history && history.projectId || state.status && state.status.session.activeProjectId;
    const project = state.projects.find(p => p.projectId === projectId);
    const title = task || history && (history.currentTask || history.currentGoal || history.commandPreview) || (e.lastProgressSummary ? '최근 작업 결과' : '현재 실행 중인 작업이 없습니다.');
    const note = task ? e.lastProgressSummary : history && (history.lastProgressSummary || history.stdoutSummary || history.stderrSummary || history.error) || e.lastProgressSummary;
    const verification = task ? e.verificationStatus || 'unknown' : history && history.status || 'unknown';
    const resultClass = ['pass','succeeded'].includes(verification) ? 'ok' : ['fail','failed'].includes(verification) ? 'danger' : verification === 'blocked' ? 'warn' : 'default';
    const updatedAt = task ? e.updatedAt : history && (history.updatedAt || history.finishedAt);
    return '<div class="page-head"><div><h1>JK Control Center</h1><div class="sub">작업의 흐름을 확인하고, 필요한 순간에만 승인하세요.</div></div><button class="btn ghost small" data-nav-page="projects">프로젝트 보기</button></div>' +
      '<div class="command-layout"><section class="work-surface" data-dashboard-region="work" data-work-state="' + workState + '" aria-labelledby="work-heading"><div class="section-head"><div class="dashboard-eyebrow">' + (task ? '현재 작업 · 컨텍스트' : workState === 'history' ? '최근 작업 기록' : '다음 작업을 기다립니다') + '</div><span class="badge ' + resultClass + '">' + esc(task ? verification : history && history.status || 'idle') + '</span></div><h2 class="dashboard-task' + (title.length > 100 ? ' long-task' : '') + '" id="work-heading">' + esc(title) + '</h2>' +
      '<dl class="work-ledger"><div><dt>프로젝트</dt><dd>' + esc(project ? project.name : e.projectName || projectId || '선택 안 됨') + '</dd></div><div><dt>선택된 실행 위치</dt><dd>' + esc(projectRouteLabel(project)) + '</dd></div><div><dt>' + (task ? '실행 모드' : '마지막 기록') + '</dt><dd>' + esc(task ? modeLabel(e.mode) : updatedAt ? fmtAge(updatedAt) : '기록 없음') + '</dd></div></dl>' +
      '<div class="work-result"><h3 class="section-title">' + (note ? '최근 진행 내용' : task ? '진행 상황' : '다음 작업') + '</h3><div class="run-summary-note">' + esc(note || (task ? '아직 진행 요약이 보고되지 않았습니다.' : 'ChatGPT에서 @jk로 원하는 작업을 자연어로 말하면 됩니다.')) + '</div>' +
      (task ? '<div class="work-counts"><span><strong>' + esc(e.completedCount || 0) + '</strong> 완료</span><span><strong>' + esc(e.pendingCount || 0) + '</strong> 대기</span><span class="mono">갱신 ' + esc(fmtAge(updatedAt)) + '</span></div>' : history && history.completed && history.completed.length ? '<ul class="progress-list">' + history.completed.slice(-3).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') + '</div>' +
      (task ? workflowRailHtml() : '') +
      '<details class="disclosure" id="work-context-details"><summary id="work-context-summary">권한 · 안전 경계</summary><dl class="kv"><dt>Role</dt><dd>' + esc(ctx.role && ctx.role.name || 'Default') + (ctx.selectionSource === 'last-used' ? ' · Manual' : ' · Auto') + '</dd><dt>권한</dt><dd>' + esc(permissionLabel(ctx.effectivePermission)) + '</dd><dt>승인 정책</dt><dd>고위험 작업만 사용자 확인</dd></dl><button class="btn ghost small" data-nav-page="system">Settings · Advanced</button></details></section>' +
      '<aside class="command-rail" aria-label="승인과 실행 호스트"><section id="dashboard-approvals-root" data-dashboard-region="attention" aria-label="Attention">' + pendingApprovalsBanner() + '</section>' + compactHostsHtml() + '</aside></div>' +
      coordinationPerformanceHtml() +
      '<section class="section-block" data-dashboard-region="activity" aria-labelledby="activity-heading"><div class="section-head"><h2 class="section-title" id="activity-heading">최근 활동</h2><button class="btn ghost small" data-nav-page="logs">전체 활동</button></div><div id="dashboard-activity-root">' + logList(state.logs.slice(0,6)) + '</div></section>' + quickLinksHtml();
  }
  function coordinationPerformanceHtml() {
    const t = state.status && state.status.goalLoopTelemetry;
    if (!t || !t.samples) return '<section class="section-block coord-perf" data-dashboard-region="coordination-performance"><div class="section-head"><h2 class="section-title">Coordination 성능</h2><span class="badge default">데이터 수집 중</span></div><div class="empty">Standard / Dispatcher 실사용 telemetry가 쌓이면 최근 성능 비교를 표시합니다.</div></section>';
    const s = t.standard || {}, d = t.dispatcher || {}, delta = t.dispatcherVsStandard || {};
    const fmtBytes = v => v == null ? '—' : v >= 1024 ? (v / 1024).toFixed(1) + ' KB' : Math.round(v) + ' B';
    const fmtMs = v => v == null ? '—' : Math.round(v) + ' ms';
    const fmtRate = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
    const fmtDelta = v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
    const maxBytes = Math.max(Number(s.avgResponseBytes || 0), Number(d.avgResponseBytes || 0), 1);
    const sWidth = Math.max(2, Math.round(Number(s.avgResponseBytes || 0) / maxBytes * 100));
    const dWidth = Math.max(2, Math.round(Number(d.avgResponseBytes || 0) / maxBytes * 100));
    const enough = Number(s.samples || 0) >= 20 && Number(d.samples || 0) >= 20;
    return '<section class="section-block coord-perf" data-dashboard-region="coordination-performance"><div class="section-head"><div><h2 class="section-title" style="margin-bottom:4px">Coordination 성능</h2><div class="sub">최근 ' + esc(t.samples) + '건 · selector 튜닝 최소 표본 20/20</div></div><span class="badge ' + (enough ? 'ok' : 'default') + '">' + (enough ? '튜닝 활성' : '관찰 중') + '</span></div>' +
      '<div class="grid-4">' +
      metric('Standard', fmtBytes(s.avgResponseBytes), fmtMs(s.avgDurationMs) + ' · ' + esc(s.samples || 0) + ' samples', 'coord-standard') +
      metric('Dispatcher', fmtBytes(d.avgResponseBytes), fmtMs(d.avgDurationMs) + ' · ' + esc(d.samples || 0) + ' samples', 'coord-dispatcher') +
      metric('Payload Δ', fmtDelta(delta.responseBytesDeltaPct), 'Dispatcher vs Standard', 'coord-payload-delta') +
      metric('Failure / Retry', fmtRate(d.failureRate) + ' / ' + fmtRate(d.retryRate), 'Dispatcher 기준', 'coord-reliability') +
      '</div><div class="coord-perf-bars"><div class="coord-perf-row"><span>Standard</span><div class="coord-perf-track"><div class="coord-perf-fill standard" style="width:' + sWidth + '%"></div></div><span>' + esc(fmtBytes(s.avgResponseBytes)) + '</span></div><div class="coord-perf-row"><span>Dispatcher</span><div class="coord-perf-track"><div class="coord-perf-fill" style="width:' + dWidth + '%"></div></div><span>' + esc(fmtBytes(d.avgResponseBytes)) + '</span></div></div></section>';
  }
  function metric(label, value, meta, key='') { return '<div class="metric" data-metric-key="' + esc(key) + '"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="meta">' + esc(meta) + '</div></div>'; }
  function runtimeMetaText() {
    const runtime = state.status && state.status.runtime || {};
    const sampled = Number(runtime.uptimeSec || 0);
    const elapsed = state.runtimeSampleAt ? Math.max(0, (Date.now() - state.runtimeSampleAt) / 1000) : 0;
    return (runtime.mode || 'unknown') + ' · PID ' + (runtime.pid || '—') + ' · uptime ' + Math.floor(sampled + elapsed) + 's';
  }
  function tickRuntimeClock() {
    if (document.hidden) return;
    const meta = document.querySelector('.metric[data-metric-key="runtime"] .meta');
    if (meta) meta.textContent = runtimeMetaText();
    const runElapsed = document.querySelector('[data-run-started-at]');
    if (runElapsed) runElapsed.textContent = '소요 ' + fmtElapsed(Number(runElapsed.dataset.runStartedAt || 0));
    if (state.status) document.getElementById('sidebar-runtime').textContent = 'PID ' + state.status.runtime.pid + ' · ' + Math.floor(Number(state.status.runtime.uptimeSec || 0) + Math.max(0, (Date.now() - state.runtimeSampleAt) / 1000)) + 's';
  }
  function dashboardSnapshot() {
    const runtimeCtx = state.status && state.status.roleContext || {};
    const activeProject = state.projects.find(p => p.projectId === (state.status && state.status.session.activeProjectId));
    const execution = state.execution && state.execution.execution || {};
    return {
      project: activeProject && activeProject.projectId || null,
      mode: execution.mode || null,
      permission: runtimeCtx.effectivePermission || null,
      approvals: state.approvals.length,
      phase: execution.phase || null,
      latestLog: state.logs[0] && state.logs[0].ts || null
    };
  }
  function animateDashboardChanges(previous, next) {
    if (!previous || state.page !== 'dashboard') return;
    ['project','mode','permission','approvals'].forEach(key => {
      if (previous[key] === next[key]) return;
      const el = document.querySelector('.metric[data-metric-key="' + key + '"]');
      if (el) el.classList.add('changed');
    });
    if (next.approvals > previous.approvals) {
      const banner = document.querySelector('#dashboard-approvals-root .attention-surface');
      if (banner) banner.classList.add('attention');
    }
    if (next.latestLog && next.latestLog !== previous.latestLog) {
      const row = document.querySelector('#dashboard-activity-root .log-row');
      if (row) row.classList.add('fresh');
    }
  }
  function pendingApprovalsBanner() {
    const e = state.execution && state.execution.execution || {};
    const failed = e.verificationStatus === 'fail' || e.lastVerificationFailed;
    const blocked = e.recoveryNeeded || e.verificationStatus === 'blocked';
    const attentionState = state.approvals.length ? 'pending' : failed ? 'error' : blocked ? 'blocked' : 'empty';
    const failure = failed || blocked ? '<div class="attention-row"><div class="goal-title">' + (failed ? '검증 확인이 필요합니다' : '작업이 중단되었습니다') + '</div><p class="sub">' + esc(e.lastProgressSummary || '실행 기록에서 중단 이유를 확인하세요.') + '</p><a class="btn small" href="/?page=goals">실행 기록</a></div>' : '';
    if (!state.approvals.length) return '<div data-attention-state="' + attentionState + '"><div class="attention-empty">승인 대기 없음</div>' + (failure ? '<div class="attention-surface">' + failure + '</div>' : '') + '</div>';
    const rows = state.approvals.slice(0,2).map(a => {
      const project = state.projects.find(p => p.projectId === a.projectId);
      return '<div class="attention-row" data-approval-id="' + esc(a.id) + '"><div class="goal-title">' + esc(project ? project.name : a.projectId) + '</div>' + executionLocationHtml(approvalTarget(a)) + '<div class="attention-command mono">' + esc(a.commandPreview) + '</div><div class="goal-meta"><span>' + esc(fmtRemaining(a.expiresAt)) + ' 후 만료</span>' + (a.needsNetwork ? '<span class="badge warn">Network</span>' : '') + (a.destructive ? '<span class="badge danger">Destructive</span>' : '') + '</div></div>';
    }).join('');
    return '<div class="attention-surface" data-attention-state="pending"><div class="section-head"><h2 class="section-title">승인이 필요합니다</h2><span class="badge warn">' + esc(state.approvals.length) + '</span></div><button class="btn primary" id="open-approvals">승인 검토</button>' + rows + (state.approvals.length > 2 ? '<div class="sub">외 ' + esc(state.approvals.length - 2) + '건 · 승인 화면에서 전체 확인</div>' : '') + failure + '</div>';
  }
${MASS_ULW_DASHBOARD_SCRIPT}
  function runWaitReasonHtml(e) {
    const approval = state.approvals.find(item => !e.projectId || item.projectId === e.projectId);
    if (approval) return '<div class="run-wait-reason waiting" data-run-reason="approval"><strong>왜 기다리나</strong><span>사용자 승인 대기 · 승인되면 기존 queued job을 이어서 실행합니다.</span></div>';
    const massUlw = e.massUlw;
    if (massUlw) {
      const blocked = Array.isArray(massUlw.blockedDependencies) ? massUlw.blockedDependencies : [];
      if (blocked.length) return '<div class="run-wait-reason problem" data-run-reason="dependency"><strong>왜 기다리나</strong><span>의존 작업 확인 필요 · ' + esc(blocked.join(', ')) + '</span></div>';
      const lanes = Array.isArray(massUlw.lanes) ? massUlw.lanes : [];
      const running = lanes.filter(lane => lane.status === 'in-flight');
      if (running.length) return '<div class="run-wait-reason" data-run-reason="running"><strong>현재 상태</strong><span>병렬 작업 ' + esc(running.length) + '개 진행 중 · 완료되는 lane부터 다음 의존 작업이 열립니다.</span></div>';
      if (massUlw.verification === 'in-flight') return '<div class="run-wait-reason" data-run-reason="verification"><strong>현재 상태</strong><span>통합 검증 진행 중 · 모든 lane을 합친 결과를 확인하고 있습니다.</span></div>';
      const planned = lanes.filter(lane => lane.status === 'planned');
      if (planned.length) return '<div class="run-wait-reason waiting" data-run-reason="wave"><strong>왜 기다리나</strong><span>다음 Wave 시작 대기 · 준비된 작업 ' + esc(planned.length) + '개</span></div>';
    }
    if (e.recoveryNeeded || e.verificationStatus === 'blocked') return '<div class="run-wait-reason problem" data-run-reason="recovery"><strong>왜 기다리나</strong><span>' + esc(e.lastProgressSummary || '복구 또는 검증 blocker를 확인해야 합니다.') + '</span></div>';
    return '';
  }
  function runEventsHtml(e) {
    const events = state.logs.filter(item => !e.projectId || !item.projectId || item.projectId === e.projectId).slice(0,4);
    if (!events.length) return '';
    return '<div class="run-events"><div class="dashboard-eyebrow">RECENT EVENTS</div><div class="run-event-list">' + events.map(item => '<div class="run-event"><span class="event-type">' + esc(item.type) + '</span><span class="event-detail">' + esc(item.detail || item.projectId || '') + '</span><span>' + esc(fmtAge(item.ts)) + '</span></div>').join('') + '</div></div>';
  }
  function workflowRailHtml() {
    const e = state.execution && state.execution.execution || {};
    const current = e.phase || null;
    const steps = workflowPhases.map(phase => {
      const status = phase === current ? 'active' : 'future';
      return '<div class="workflow-step ' + status + '"><span class="workflow-dot"></span><span class="workflow-label">' + esc(phase) + '</span></div>';
    }).join('');
    const verificationClass = e.verificationStatus === 'pass' ? 'ok' : e.verificationStatus === 'fail' ? 'danger' : e.verificationStatus === 'blocked' ? 'warn' : 'default';
    if (!e.task && !e.goal && !e.phase) return '';
    const startedAt = e.massUlw && e.massUlw.createdAt;
    const elapsed = startedAt ? '<span data-run-started-at="' + esc(startedAt) + '">소요 ' + esc(fmtElapsed(startedAt)) + '</span>' : '';
    return '<div class="panel workflow-panel"><div class="workflow-head"><div><h2 class="section-title" style="margin-bottom:0">실행 단계</h2><div class="sub">탐색 → 구현 → 검증 중 현재 위치와 병렬 작업을 실시간으로 보여줍니다.</div></div><span class="badge ' + verificationClass + '">' + esc(e.verificationStatus || 'unknown') + '</span></div><div id="workflow-rail-root"><div class="workflow-strip">' + steps + '</div><div class="workflow-meta"><span>' + esc(e.primaryStage || 'idle') + (e.supportingStages && e.supportingStages.length ? ' + ' + esc(e.supportingStages.join(', ')) : '') + '</span><span>' + esc((e.completedCount || 0) + ' 완료 · ' + (e.pendingCount || 0) + ' 대기') + (elapsed ? ' · ' + elapsed : '') + '</span></div>' + runWaitReasonHtml(e) + massUlwStatusHtml(e) + runEventsHtml(e) + '</div></div>';
  }
  async function refreshExecution() {
    if (document.hidden) return;
    try {
      const nextExecution = await api('/api/jk/control/execution');
      if (JSON.stringify(nextExecution) === JSON.stringify(state.execution)) return;
      state.execution = nextExecution;
      updateChrome();
      if (state.page === 'dashboard') {
        render();
      }
    } catch {}
  }
  async function refreshSignals() {
    if (document.hidden) return;
    try {
      const previous = dashboardSnapshot();
      const [summary, logs] = await Promise.all([api('/api/jk/control/approvals/summary'), api('/api/jk/control/logs?limit=80')]);
      let nextApprovals = state.approvals;
      let nextJobs = state.jobs;
      if (state.approvalRevision === null || summary.revision !== state.approvalRevision || state.page === 'approvals') {
        const approvals = await api('/api/jk/control/approvals');
        nextApprovals = approvals.approvals || [];
        nextJobs = approvals.jobs || [];
        state.approvalRevision = approvals.revision || summary.revision || null;
      }
      const nextLogs = logs.logs || [];
      const approvalsChanged = nextApprovals.map(x => x.id).join('|') !== state.approvals.map(x => x.id).join('|');
      const jobsChanged = nextJobs.map(x => [x.id,x.status,x.finishedAt,x.exitCode].join(':')).join('|') !== state.jobs.map(x => [x.id,x.status,x.finishedAt,x.exitCode].join(':')).join('|');
      const logsChanged = (nextLogs[0] && nextLogs[0].ts || null) !== (state.logs[0] && state.logs[0].ts || null);
      state.approvals = nextApprovals;
      state.jobs = nextJobs;
      state.logs = nextLogs;
      updateChrome();
      if (state.page === 'dashboard') {
        if (approvalsChanged || jobsChanged || logsChanged) render();
        requestAnimationFrame(() => animateDashboardChanges(previous, dashboardSnapshot()));
      } else if ((state.page === 'approvals' && (approvalsChanged || jobsChanged)) || (state.page === 'logs' && logsChanged)) {
        render();
      }
    } catch {}
  }
  function projectsPage() {
    const activeId = state.status && state.status.session.activeProjectId;
    const controlAppsInput = state.activationPreset === 'control'
      ? '<input class="input" id="control-apps" style="width:360px" placeholder="Chrome, Roblox Studio, Figma..." value="' + esc(state.controlApps || '') + '">'
      : '';
    return '<div class="page-head"><div><h1>Projects</h1><div class="sub">보통은 ChatGPT 요청에 맞춰 JK가 권한과 실행 위치를 자동으로 선택합니다. Windows 우선 프로젝트만 Executor를 바꾸면 됩니다.</div></div><div class="toolbar"><label class="sub" for="activation-preset">Manual activation</label><select class="select" id="activation-preset" style="width:170px"><option value="read-only" ' + (state.activationPreset==='read-only'?'selected':'') + '>Read Only</option><option value="tests-only" ' + (state.activationPreset==='tests-only'?'selected':'') + '>Tests Only</option><option value="full-write" ' + (state.activationPreset==='full-write'?'selected':'') + '>Full Write</option><option value="image-only" ' + (state.activationPreset==='image-only'?'selected':'') + '>Image Only</option><option value="control" ' + (state.activationPreset==='control'?'selected':'') + '>Computer Control</option></select>' + controlAppsInput + '</div></div><div class="project-list">' + state.projects.map(p =>
      '<div class="project-row"><div><div class="project-name">' + esc(p.name) + ' ' + (p.projectId === activeId ? '<span class="badge active">ACTIVE</span>' : '') + '</div><div class="mono">' + esc(p.root) + '</div><div class="badges" style="margin-top:7px"><span class="badge">' + esc(p.branch || 'no branch') + '</span>' + (p.dirty ? '<span class="badge warn">dirty</span>' : '<span class="badge ok">clean</span>') + (p.executorKind === 'remote' ? '<span class="badge active">' + esc(p.executorId) + '</span>' : '<span class="badge default">OCI</span>') + '</div></div><div class="actions">' + projectExecutorControl(p) + '<button class="btn small" data-view-project="' + esc(p.projectId) + '">Advanced</button><button class="btn small primary" data-activate-project="' + esc(p.projectId) + '">Activate</button></div></div>'
    ).join('') + '</div>' + executorSummaryHtml();
  }
  function rolesPage() {
    const ctx = state.roleContext || {}; const activeId = ctx.role && ctx.role.id; const defaultId = ctx.defaultRoleId;
    return '<div class="page-head"><div><h1>Advanced · Roles</h1><div class="sub">JK는 기본적으로 Role을 자동 선택합니다. 고정 Role로 자동 판단을 덮어쓸 때만 이 화면을 사용하세요.</div></div><div class="toolbar">' + projectSelector() + '<button class="btn" id="import-role">Import</button><button class="btn primary" id="create-role">+ Create Role</button></div></div><div class="role-grid">' + state.roles.map(r =>
      '<div class="role-card ' + (r.id === activeId ? 'active' : '') + '"><div class="role-head"><div><div class="role-name">' + esc(r.name) + '</div><div class="role-desc">' + esc(r.description || '') + '</div></div><span class="badge">' + (r.builtIn ? 'Built-in' : 'Custom') + '</span></div><div class="badges">' + (r.id === activeId ? '<span class="badge active">● Active</span>' : '') + (r.id === defaultId ? '<span class="badge default">★ Default</span>' : '') + '<span class="badge ' + permissionClass(r.permissionPreset) + '">' + esc(permissionLabel(r.permissionPreset)) + '</span>' + ((r.skills || []).slice(0,3).map(s => '<span class="badge">' + esc(s) + '</span>').join('')) + '</div><div class="actions"><button class="btn small primary" data-role-apply="' + esc(r.id) + '">Apply</button><button class="btn small" data-role-default="' + esc(r.id) + '">Set default</button>' + (!r.builtIn ? '<button class="btn small" data-role-export="' + esc(r.id) + '">Export</button><button class="btn small" data-role-edit="' + esc(r.id) + '">Edit</button><button class="btn small danger" data-role-delete="' + esc(r.id) + '">Delete</button>' : '<button class="btn small" data-role-duplicate="' + esc(r.id) + '">Duplicate</button>') + '</div></div>'
    ).join('') + '</div>';
  }
  function skillsPage() {
    const role = state.roleContext && state.roleContext.role;
    return '<div class="page-head"><div><h1>Skills</h1><div class="sub">현재 Role에 주입되는 skill context입니다.</div></div>' + projectSelector() + '</div><div class="panel"><h2 class="section-title">' + esc(role ? role.name : 'Default') + '</h2>' + ((role && role.skills && role.skills.length) ? '<div class="skill-cloud">' + role.skills.map(s => '<span class="skill">' + esc(s) + '</span>').join('') + '</div>' : '<div class="empty">No role-specific skills</div>') + '<dl class="kv" style="margin-top:18px"><dt>Tools</dt><dd>' + esc(role && role.tools ? role.tools.join(' · ') : '—') + '</dd><dt>Workflow</dt><dd>' + esc(role && role.workflowPreference || '—') + '</dd></dl></div>';
  }
  function guidePage() {
    return '<div class="guide-hero">' +
      '<div class="panel guide-hero-copy"><div><span class="badge active">START HERE</span></div><div><h1>JK 시작 가이드</h1><div class="sub">프로젝트를 고르고 → ChatGPT에서 @jk로 요청하면 됩니다. Role·권한·실행 위치는 작업 의도와 연결 상태에 맞춰 선택됩니다.</div></div><div class="badges"><span class="badge ok">OCI Hub + Workers</span><span class="badge">Auto role</span><span class="badge">Least privilege</span></div></div>' +
      '<div class="panel guide-flow"><svg viewBox="0 0 420 210" role="img" aria-label="Project에서 @jk 요청 후 JK가 자동으로 실행 방식을 선택하는 흐름"><defs><marker id="g-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#596270"/></marker></defs><rect x="20" y="70" width="100" height="70" rx="10" fill="#171b21" stroke="#323944"/><path d="M43 91h20l8 8h25v25H43z" fill="none" stroke="#f97316" stroke-width="2"/><text x="70" y="158" text-anchor="middle" fill="#cfd5de" font-size="12">Project</text><line x1="126" y1="105" x2="157" y2="105" stroke="#596270" stroke-width="2" marker-end="url(#g-arrow)"/><rect x="164" y="70" width="92" height="70" rx="10" fill="#171b21" stroke="#323944"/><path d="M180 90h58v27h-29l-13 10v-10h-16z" fill="none" stroke="#60a5fa" stroke-width="2"/><text x="210" y="158" text-anchor="middle" fill="#cfd5de" font-size="12">@jk 요청</text><line x1="262" y1="105" x2="293" y2="105" stroke="#596270" stroke-width="2" marker-end="url(#g-arrow)"/><rect x="300" y="70" width="100" height="70" rx="10" fill="#171b21" stroke="#323944"/><path d="M350 86l20 8v13c0 14-9 24-20 30-11-6-20-16-20-30V94z" fill="none" stroke="#22c55e" stroke-width="2"/><path d="M340 107l7 7 14-17" fill="none" stroke="#22c55e" stroke-width="2"/><text x="350" y="158" text-anchor="middle" fill="#cfd5de" font-size="12">Auto JK</text></svg></div>' +
      '</div>' +
      '<div class="guide-steps"><div class="guide-step"><div class="num">1</div><strong>프로젝트 고르기</strong><p>Projects에서 작업할 코드베이스를 선택합니다. Dashboard의 Active Project와 같은지 확인하세요.</p></div><div class="guide-step"><div class="num">2</div><strong>@jk로 요청</strong><p>“@jk 이 버그 수정해줘”, “QA 해줘”처럼 목적만 자연어로 말하면 됩니다.</p></div><div class="guide-step"><div class="num">3</div><strong>자동 Role · 권한</strong><p>JK가 Builder, Reviewer, QA, Researcher 등을 고르고 필요한 범위로 권한을 낮춥니다.</p></div><div class="guide-step"><div class="num">4</div><strong>필요할 때만 Override</strong><p>고정 Role이 필요하면 Projects의 Manage에서 수동 적용할 수 있으며 이후 자동 선택보다 우선합니다.</p></div></div>' +
      '<div class="grid-2" style="margin-top:12px"><div class="panel"><h2 class="section-title">Role은 JK가 자동으로 고릅니다</h2><div class="guide-role"><span class="badge ok">Builder</span><div><strong>구현 / 디버그</strong><p class="guide-note">파일 변경이 필요한 작업은 Full Write 범위에서 진행합니다.</p></div></div><div class="guide-role"><span class="badge warn">Reviewer</span><div><strong>리뷰 / 분석</strong><p class="guide-note">읽기 중심 작업은 Read Only로 자동 제한합니다.</p></div></div><div class="guide-role"><span class="badge default">QA Engineer</span><div><strong>재현 / 테스트</strong><p class="guide-note">QA 전용 요청은 Tests Only로 실행합니다.</p></div></div></div>' +
      '<div class="panel"><h2 class="section-title">그대로 써도 되는 요청 예시</h2><div class="prompt-list"><div class="prompt">@jk 이 프로젝트 구조 설명해줘</div><div class="prompt">@jk 이 에러 원인 찾아줘</div><div class="prompt">@jk QA 해줘</div><div class="prompt">@jk 이 기능 구현하고 QA까지 해줘</div></div><p class="guide-note" style="margin-top:12px">명령어와 Role을 외울 필요는 없습니다. 목적을 자연어로 말하면 JK가 작업 흐름과 최소 권한을 정합니다.</p></div></div>' +
      '<div class="panel guide-safety" style="margin-top:12px"><svg viewBox="0 0 140 140" role="img" aria-label="안전한 권한 경계"><circle cx="70" cy="70" r="54" fill="#101820" stroke="#26313c" stroke-width="2"/><path d="M70 34l30 12v20c0 23-13 39-30 48-17-9-30-25-30-48V46z" fill="#0d2216" stroke="#22c55e" stroke-width="3"/><path d="M55 69l10 10 21-24" fill="none" stroke="#bbf7d0" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><div><h2 class="section-title">사용자가 신경 쓸 건 승인뿐입니다</h2><p class="guide-note"><strong style="color:#f2f4f7">일반 작업은 JK가 최소 권한으로 자동 진행합니다.</strong> 네트워크 쓰기, 파괴적 명령처럼 확인이 필요한 순간에는 Approvals에 요청이 나타납니다. 특별히 고정 Role이 필요할 때만 Advanced 설정을 사용하면 됩니다.</p></div></div>';
  }
  function goalsPage() { return '<div class="page-head"><div><h1>Goals</h1><div class="sub">goal_loop / work session의 persisted task state를 읽기 전용으로 표시합니다.</div></div><button class="btn" id="refresh-goals">Refresh</button></div><div class="goal-list">' + (state.goals.length ? state.goals.map(goalHtml).join('') : '<div class="empty">No goal history found</div>') + '</div>'; }
  function goalHtml(g) { return '<div class="goal-row"><div class="role-head"><div class="goal-title">' + esc(g.currentGoal || g.currentTask || 'Untitled goal') + '</div>' + (g.active ? '<span class="badge active">ACTIVE</span>' : '') + '</div><div class="goal-meta"><span>' + esc(g.projectName || g.projectId) + '</span><span>' + esc(g.loopId || g.goalId || '—') + '</span><span>' + esc(fmtAge(g.updatedAt)) + '</span></div>' + (g.currentTask ? '<div class="mono">Task: ' + esc(g.currentTask) + '</div>' : '') + (g.pending && g.pending.length ? '<div><div class="sub">Pending</div><ul class="progress-list">' + g.pending.slice(0,6).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '') + (g.completed && g.completed.length ? '<div class="sub">' + esc(g.completed.length) + ' completed item(s)</div>' : '') + '</div>'; }
  function approvalsPage() {
    const rows = state.approvals.length ? state.approvals.map(a => {
      const project = state.projects.find(p => p.projectId === a.projectId);
      const scoped = Boolean(a.scopeLabel);
      const maintenanceScoped = Boolean(a.scopeKey && String(a.scopeKey).startsWith('maintenance:jk:'));
      const readOnlyScoped = scoped && !maintenanceScoped;
      const bundled = Boolean(a.bundleLabel && a.bundlePreviews && a.bundlePreviews.length);
      const bundleCount = bundled ? a.bundlePreviews.length : 0;
      const supervisedEligible = Boolean(a.reason && a.needsNetwork && (!a.destructive || (bundled && a.taskIdentity && a.workSessionId)));
      const risks = (a.needsNetwork ? '<span class="badge warn">Network</span>' : '') + (a.destructive ? '<span class="badge danger">Destructive</span>' : '') + (readOnlyScoped ? '<span class="badge ok">Read-only session</span>' : '') + (maintenanceScoped ? '<span class="badge active">JK maintenance 15m</span>' : '') + (bundled ? '<span class="badge active">Task bundle ' + esc(bundleCount) + '</span>' : '') + (supervisedEligible ? '<span class="badge active">Supervised 15m</span>' : '');
      const riskReason = [a.needsNetwork ? (readOnlyScoped ? '검증된 읽기 전용 외부 조회' : '외부 네트워크 작업') : '', a.destructive ? (maintenanceScoped ? '고정 JK 유지보수' : '파괴적 변경') : ''].filter(Boolean).join(' + ');
      const approvalReason = a.reason || (riskReason ? riskReason + ' 작업은 명시적 로컬 승인이 필요합니다.' : '이 작업은 명시적 로컬 승인이 필요합니다.');
      const grantText = maintenanceScoped
        ? '승인 시 같은 프로젝트·작업 경로의 <strong>JK가 고정한 유지보수 명령</strong>만 최대 ' + esc(Math.round((a.scopeTtlMs || 900000) / 60000)) + '분 동안 재승인 없이 허용합니다. 임의 삭제·reset/force·다른 destructive 명령에는 적용되지 않습니다.'
        : bundled
        ? '승인 시 같은 프로젝트·작업 경로·goal/loop 안에서 아래 <strong>' + esc(bundleCount) + '개 exact 명령+위험 조합</strong>만 최대 ' + esc(Math.round((a.bundleTtlMs || 1800000) / 60000)) + '분 동안 재승인 없이 허용합니다. 목록 밖 명령이나 위험도 변경은 다시 승인합니다.'
        : readOnlyScoped
        ? '승인 시 같은 프로젝트/작업 경로의 <strong>' + esc(a.scopeLabel) + '</strong> 조회를 최대 ' + esc(Math.round((a.scopeTtlMs || 900000) / 60000)) + '분 동안 재승인 없이 허용합니다. 쓰기·권한변경·삭제 명령에는 적용되지 않습니다.'
        : '승인 시 이 exact job을 즉시 실행 · 다른 명령에는 적용되지 않음 · 5분 후 요청 만료';
      const approveLabel = maintenanceScoped ? '15분 JK 유지보수 승인' : bundled ? '묶음 ' + bundleCount + '개만 승인' : readOnlyScoped ? '15분 조회 승인' : '승인하고 실행';
      const superviseButton = supervisedEligible ? '<button class="btn primary" data-approval-decision="supervise" data-approval-id="' + esc(a.id) + '">이 작업 15분 승인 · 권장</button>' : '';
      const supervisedText = supervisedEligible ? '<div class="sub" style="margin-top:8px"><strong>권장:</strong> 이 작업 15분 승인은 같은 goal/workSession의 비파괴 네트워크 후속만 재사용합니다. 파괴적 명령은 위 묶음에 표시된 exact 명령만 허용되고, 새 destructive/고위험 명령은 다시 승인합니다.</div>' : '';
      const bundleCommands = bundled ? '<div class="sub" style="margin-top:10px">승인 묶음</div><div class="mono approval-command">' + a.bundlePreviews.map((x,i) => esc((i + 1) + '. ' + x)).join('\n') + '</div>' : '';
      return '<div class="goal-row approval-card"><div class="role-head"><div><div class="goal-title">' + (maintenanceScoped ? 'JK 유지보수 승인' : bundled ? '작업 묶음 승인' : readOnlyScoped ? '읽기 전용 승인' : '명령 실행 승인') + '</div><div class="goal-meta"><span>' + esc(project ? project.name + ' · ' + a.projectId : a.projectId) + '</span><span>' + risks + '</span><span>' + esc(fmtRemaining(a.expiresAt)) + ' 후 만료</span></div></div><div class="approval-actions">' + superviseButton + '<button class="btn" data-approval-decision="approve" data-approval-id="' + esc(a.id) + '">' + approveLabel + '</button><button class="btn danger" data-approval-decision="deny" data-approval-id="' + esc(a.id) + '">거절</button></div></div>' + executionLocationHtml(approvalTarget(a)) + '<div class="sub" style="margin-top:12px">첫 실행 명령</div><div class="mono approval-command">' + esc(a.commandPreview || '') + '</div>' + bundleCommands + '<div class="sub" style="margin-top:10px">왜 필요한가: ' + esc(approvalReason) + '</div><div class="sub" style="margin-top:8px">요청 ' + esc(fmtAge(a.createdAt)) + ' · ' + grantText + '</div>' + supervisedText + '</div>';
    }).join('') : '<div class="empty">No commands are waiting for approval.</div>';
    const recentJobs = (state.jobs || []).slice(0,8).map(j => {
      const staleRecovered = Boolean(j.interruptedByRestart);
      const statusClass = staleRecovered ? 'default' : j.status === 'succeeded' ? 'ok' : j.status === 'failed' || j.status === 'denied' ? 'danger' : j.status === 'running' ? 'active' : 'default';
      const statusLabel = staleRecovered ? 'stale history' : j.status;
      const displayAt = staleRecovered ? (j.startedAt || j.createdAt) : (j.finishedAt || j.startedAt || j.createdAt);
      const meta = [j.projectId, j.exitCode === undefined ? '' : 'exit ' + j.exitCode, fmtAge(displayAt)].filter(Boolean).join(' · ');
      return '<div class="goal-row"><div class="role-head"><div><div class="goal-title">' + (staleRecovered ? '이전 실행 기록 정리' : 'Approved job') + '</div><div class="goal-meta"><span>' + esc(meta) + '</span></div></div><span class="badge ' + statusClass + '">' + esc(statusLabel) + '</span></div><div class="mono" style="margin-top:8px;white-space:pre-wrap;word-break:break-word">' + esc(j.commandPreview || '') + '</div></div>';
    }).join('');
    return '<div class="page-head"><div><h1>Approvals</h1><div class="sub">멈춰 있는 작업만 확인하면 됩니다. 가능한 작업은 1회만 승인하면 승인한 queued job은 즉시 자동 실행됩니다. 승인 범위는 표시된 exact 명령 묶음·단일 명령·읽기 세션으로 제한됩니다.</div></div><button class="btn" id="refresh-approvals">새로고침</button></div><div class="goal-list">' + rows + '</div>' + (recentJobs ? '<div class="page-head" style="margin-top:20px"><div><h2>최근 승인 작업</h2><div class="sub">승인 후 자동 실행된 작업의 결과입니다.</div></div></div><div class="goal-list">' + recentJobs + '</div>' : '');
  }
  function logsPage() { return '<div class="page-head"><div><h1>Activity</h1><div class="sub">JK가 최근에 수행한 작업과 감사 이벤트를 민감 필드 없이 요약합니다.</div></div><button class="btn" id="refresh-logs">Refresh</button></div>' + logList(state.logs); }
  function logList(logs) { return '<div class="log-list">' + (logs.length ? logs.map(l => '<div class="log-row"><div class="log-type">' + esc(l.type) + '</div><div class="log-detail">' + esc(l.detail || l.projectId || '') + '</div><div class="mono">' + esc(fmtAge(l.ts)) + '</div></div>').join('') : '<div class="empty">No recent audit events</div>') + '</div>'; }
  function systemPage() {
    const s = state.status || {runtime:{}, session:{}};
    const n = state.notifications || {enabled:false,baseUrl:'https://ntfy.sh',topic:'',clickUrl:''};
    const schema = s.runtime.schema || {};
    const schemaMismatch = schema.status === 'mismatch';
    const schemaStatus = schemaMismatch
      ? '<span class="badge danger">Schema mismatch</span>'
      : schema.status === 'ok'
        ? '<span class="badge ok">Schema synced</span>'
        : '<span class="badge warn">Schema unverified</span>';
    const schemaWarning = schemaMismatch
      ? '<div class="panel" style="margin-bottom:12px;border-color:#7f1d1d"><div class="role-head"><div><h2 class="section-title" style="margin:0">Runtime / Tool Schema mismatch</h2><div class="sub" style="margin-top:6px">현재 실행 중인 JK와 최신 source/tool 계약이 다릅니다. Release 명령은 자동 차단되며 runtime upgrade/reload 후 schema 검증이 통과해야 다시 허용됩니다.</div></div><span class="badge danger">RELEASE BLOCKED</span></div>' + ((schema.reasons || []).length ? '<ul class="progress-list" style="margin-top:12px">' + schema.reasons.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') + '<dl class="kv" style="margin-top:12px"><dt>Required goal_loop fields</dt><dd class="mono">safety · executionProfile · fanoutCandidates</dd><dt>Missing</dt><dd class="mono">' + esc((schema.missingGoalLoopInputFields || []).join(' · ') || '—') + '</dd><dt>Tool schema</dt><dd class="mono">' + esc((schema.toolSchemaFingerprint || '').slice(0,16) || '—') + '</dd><dt>Source</dt><dd class="mono">' + esc((schema.sourceFingerprint || '').slice(0,16) || '—') + '</dd><dt>Build</dt><dd class="mono">' + esc((schema.buildFingerprint || '').slice(0,16) || '—') + '</dd></dl></div>'
      : '';
    const adminAccess = isLocalSurface ? '<span class="badge ok">Loopback only</span>' : '<span class="badge ok">Authenticated remote</span> · ' + esc(location.hostname);
    const pushPanel = '<div class="panel" style="margin-top:12px"><div class="role-head"><div><h2 class="section-title">Mobile Push</h2><div class="sub">ChatGPT 알림과 별개로 승인 필요 · 작업 완료 · 작업 실패를 ntfy로 보냅니다. 명령 전체나 secret은 전송하지 않습니다.</div></div><span class="badge ' + (n.enabled ? 'ok' : 'default') + '">' + (n.enabled ? 'ON' : 'OFF') + '</span></div>' + (n.enabled ? '<dl class="kv" style="margin-top:16px"><dt>Server</dt><dd class="mono">' + esc(n.baseUrl) + '</dd><dt>Topic</dt><dd class="mono">' + esc(n.topic) + '</dd><dt>Tap action</dt><dd class="mono">' + esc(n.clickUrl || location.origin) + '</dd></dl><div class="actions" style="margin-top:16px"><button class="btn primary" id="push-test">테스트 푸시</button><button class="btn" id="push-copy-topic">토픽 복사</button><button class="btn danger" id="push-disable">끄기</button></div>' : '<div class="actions" style="margin-top:16px"><button class="btn primary" id="push-enable">푸시 알림 활성화</button></div>') + '</div>';
    return '<div class="page-head"><div><h1>Settings</h1><div class="sub">평소에는 건드릴 필요 없는 런타임 정보와 고급 설정입니다. 토큰과 secret은 표시하지 않습니다.</div></div></div>' + schemaWarning + '<div class="grid-2"><div class="panel"><h2 class="section-title">Runtime</h2><dl class="kv"><dt>Status</dt><dd><span class="badge ok">Online</span> ' + schemaStatus + '</dd><dt>Mode</dt><dd><span class="badge default">' + esc(s.runtime.mode || 'unknown') + '</span></dd><dt>Runtime root</dt><dd class="mono">' + esc(s.runtime.runtimeRoot || '—') + '</dd><dt>PID</dt><dd>' + esc(s.runtime.pid) + '</dd><dt>Node</dt><dd>' + esc(s.runtime.node) + '</dd><dt>Platform</dt><dd>' + esc(s.runtime.platform) + '</dd><dt>Uptime</dt><dd>' + esc(Math.floor(s.runtime.uptimeSec || 0)) + ' sec</dd><dt>Workspace</dt><dd class="mono">' + esc(s.runtime.workspaceRoot) + '</dd></dl></div><div class="panel"><h2 class="section-title">Advanced</h2><div class="sub">자동 판단을 특별히 조정하거나 내부 상태를 확인할 때만 사용하세요.</div><div class="advanced-links"><button class="btn" data-nav-page="guide">JK 사용법</button><button class="btn" data-nav-page="roles">Role overrides</button><button class="btn" data-nav-page="skills">Role skills</button><button class="btn" data-nav-page="goals">실행 기록</button></div><dl class="kv" style="margin-top:18px"><dt>Control Center</dt><dd>' + esc(location.origin + '/') + '</dd><dt>MCP</dt><dd>/mcp</dd><dt>Health</dt><dd>/healthz</dd><dt>Admin access</dt><dd>' + adminAccess + '</dd><dt>Lease expires</dt><dd>' + esc(fmtTime(s.session.leaseExpiresAt)) + '</dd></dl></div></div>' + deploymentStatusHtml() + deploymentActionHtml() + pushPanel;
  }
  function render() {
    const pages = {dashboard, projects: projectsPage, roles: rolesPage, skills: skillsPage, guide: guidePage, goals: goalsPage, approvals: approvalsPage, logs: logsPage, system: systemPage};
    const focused = content.contains(document.activeElement) ? document.activeElement : null;
    const focusAttributes = focused ? [...focused.attributes].filter(a => a.name === 'id' || a.name.startsWith('data-')).map(a => '[' + a.name + '="' + CSS.escape(a.value) + '"]').join('') : '';
    const opened = [...content.querySelectorAll('details[open][id]')].map(el => el.id);
    content.innerHTML = (pages[state.page] || dashboard)();
    for (const id of opened) { const detail = document.getElementById(id); if (detail) detail.open = true; }
    bindPage(); updateChrome();
    if (focusAttributes) { const next = content.querySelector(focused.tagName + focusAttributes); if (next) next.focus({preventScroll:true}); }
  }
  async function selectContext(projectId) { state.selectedProjectId = projectId; await loadProjectContext(projectId); updateChrome(); render(); }
  async function activateProject(projectId) { const preset = state.activationPreset || 'read-only'; const controlApps = (state.controlApps || '').split(',').map(v => v.trim()).filter(Boolean); await api('/api/jk/control/projects/' + encodeURIComponent(projectId) + '/activate', {method:'POST', body: JSON.stringify({ preset, ...(preset === 'control' ? { controlApps } : {}) })}); state.selectedProjectId = projectId; await loadAll({quiet:true}); toast(preset === 'control' ? 'Computer Control armed' : 'Active project changed'); }
  async function applyRole(roleId) { await api('/api/jk/projects/' + encodeURIComponent(state.selectedProjectId) + '/role', {method:'POST', body:JSON.stringify({roleId})}); await loadProjectContext(state.selectedProjectId); render(); toast('Role applied'); }
  async function setDefault(roleId) { await api('/api/jk/projects/' + encodeURIComponent(state.selectedProjectId) + '/default-role', {method:'POST', body:JSON.stringify({roleId})}); await loadProjectContext(state.selectedProjectId); render(); toast('Project default updated'); }
  async function deleteRole(roleId) { if (!confirm('Delete this custom Role?')) return; await api('/api/jk/roles/' + encodeURIComponent(roleId), {method:'DELETE'}); await loadProjectContext(state.selectedProjectId); render(); toast('Role deleted'); }
  async function exportRole(roleId) { const response = await api('/api/jk/roles/export'); const role = (response.bundle && response.bundle.roles || []).find(r => r.id === roleId); if (!role) throw new Error('Only custom Roles can be exported'); const bundle = { ...response.bundle, roles: [role] }; const blob = new Blob([JSON.stringify(bundle, null, 2)], {type:'application/json'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (role.name || 'jk-role').replace(/[^a-z0-9_-]+/gi,'-') + '.json'; a.click(); URL.revokeObjectURL(a.href); }
  function openRoleEditor(role, duplicate=false) {
    state.editingRole = role && !duplicate ? role : null;
    document.getElementById('role-dialog-title').textContent = role ? (duplicate ? 'Duplicate Role' : 'Edit Role') : 'Create Role';
    document.getElementById('role-name').value = role ? (duplicate ? role.name + ' Copy' : role.name) : '';
    document.getElementById('role-description').value = role && role.description || '';
    document.getElementById('role-instructions').value = role && role.instructions || '';
    document.getElementById('role-permission').value = role && role.permissionPreset || 'read-only';
    document.getElementById('role-workflow').value = role && role.workflowPreference || '';
    document.getElementById('role-skills').value = role && role.skills ? role.skills.join(', ') : '';
    const toolRoot = document.getElementById('role-tools'); toolRoot.innerHTML = '';
    tools.forEach(t => { const label = document.createElement('label'); label.className='check'; const input=document.createElement('input'); input.type='checkbox'; input.value=t; input.checked = role ? (role.tools || []).includes(t) : ['code_search','file_read'].includes(t); label.append(input, document.createTextNode(t)); toolRoot.appendChild(label); });
    const preset = document.getElementById('workflow-preset'); preset.innerHTML = '<option value="">Custom</option>' + state.workflowPresets.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
    document.getElementById('role-dialog').showModal();
  }
  async function saveRole() {
    const body = { name: document.getElementById('role-name').value.trim(), description: document.getElementById('role-description').value.trim(), instructions: document.getElementById('role-instructions').value.trim(), permissionPreset: document.getElementById('role-permission').value, workflowPreference: document.getElementById('role-workflow').value.trim(), tools:[...document.querySelectorAll('#role-tools input:checked')].map(x=>x.value), skills: document.getElementById('role-skills').value.split(',').map(x=>x.trim()).filter(Boolean) };
    if (!body.name) return toast('Role name is required');
    if (state.editingRole) await api('/api/jk/roles/' + encodeURIComponent(state.editingRole.id), {method:'PUT', body:JSON.stringify(body)}); else await api('/api/jk/roles', {method:'POST', body:JSON.stringify(body)});
    document.getElementById('role-dialog').close(); await loadProjectContext(state.selectedProjectId); render(); toast('Role saved');
  }
  async function enablePush() { const r=await api('/api/jk/control/notifications',{method:'POST',body:JSON.stringify({enabled:true,clickUrl:location.origin})}); state.notifications=r.notifications; render(); toast('푸시 알림 활성화됨'); }
  async function disablePush() { const r=await api('/api/jk/control/notifications',{method:'POST',body:JSON.stringify({enabled:false})}); state.notifications=r.notifications; render(); toast('푸시 알림 꺼짐'); }
  async function testPush() { const r=await api('/api/jk/control/notifications/test',{method:'POST',body:'{}'}); toast(r.delivered ? '테스트 푸시 전송됨' : '푸시 전송 실패'); }
  async function copyPushTopic() { const topic=state.notifications && state.notifications.topic; if (!topic) return; try { await navigator.clipboard.writeText(topic); toast('토픽 복사됨'); } catch { window.prompt('ntfy에서 이 토픽을 구독하세요.',topic); } }
  async function requestDeploymentSync() {
    const r = await api('/api/jk/control/deployment/sync', {method:'POST', body:'{}'});
    await loadAll({quiet:true});
    if (r.status === 'running') { toast('JK runtime 동기화가 이미 실행 중입니다.'); return; }
    navigate('approvals');
    toast(r.reused ? '기존 승인 요청을 그대로 사용합니다.' : '승인 1회 후 동기화 · 재시작이 자동 실행됩니다.');
  }
  function bindPage() {
    document.querySelectorAll('[data-nav-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.navPage)));
    const ps = document.getElementById('project-context-select'); if (ps) ps.addEventListener('change', e => selectContext(e.target.value));
    const activation = document.getElementById('activation-preset'); if (activation) activation.addEventListener('change', e => { state.activationPreset = e.target.value; render(); });
    const controlApps = document.getElementById('control-apps'); if (controlApps) controlApps.addEventListener('input', e => { state.controlApps = e.target.value; });
    document.querySelectorAll('[data-view-project]').forEach(b => b.addEventListener('click', () => { state.page='roles'; selectContext(b.dataset.viewProject); }));
    document.querySelectorAll('[data-activate-project]').forEach(b => b.addEventListener('click', () => activateProject(b.dataset.activateProject).catch(e=>toast(e.message))));
    document.querySelectorAll('[data-executor-route-project]').forEach(s => s.addEventListener('change', async () => { try { await api('/api/jk/control/executors/routes', {method:'POST', body:JSON.stringify({projectId:s.dataset.executorRouteProject, executorId:s.value})}); await loadAll({quiet:true}); toast('Executor route updated'); } catch(e) { toast(e.message); } }));
    const pairExecutor = document.getElementById('pair-windows-executor'); if (pairExecutor) pairExecutor.addEventListener('click', () => pairWindowsExecutor().catch(e=>toast(e.message)));
    document.querySelectorAll('[data-role-apply]').forEach(b => b.addEventListener('click', () => applyRole(b.dataset.roleApply).catch(e=>toast(e.message))));
    document.querySelectorAll('[data-role-default]').forEach(b => b.addEventListener('click', () => setDefault(b.dataset.roleDefault).catch(e=>toast(e.message))));
    document.querySelectorAll('[data-role-delete]').forEach(b => b.addEventListener('click', () => deleteRole(b.dataset.roleDelete).catch(e=>toast(e.message))));
    document.querySelectorAll('[data-role-export]').forEach(b => b.addEventListener('click', () => exportRole(b.dataset.roleExport).catch(e=>toast(e.message))));
    document.querySelectorAll('[data-role-edit]').forEach(b => b.addEventListener('click', () => openRoleEditor(state.roles.find(r=>r.id===b.dataset.roleEdit))));
    document.querySelectorAll('[data-role-duplicate]').forEach(b => b.addEventListener('click', () => openRoleEditor(state.roles.find(r=>r.id===b.dataset.roleDuplicate), true)));
    const create = document.getElementById('create-role'); if (create) create.addEventListener('click', () => openRoleEditor(null));
    const imp = document.getElementById('import-role'); if (imp) imp.addEventListener('click', () => document.getElementById('import-role-file').click());
    const rg = document.getElementById('refresh-goals'); if (rg) rg.addEventListener('click', () => loadAll());
    const ra = document.getElementById('refresh-approvals'); if (ra) ra.addEventListener('click', () => loadAll());
    const rl = document.getElementById('refresh-logs'); if (rl) rl.addEventListener('click', () => loadAll());
    const oa = document.getElementById('open-approvals'); if (oa) oa.addEventListener('click', () => navigate('approvals'));
    const pe = document.getElementById('push-enable'); if (pe) pe.addEventListener('click', () => enablePush().catch(e=>toast(e.message)));
    const pd = document.getElementById('push-disable'); if (pd) pd.addEventListener('click', () => disablePush().catch(e=>toast(e.message)));
    const pt = document.getElementById('push-test'); if (pt) pt.addEventListener('click', () => testPush().catch(e=>toast(e.message)));
    const pc = document.getElementById('push-copy-topic'); if (pc) pc.addEventListener('click', () => copyPushTopic().catch(e=>toast(e.message)));
    const syncRuntime = document.getElementById('sync-jk-runtime'); if (syncRuntime) syncRuntime.addEventListener('click', () => requestDeploymentSync().catch(e=>toast(e.message)));
    const runtimeApprovals = document.getElementById('open-runtime-approvals'); if (runtimeApprovals) runtimeApprovals.addEventListener('click', () => navigate('approvals'));
    document.querySelectorAll('[data-approval-decision]').forEach(b => {
      b.disabled = pendingDecisions.has(b.dataset.approvalId);
      if (b.disabled) { b.setAttribute('aria-busy','true'); b.textContent = '처리 중…'; }
      b.addEventListener('click', async () => {
        const id = b.dataset.approvalId;
        if (pendingDecisions.has(id)) return;
        const approval = state.approvals.find(a => a.id === id);
        const decision = b.dataset.approvalDecision;
        pendingDecisions.add(id);
        document.querySelectorAll('[data-approval-decision]').forEach(button => { if (button.dataset.approvalId === id) { button.disabled = true; button.setAttribute('aria-busy','true'); } });
        b.textContent = '처리 중…';
        try {
          await api('/api/jk/control/approvals/' + encodeURIComponent(id), {method:'POST', body:JSON.stringify({decision})});
          await loadAll({quiet:true});
          toast(decision === 'supervise' ? '승인됨 · 요청한 작업을 자동 실행합니다.' : decision === 'approve' ? (approval && approval.scopeLabel ? '조회 승인됨 · 요청한 조회를 자동 실행합니다.' : '승인됨 · 이 명령을 자동 실행합니다.') : 'Approval denied.');
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error));
        } finally {
          pendingDecisions.delete(id);
          if (state.page === 'approvals') render();
        }
      });
    });
  }
  function navigate(page) { if (!allowedPages.includes(page)) return; state.page=page; history.replaceState(null, '', page === 'dashboard' ? '/' : page === 'approvals' ? '/approvals' : '/?page=' + encodeURIComponent(page)); render(); }
  document.getElementById('project-nav').addEventListener('click', e => { const b=e.target.closest('[data-project-context]'); if (!b) return; navigate('projects'); selectContext(b.dataset.projectContext).catch(err => toast(err.message)); });
  nav.addEventListener('click', e => { const b=e.target.closest('button[data-page]'); if (!b) return; navigate(b.dataset.page); });
  primaryPages.forEach(p => { const b=document.createElement('button'); b.className='btn small'; b.dataset.page=p; b.textContent=pageLabels[p] || p; b.addEventListener('click',()=>navigate(p)); mobileNav.appendChild(b); });
  document.getElementById('refresh-all').addEventListener('click', () => loadAll());
  document.getElementById('top-approvals').addEventListener('click', () => navigate('approvals'));
  document.querySelectorAll('[data-close-dialog]').forEach(b => b.addEventListener('click', () => document.getElementById('role-dialog').close()));
  document.getElementById('save-role').addEventListener('click', () => saveRole().catch(e=>toast(e.message)));
  document.getElementById('workflow-preset').addEventListener('change', e => { const p=state.workflowPresets.find(x=>x.id===e.target.value); if (p) document.getElementById('role-workflow').value=p.preference; });
  document.getElementById('import-role-file').addEventListener('change', async e => { const file=e.target.files && e.target.files[0]; if (!file) return; try { const bundle=JSON.parse(await file.text()); await api('/api/jk/roles/import',{method:'POST',body:JSON.stringify(bundle)}); await loadProjectContext(state.selectedProjectId); render(); toast('Role imported'); } catch(err){ toast(err.message); } finally { e.target.value=''; } });
  loadAll({quiet:true});
  setInterval(tickRuntimeClock,1000);
  setInterval(refreshExecution,1500);
  setInterval(refreshSignals,2500);
  setInterval(() => loadAll({quiet:true}), 15000);
})();
</script>
</body>
</html>`;
