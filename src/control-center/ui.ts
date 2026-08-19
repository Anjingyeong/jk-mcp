export const CONTROL_CENTER_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23111419'/%3E%3Ctext x='16' y='21' text-anchor='middle' font-size='13' font-family='Arial' font-weight='700' fill='%23f97316'%3EJK%3C/text%3E%3C/svg%3E" />
  <title>JK Control Center</title>
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #111419;
      --panel-2: #171b21;
      --line: #262c35;
      --text: #f2f4f7;
      --muted: #8d96a5;
      --accent: #f97316;
      --accent-soft: #2a1a10;
      --ok: #22c55e;
      --warn: #eab308;
      --danger: #ef4444;
      --info: #60a5fa;
      --sidebar: 224px;
      --radius: 10px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
    body { min-height: 100vh; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .app { min-height: 100vh; display: grid; grid-template-columns: var(--sidebar) 1fr; }
    .sidebar { position: sticky; top: 0; height: 100vh; border-right: 1px solid var(--line); background: linear-gradient(180deg, #101318 0%, #0d1014 100%); padding: 20px 14px; display: flex; flex-direction: column; gap: 18px; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 8px; }
    .brand-mark { width: 34px; height: 34px; border: 1px solid #3b414b; display: grid; place-items: center; font-weight: 800; letter-spacing: -1px; background: #15191f; }
    .brand strong { display: block; font-size: 15px; letter-spacing: .02em; }
    .brand span { color: var(--muted); font-size: 11px; }
    .nav { display: grid; gap: 4px; }
    .nav button { width: 100%; border: 0; background: transparent; color: var(--muted); text-align: left; padding: 10px 11px; border-radius: 7px; display: flex; align-items: center; gap: 10px; }
    .nav button:hover { background: #15191f; color: var(--text); }
    .nav button.active { background: var(--panel-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
    .nav .dot { width: 7px; height: 7px; border-radius: 50%; background: #555f6d; }
    .nav button.active .dot { background: var(--accent); }
    .sidebar-foot { margin-top: auto; border-top: 1px solid var(--line); padding: 14px 8px 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .online { color: var(--ok); }
    .main { min-width: 0; }
    .topbar { height: 64px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; padding: 0 26px; position: sticky; top: 0; background: rgba(11,13,16,.92); backdrop-filter: blur(14px); z-index: 10; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
    .crumb { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 auto; }
    .crumb strong { font-size: 14px; }
    .project-pill { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .top-actions { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 0 0 auto; }
    .status-chip { border: 1px solid var(--line); color: var(--muted); padding: 6px 9px; border-radius: 999px; font-size: 11px; }
    .status-chip strong { color: var(--text); }
    .content { padding: 30px; max-width: 1280px; margin: 0 auto; }
    .page-head { display: flex; justify-content: space-between; gap: 18px; align-items: flex-end; margin-bottom: 22px; }
    h1 { margin: 0; font-size: 24px; letter-spacing: -.02em; }
    .sub { margin-top: 6px; color: var(--muted); font-size: 13px; }
    .btn { border: 1px solid var(--line); background: #15191f; color: var(--text); padding: 8px 11px; border-radius: 8px; font-size: 12px; transition: background .16s ease, border-color .16s ease, transform .16s ease; }
    .btn:hover { border-color: #3b4450; background: #1a1f26; }
    .btn:active { transform: translateY(1px); }
    .btn:focus-visible, .nav button:focus-visible, .mobile-head button:focus-visible { outline: 2px solid rgba(249,115,22,.75); outline-offset: 2px; }
    .btn.primary { background: var(--accent); color: #130b05; border-color: var(--accent); font-weight: 700; }
    .btn.danger { color: #fecaca; border-color: #4b2025; background: #211114; }
    .btn.ghost { background: transparent; }
    .btn.small { padding: 6px 8px; font-size: 11px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }
    .metric, .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
    .metric { position: relative; overflow: hidden; padding: 16px; min-height: 112px; display: flex; flex-direction: column; justify-content: space-between; transition: border-color .2s ease, background .2s ease, transform .2s ease; }
    .metric::after { content: ""; position: absolute; left: -45%; bottom: 0; width: 38%; height: 1px; background: linear-gradient(90deg, transparent, rgba(249,115,22,.7), transparent); opacity: 0; }
    .metric[data-metric-key="runtime"]::after { opacity: .65; animation: metric-scan 3.6s linear infinite; }
    .metric.changed { animation: metric-change .48s ease-out; border-color: #6a3b20; }
    .metric .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .metric .value { font-size: 21px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .metric .meta { color: var(--muted); font-size: 11px; }
    @keyframes metric-scan { from { left: -45%; } to { left: 110%; } }
    @keyframes metric-change { 0% { transform: translateY(0); background: var(--panel); } 35% { transform: translateY(-2px); background: #191711; } 100% { transform: translateY(0); background: var(--panel); } }
    .panel { padding: 16px; }
    .section-title { margin: 0 0 14px; font-size: 13px; color: #d7dce3; }
    .split { display: grid; grid-template-columns: minmax(0,1.35fr) minmax(280px,.65fr); gap: 12px; margin-top: 12px; }
    .role-card, .project-row, .log-row, .goal-row { border: 1px solid var(--line); background: #12161b; border-radius: 8px; }
    .role-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
    .role-card { padding: 14px; display: grid; gap: 11px; }
    .role-card.active { border-color: #6a3b20; box-shadow: inset 0 0 0 1px #6a3b20; }
    .role-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .role-name { font-weight: 700; font-size: 14px; }
    .role-desc { color: var(--muted); font-size: 12px; min-height: 34px; }
    .badges { display: flex; flex-wrap: wrap; gap: 5px; }
    .badge { border: 1px solid var(--line); border-radius: 999px; padding: 3px 7px; color: var(--muted); font-size: 10px; }
    .badge.active { color: #fed7aa; border-color: #854d0e; background: #25170c; }
    .badge.default { color: #bfdbfe; border-color: #1e3a5f; background: #0d1b2b; }
    .badge.ok { color: #bbf7d0; border-color: #14532d; background: #0d2216; }
    .badge.warn { color: #fef08a; border-color: #713f12; background: #251b09; }
    .badge.danger { color: #fecaca; border-color: #7f1d1d; background: #281010; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .project-list, .goal-list, .log-list { display: grid; gap: 8px; }
    .project-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 14px; align-items: center; padding: 13px 14px; }
    .project-name { font-weight: 650; font-size: 13px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; color: var(--muted); word-break: break-all; }
    .goal-row { padding: 14px; display: grid; gap: 9px; }
    .goal-title { font-size: 13px; font-weight: 650; }
    .goal-meta { display: flex; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: 11px; }
    .progress-list { margin: 0; padding-left: 18px; color: #cdd3dc; font-size: 12px; display: grid; gap: 5px; }
    .log-row { padding: 10px 12px; display: grid; grid-template-columns: 130px minmax(0,1fr) auto; gap: 12px; align-items: center; }
    .log-type { font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; color: #d4d9e1; }
    .log-detail { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { border: 1px dashed var(--line); border-radius: 8px; padding: 30px; text-align: center; color: var(--muted); font-size: 12px; }
    .kv { display: grid; grid-template-columns: 150px minmax(0,1fr); gap: 8px 14px; font-size: 12px; }
    .kv dt { color: var(--muted); }
    .kv dd { margin: 0; word-break: break-word; }
    .skill-cloud { display: flex; flex-wrap: wrap; gap: 7px; }
    .skill { border: 1px solid var(--line); background: #14181e; padding: 7px 9px; border-radius: 7px; font-size: 12px; }
    .guide-hero { display: grid; grid-template-columns: minmax(0,1.25fr) minmax(280px,.75fr); gap: 12px; align-items: stretch; }
    .guide-hero-copy { display: grid; align-content: center; gap: 12px; min-height: 220px; }
    .guide-hero-copy h1 { font-size: 28px; }
    .guide-flow { min-height: 220px; display: grid; place-items: center; overflow: hidden; }
    .guide-flow svg { width: min(100%, 420px); height: auto; }
    .guide-steps { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; margin-top: 12px; }
    .guide-step { border: 1px solid var(--line); background: #12161b; border-radius: 8px; padding: 14px; min-height: 132px; }
    .guide-step .num { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; background: var(--accent-soft); color: #fdba74; font-size: 11px; font-weight: 800; margin-bottom: 12px; }
    .guide-step strong { display: block; font-size: 13px; margin-bottom: 7px; }
    .guide-step p, .guide-note { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
    .guide-role { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 12px; align-items: start; padding: 10px 0; border-top: 1px solid var(--line); }
    .guide-role:first-of-type { border-top: 0; padding-top: 0; }
    .prompt-list { display: grid; gap: 7px; }
    .prompt { border: 1px solid var(--line); background: #0f1216; border-radius: 7px; padding: 10px 12px; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: #d9dee6; }
    .guide-safety { display: grid; grid-template-columns: 150px minmax(0,1fr); gap: 18px; align-items: center; }
    .guide-safety svg { width: 130px; height: 130px; margin: 0 auto; }
    .workflow-panel { margin-top: 12px; overflow: hidden; }
    .workflow-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
    .workflow-head .sub { margin-top: 4px; }
    .workflow-strip { position: relative; display: grid; grid-template-columns: repeat(7, minmax(0,1fr)); gap: 0; padding: 7px 0 2px; }
    .workflow-strip::before { content: ""; position: absolute; left: 6%; right: 6%; top: 22px; height: 1px; background: #2c323b; }
    .workflow-step { position: relative; z-index: 1; display: grid; justify-items: center; gap: 7px; min-width: 0; color: #697382; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
    .workflow-dot { width: 11px; height: 11px; border-radius: 50%; border: 2px solid #3b434e; background: #111419; transition: .25s ease; }
    .workflow-step.done { color: #9ba5b3; }
    .workflow-step.done .workflow-dot { border-color: #596574; background: #20262e; }
    .workflow-step.active { color: #fdba74; font-weight: 800; }
    .workflow-step.active .workflow-dot { border-color: var(--accent); background: var(--accent); box-shadow: 0 0 0 0 rgba(249,115,22,.42); animation: workflow-pulse 1.45s ease-out infinite; }
    .workflow-step.active::after { content: ""; position: absolute; top: 21px; left: 50%; width: 70%; height: 2px; transform: translateX(-50%); background: linear-gradient(90deg, transparent, rgba(249,115,22,.72), transparent); animation: workflow-flow 1.15s ease-in-out infinite alternate; }
    .workflow-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .workflow-meta { margin-top: 10px; display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 10px; }
    @keyframes workflow-pulse { 65% { box-shadow: 0 0 0 7px rgba(249,115,22,0); } 100% { box-shadow: 0 0 0 0 rgba(249,115,22,0); } }
    @keyframes workflow-flow { from { opacity: .25; transform: translateX(-50%) scaleX(.45); } to { opacity: 1; transform: translateX(-50%) scaleX(1); } }
    .log-row.fresh, .goal-row.fresh { animation: row-arrive .42s ease-out; }
    @keyframes row-arrive { from { opacity: .35; transform: translateY(-5px); border-color: #6a3b20; } to { opacity: 1; transform: translateY(0); border-color: var(--line); } }
    .attention { animation: attention-in .55s ease-out; }
    @keyframes attention-in { 0% { transform: scale(.992); box-shadow: 0 0 0 rgba(249,115,22,0); } 45% { transform: scale(1); box-shadow: 0 0 0 3px rgba(249,115,22,.08); } 100% { box-shadow: 0 0 0 rgba(249,115,22,0); } }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .select, .input, .textarea { width: 100%; background: #0f1216; border: 1px solid var(--line); color: var(--text); border-radius: 7px; padding: 9px 10px; outline: none; }
    .textarea { min-height: 110px; resize: vertical; }
    .select:focus, .input:focus, .textarea:focus { border-color: #6a3b20; box-shadow: 0 0 0 2px rgba(249,115,22,.12); }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .field { display: grid; gap: 6px; }
    .field.full { grid-column: 1 / -1; }
    .field label { color: var(--muted); font-size: 11px; }
    .check-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; }
    .check { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 7px; padding: 8px; font-size: 11px; color: #d5dae2; }
    dialog { width: min(720px, calc(100vw - 32px)); border: 1px solid var(--line); background: #101318; color: var(--text); border-radius: 12px; padding: 0; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
    dialog::backdrop { background: rgba(0,0,0,.72); }
    .dialog-head { padding: 16px 18px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
    .dialog-body { padding: 18px; }
    .dialog-foot { padding: 14px 18px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 8px; }
    .toast { position: fixed; right: 18px; bottom: 18px; z-index: 50; border: 1px solid var(--line); background: #15191f; color: var(--text); padding: 10px 12px; border-radius: 8px; font-size: 12px; opacity: 0; transform: translateY(8px); pointer-events: none; transition: .18s ease; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .hidden { display: none !important; }
    .mobile-head { display: none; }
    .dashboard-hero { display: flex; align-items: center; justify-content: space-between; gap: 28px; margin-bottom: 14px; padding: 24px; border-color: #493426; background: radial-gradient(circle at 88% 18%, rgba(249,115,22,.13), transparent 34%), linear-gradient(135deg, #15191f, #101318); }
    .dashboard-hero-copy { min-width: 0; }
    .dashboard-eyebrow { color: #fdba74; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .dashboard-task { margin-top: 8px; font-size: clamp(20px, 3vw, 28px); font-weight: 750; letter-spacing: -.025em; line-height: 1.25; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
    .dashboard-hero-status { display: grid; justify-items: end; gap: 8px; min-width: 170px; }
    .dashboard-hero-status strong { font-size: 15px; }
    .run-summary { display: grid; gap: 10px; }
    .run-summary-title { font-size: 15px; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
    .run-summary-note { color: var(--muted); font-size: 12px; line-height: 1.6; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
    .advanced-links { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
    .quick-links-panel { margin-top: 12px; }
    .quick-links-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .quick-links { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px; }
    .quick-link { min-width: 0; min-height: 78px; display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: #12161b; color: var(--text); text-decoration: none; transition: background .16s ease, border-color .16s ease, transform .16s ease; }
    .quick-link:hover { background: #171c22; border-color: #3b4450; }
    .quick-link:active { transform: translateY(1px); }
    .quick-link-copy { min-width: 0; }
    .quick-link-title { font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quick-link-note { margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
    .quick-link-arrow { color: #7f8998; font-size: 14px; }
    .surface-row { display: flex; align-items: center; gap: 7px; color: var(--muted); }
    .surface-row strong { color: #d7dce3; font-weight: 650; }
    .approval-card { border-color: #744016; background: linear-gradient(135deg, #17130f, #13110f); }
    .approval-command { margin-top: 8px; padding: 11px 12px; border-radius: 8px; border: 1px solid #302922; background: #0d0f12; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
    .approval-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    @media (max-width: 980px) {
      .grid-4 { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .role-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .guide-steps { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .quick-links { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .split { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .app { display: block; }
      .sidebar { display: none; }
      .topbar { height: auto; min-height: 58px; padding: 10px 14px; gap: 8px; }
      .mobile-head { position: sticky; top: 58px; z-index: 9; display: flex; gap: 6px; overflow-x: auto; padding: 8px 12px; border-bottom: 1px solid var(--line); background: rgba(14,17,21,.96); backdrop-filter: blur(12px); scrollbar-width: none; }
      .mobile-head::-webkit-scrollbar { display: none; }
      .mobile-head button { white-space: nowrap; min-height: 40px; }
      .content { padding: 18px 14px 28px; }
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
      #top-role { display: none; }
      .topbar .btn { min-height: 40px; }
      .dashboard-hero { align-items: flex-start; flex-direction: column; }
      .dashboard-hero-status { justify-items: start; min-width: 0; }
      .quick-links-head { align-items: flex-start; flex-direction: column; }
      .approval-card .role-head { flex-direction: column; align-items: stretch; }
      .approval-actions { justify-content: flex-start; width: 100%; }
      .approval-actions .btn { flex: 1 1 132px; min-height: 40px; }
      .workflow-strip { grid-template-columns: repeat(4, minmax(0,1fr)); row-gap: 14px; }
      .workflow-strip::before, .workflow-step.active::after { display: none; }
    }
    @media (max-width: 480px) {
      .topbar { padding-left: 10px; padding-right: 10px; }
      .project-pill, #top-health { display: none; }
      .top-actions { gap: 6px; }
      #top-approvals { max-width: 116px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .content { padding-left: 10px; padding-right: 10px; }
      .panel, .metric { border-radius: 10px; }
      .dashboard-hero { padding: 18px; }
      .check-grid { grid-template-columns: 1fr; }
      .kv { grid-template-columns: 108px minmax(0,1fr); gap: 8px 10px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="brand-mark">JK</div><div><strong>Control Center</strong><span id="brand-runtime">Runtime surface</span></div></div>
    <nav class="nav" id="nav">
      <button data-page="dashboard" class="active"><span class="dot"></span>Dashboard</button>
      <button data-page="projects"><span class="dot"></span>Projects</button>
      <button data-page="approvals"><span class="dot"></span>Approvals</button>
      <button data-page="logs"><span class="dot"></span>Activity</button>
      <button data-page="system"><span class="dot"></span>Settings</button>
    </nav>
    <div class="sidebar-foot"><div class="surface-row" id="sidebar-surface"><span class="online">●</span><strong>Connecting…</strong></div><div id="sidebar-runtime">Runtime checking…</div></div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div class="crumb"><strong id="top-title">Dashboard</strong><span class="project-pill" id="top-project">—</span></div>
      <div class="top-actions"><button class="btn small hidden" id="top-approvals" title="Open pending approvals"></button><span class="status-chip" id="top-role">Auto <strong>Ready</strong></span><span class="status-chip" id="top-health"><span class="online">●</span> Online</span><button class="btn small" id="refresh-all">Refresh</button></div>
    </header>
    <div class="mobile-head" id="mobile-nav"></div>
    <section class="content" id="content"></section>
  </main>
</div>
<dialog id="role-dialog">
  <div class="dialog-head"><strong id="role-dialog-title">Create Role</strong><button class="btn small ghost" data-close-dialog>Close</button></div>
  <div class="dialog-body">
    <div class="form-grid">
      <div class="field"><label>Name</label><input class="input" id="role-name" maxlength="100" /></div>
      <div class="field"><label>Permission</label><select class="select" id="role-permission"><option value="inherit">Project Default</option><option value="read-only">Read Only</option><option value="tests-only">Tests Only</option><option value="full-write">Full Write</option><option value="image-only">Image Only</option></select></div>
      <div class="field full"><label>Description</label><input class="input" id="role-description" maxlength="500" /></div>
      <div class="field full"><label>Instructions</label><textarea class="textarea" id="role-instructions"></textarea></div>
      <div class="field full"><label>Workflow preset</label><select class="select" id="workflow-preset"><option value="">Custom</option></select></div>
      <div class="field full"><label>Workflow preference</label><textarea class="textarea" id="role-workflow"></textarea></div>
      <div class="field full"><label>Tools</label><div class="check-grid" id="role-tools"></div></div>
      <div class="field full"><label>Skills (comma separated)</label><input class="input" id="role-skills" /></div>
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
  const state = { page: allowedPages.includes(requestedPage) ? requestedPage : 'dashboard', projects: [], roles: [], roleContext: null, status: null, execution: null, goals: [], approvals: [], jobs: [], logs: [], notifications: null, selectedProjectId: null, editingRole: null, workflowPresets: [], activationPreset: null, runtimeSampleAt: 0, reconnectTimer: null };
  const content = document.getElementById('content');
  const nav = document.getElementById('nav');
  const mobileNav = document.getElementById('mobile-nav');
  const toastEl = document.getElementById('toast');
  const tools = ['code_search','file_read','tests','file_write','git','browser'];
  const workflowPhases = ['discover','plan','patch','verify','review','recovery','release'];
  const localHostnames = new Set(['localhost','127.0.0.1','::1']);
  const isLocalSurface = localHostnames.has(location.hostname) || location.hostname.endsWith('.localhost');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';
  const fmtAge = (ms) => { if (!ms) return '—'; const d = Math.max(0, Date.now() - ms); if (d < 60000) return Math.floor(d/1000) + 's ago'; if (d < 3600000) return Math.floor(d/60000) + 'm ago'; if (d < 86400000) return Math.floor(d/3600000) + 'h ago'; return Math.floor(d/86400000) + 'd ago'; };
  const fmtRemaining = (ms) => { if (!ms) return '—'; const d = Math.max(0, ms - Date.now()); if (d < 60000) return Math.ceil(d/1000) + 's'; return Math.ceil(d/60000) + 'm'; };
  const permissionLabel = (p) => ({'full-write':'Full Write','read-only':'Read Only','tests-only':'Tests Only','image-only':'Image Only','inherit':'Project Default'})[p] || (p || '—');
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
  async function loadAll({quiet=false}={}) {
    try {
      const previousDashboard = dashboardSnapshot();
      const [projects, status, execution, goals, approvals, logs, notifications] = await Promise.all([
        api('/api/jk/projects'), api('/api/jk/control/status'), api('/api/jk/control/execution'), api('/api/jk/control/goals'), api('/api/jk/control/approvals'), api('/api/jk/control/logs?limit=80'), api('/api/jk/control/notifications')
      ]);
      state.projects = projects.projects || [];
      state.status = status;
      state.runtimeSampleAt = Date.now();
      state.execution = execution;
      state.goals = goals.goals || [];
      state.approvals = approvals.approvals || [];
      state.jobs = approvals.jobs || [];
      state.logs = logs.logs || [];
      state.notifications = notifications.notifications || null;
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
      state.activationPreset = state.activationPreset || status.session.leasePreset || 'read-only';
      const desired = state.selectedProjectId || projects.activeProjectId || (state.projects[0] && state.projects[0].projectId) || null;
      state.selectedProjectId = state.projects.some(p => p.projectId === desired) ? desired : ((state.projects[0] && state.projects[0].projectId) || null);
      if (state.selectedProjectId) await loadProjectContext(state.selectedProjectId);
      updateChrome(); render();
      requestAnimationFrame(() => animateDashboardChanges(previousDashboard, dashboardSnapshot()));
      if (!quiet) toast('Refreshed');
    } catch (err) { if (err && err.transient) { if (!state.status) content.innerHTML = '<div class="empty">JK 서버 재연결 중…</div>'; scheduleReconnect(); return; } content.innerHTML = '<div class="empty">Control Center API error: ' + esc(err.message) + '</div>'; }
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
      approvalButton.style.borderColor = state.approvals.length ? '#854d0e' : '';
      approvalButton.style.color = state.approvals.length ? '#fdba74' : '';
    }
    [...nav.querySelectorAll('button')].forEach(b => b.classList.toggle('active', b.dataset.page === state.page));
    [...mobileNav.querySelectorAll('button')].forEach(b => b.classList.toggle('primary', b.dataset.page === state.page));
  }
  function projectSelector() {
    return '<select class="select" id="project-context-select" style="max-width:320px">' + state.projects.map(p => '<option value="' + esc(p.projectId) + '" ' + (p.projectId === state.selectedProjectId ? 'selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>';
  }
  function executorInfo() { return state.status && state.status.executors || {local:null,items:[],routes:{}}; }
  function executorSummaryHtml() {
    const info = executorInfo();
    const local = info.local || {executorId:'local',label:'Local Hub',online:true,platform:'unknown',projectCount:0};
    const workers = info.items || [];
    const row = (item, localRow=false) => '<div class="project-row"><div><div class="project-name"><span class="badge ' + (item.online ? 'ok' : 'warn') + '">' + (item.online ? '● ONLINE' : '○ OFFLINE') + '</span> ' + esc(item.label || item.executorId) + '</div><div class="mono">' + esc(item.platform || 'unknown') + '</div><div class="sub">' + esc(localRow ? ((item.projectCount || 0) + ' local project(s)') : (((item.projects || []).length) + ' project(s) · heartbeat ' + fmtAge(item.lastSeenAtMs))) + '</div></div><div class="badges"><span class="badge">' + esc(item.executorId) + '</span>' + (localRow ? '<span class="badge default">Hub</span>' : '<span class="badge">Outbound worker</span>') + '</div></div>';
    return '<div class="panel" style="margin-top:12px"><div class="role-head"><div><h2 class="section-title">Executors</h2><div class="sub">현재 JK 인스턴스가 local hub이고, 선택적으로 outbound worker를 연결할 수 있습니다. worker가 offline이면 사용 가능한 local project로 fallback합니다.</div></div><div class="toolbar"><span class="badge ' + (workers.some(x=>x.online) ? 'ok' : 'default') + '">' + esc(workers.filter(x=>x.online).length + ' remote online') + '</span><button class="btn small" id="pair-windows-executor">Windows 연결</button></div></div><div class="project-list" style="margin-top:12px">' + row(local, true) + workers.map(w => row(w, false)).join('') + '</div></div>';
  }
  async function pairWindowsExecutor() {
    const workspace = window.prompt('Windows에서 JK가 접근할 workspace 경로를 입력하세요.', 'C:\\workspace');
    if (!workspace) return;
    const issued = await api('/api/jk/control/executors/windows-main/token', {method:'POST'});
    const token = issued.token;
    const hub = location.origin;
    const cleanWorkspace = workspace.replace(/"/g,'');
    const command = '$d=Join-Path $env:LOCALAPPDATA "JK"; New-Item -ItemType Directory -Force $d | Out-Null; $f=Join-Path $d "executor-token.txt"; Set-Content -NoNewline -Encoding ascii $f "' + token + '"; $env:JK_HUB_URL="' + hub + '"; $env:JK_EXECUTOR_ID="windows-main"; $env:JK_EXECUTOR_WORKSPACE="' + cleanWorkspace + '"; $env:JK_EXECUTOR_TOKEN_FILE=$f; [Environment]::SetEnvironmentVariable("JK_HUB_URL",$env:JK_HUB_URL,"User"); [Environment]::SetEnvironmentVariable("JK_EXECUTOR_ID",$env:JK_EXECUTOR_ID,"User"); [Environment]::SetEnvironmentVariable("JK_EXECUTOR_WORKSPACE",$env:JK_EXECUTOR_WORKSPACE,"User"); [Environment]::SetEnvironmentVariable("JK_EXECUTOR_TOKEN_FILE",$f,"User"); $startup=[Environment]::GetFolderPath("Startup"); $legacy=Join-Path $startup "JK Executor.cmd"; if(Test-Path -LiteralPath $legacy){try{$raw=Get-Content -Raw -LiteralPath $legacy; if($raw -match "executor-supervisor\\.js"){Remove-Item -Force -LiteralPath $legacy}}catch{}}; Write-Host "JK Windows worker configured. Restart JK once."';
    try { await navigator.clipboard.writeText(command); } catch {}
    window.prompt('아래 명령을 Windows PowerShell에서 한 번 실행한 뒤 JK 앱을 한 번 재시작하세요. 이제 worker 재시작과 장애 복구는 JK 앱이 직접 관리합니다. JK 설정의 Windows 시작 시 JK 실행을 켜두면 로그인 후 자동 연결됩니다. 클립보드에도 복사했습니다.', command);
  }
  function projectExecutorControl(p) {
    if (p.executorKind === 'remote') return '<div class="badges"><span class="badge ok">' + esc(p.executorId || 'remote') + '</span><span class="badge">Remote</span></div>';
    const info = executorInfo();
    const routes = info.routes || {};
    const selected = routes[p.projectId] || 'local';
    const workers = (info.items || []).filter(w => (w.projects || []).some(r => r.projectId === p.projectId));
    const options = '<option value="local" ' + (selected === 'local' ? 'selected' : '') + '>Local Hub</option>' + workers.map(w => '<option value="' + esc(w.executorId) + '" ' + (selected === w.executorId ? 'selected' : '') + '>' + esc((w.label || w.executorId) + (w.online ? ' · online' : ' · offline')) + '</option>').join('');
    return '<label class="sub">Executor <select class="select" data-executor-route-project="' + esc(p.projectId) + '" style="width:170px;margin-left:6px">' + options + '</select></label>';
  }
  function quickLinksHtml() {
    const custom = state.status && Array.isArray(state.status.quickLinks) ? state.status.quickLinks : [];
    const links = custom.concat([
      {title:'JK Dashboard', note:'현재 Control Center 열기', badge:'Admin', badgeClass:'active', href:location.origin + '/'},
      {title:'Approvals', note:'승인 대기 작업 바로 확인', badge:'Admin', badgeClass:'active', href:location.origin + '/approvals'}
    ]);
    const items = links.map(link => '<a class="quick-link" href="' + esc(link.href) + '" target="_blank" rel="noopener noreferrer"><div class="quick-link-copy"><div class="quick-link-title">' + esc(link.title) + '</div><div class="quick-link-note">' + esc(link.note) + '</div><div class="badges" style="margin-top:8px"><span class="badge ' + esc(link.badgeClass) + '">' + esc(link.badge) + '</span></div></div><span class="quick-link-arrow" aria-hidden="true">↗</span></a>').join('');
    return '<div class="panel quick-links-panel"><div class="quick-links-head"><div><h2 class="section-title" style="margin-bottom:4px">Quick Links</h2><div class="sub">자주 여는 서비스와 배포 링크를 한곳에 모았습니다.</div></div><span class="badge">' + esc(links.length) + ' links</span></div><div class="quick-links">' + items + '</div></div>';
  }
  function deploymentStatusHtml() {
    const d = state.status && state.status.deployment || null;
    if (!d) return '';
    const short = (sha) => sha ? String(sha).slice(0, 8) : '—';
    const synced = d.state === 'synced';
    const stateClass = synced ? 'ok' : (d.state === 'drift' || d.state === 'dirty') ? 'warn' : 'default';
    return '<div class="panel" style="margin-top:12px"><div class="role-head"><div><h2 class="section-title">Deployment</h2><div class="sub"><span class="mono">Upstream ' + esc(short(d.upstreamSha)) + '</span> → <span class="mono">Runtime ' + esc(short(d.deployedSha)) + '</span> · 마지막 배포 ' + esc(fmtAge(d.lastSyncAtMs)) + '</div></div><span class="badge ' + stateClass + '">' + esc((d.state || 'unknown').toUpperCase()) + '</span></div><div class="badges" style="margin-top:10px"><span class="badge ' + (d.build === 'pass' ? 'ok' : 'default') + '">Build ' + esc((d.build || 'unknown').toUpperCase()) + '</span><span class="badge ' + (d.health === 'pass' ? 'ok' : 'warn') + '">Health ' + esc((d.health || 'unknown').toUpperCase()) + '</span><span class="badge ' + (d.tunnel === 'pass' ? 'ok' : 'warn') + '">Network ' + esc((d.tunnel || 'unknown').toUpperCase()) + '</span></div></div>';
  }
  function dashboard() {
    const runtimeCtx = state.status && state.status.roleContext || {};
    const role = runtimeCtx.role || {};
    const execution = state.execution && state.execution.execution || {};
    const activeProject = state.projects.find(p => p.projectId === (state.status && state.status.session.activeProjectId));
    const manualOverride = runtimeCtx.selectionSource === 'last-used';
    const task = execution.task || execution.goal || null;
    const progress = execution.lastProgressSummary || (task ? 'JK가 요청을 실행하고 검증 상태를 갱신합니다.' : 'ChatGPT에서 @jk로 원하는 작업을 자연어로 말하면 됩니다.');
    const verificationClass = execution.verificationStatus === 'pass' ? 'ok' : execution.verificationStatus === 'fail' ? 'danger' : execution.verificationStatus === 'blocked' ? 'warn' : 'default';
    return '<div class="page-head"><div><h1>JK Control Center</h1><div class="sub">지금 필요한 상태와 승인만 빠르게 확인하세요. 세부 설정은 필요할 때만 열면 됩니다.</div></div><div class="toolbar"><button class="btn" data-nav-page="projects">프로젝트</button><button class="btn" data-nav-page="guide">사용법</button></div></div>' +
      '<div class="panel dashboard-hero"><div class="dashboard-hero-copy"><div class="dashboard-eyebrow">' + esc(manualOverride ? 'MANUAL OVERRIDE ACTIVE' : 'AUTO ORCHESTRATION') + '</div><div class="dashboard-task">' + esc(task || '무엇을 할지만 말하면 JK가 알아서 작업 방식을 고릅니다.') + '</div><div class="sub">' + esc(activeProject ? activeProject.name + ' · ' + (execution.phase || 'ready') : 'Active project를 선택하면 실행 컨텍스트가 여기에 표시됩니다.') + '</div></div><div class="dashboard-hero-status"><span class="badge ' + verificationClass + '">' + esc(execution.verificationStatus || (task ? 'working' : 'ready')) + '</span><strong>' + esc(manualOverride ? (role.name || 'Manual role') : modeLabel(execution.mode)) + '</strong><span class="sub">' + esc(manualOverride ? '직접 선택한 Role을 우선 사용 중' : 'JK가 Role · 권한 · workflow를 자동 선택') + '</span></div></div>' +
      '<div class="grid-4">' +
        metric('프로젝트', activeProject ? activeProject.name : '선택 안 됨', activeProject ? activeProject.projectId : '활성 lease 없음', 'project') +
        metric('실행 모드', modeLabel(execution.mode), manualOverride ? 'Manual · ' + (role.name || 'Role') : 'Auto · ' + (role.name || 'Default'), 'mode') +
        metric('현재 권한', permissionLabel(runtimeCtx.effectivePermission), '작업 범위에 맞춰 최소 권한 적용', 'permission') +
        metric('승인 대기', state.approvals.length ? state.approvals.length + '건' : '없음', state.approvals.length ? '확인 후 작업이 계속됩니다' : '고위험 작업만 중단', 'approvals') +
      '</div>' +
      deploymentStatusHtml() +
      quickLinksHtml() +
      executorSummaryHtml() +
      '<div id="dashboard-approvals-root">' + pendingApprovalsBanner() + '</div>' +
      workflowRailHtml() +
      '<div class="split"><div class="panel"><h2 class="section-title">현재 작업</h2><div class="run-summary"><div class="run-summary-title">' + esc(task || '현재 실행 중인 작업이 없습니다.') + '</div><div class="run-summary-note">' + esc(progress) + '</div><div class="badges"><span class="badge">' + esc(execution.phase || 'idle') + '</span><span class="badge">' + esc(execution.primaryStage || 'standby') + '</span><span class="badge ' + verificationClass + '">검증 ' + esc(execution.verificationStatus || 'unknown') + '</span><span class="badge">' + esc((execution.completedCount || 0) + ' 완료') + '</span><span class="badge">' + esc((execution.pendingCount || 0) + ' 대기') + '</span></div></div></div>' +
      '<div class="panel"><h2 class="section-title">권한 · 안전 경계</h2><div class="kv"><dt>Role</dt><dd>' + esc(role.name || 'Default') + (manualOverride ? ' · Manual' : ' · Auto') + '</dd><dt>권한</dt><dd><span class="badge ' + permissionClass(runtimeCtx.effectivePermission) + '">' + esc(permissionLabel(runtimeCtx.effectivePermission)) + '</span></dd><dt>승인 정책</dt><dd>고위험 작업만 사용자 확인</dd></div><div class="advanced-links"><button class="btn small" data-nav-page="roles">Role 고급 설정</button><button class="btn small" data-nav-page="goals">실행 기록</button></div></div></div>' +
      '<div class="panel" style="margin-top:12px"><h2 class="section-title">최근 활동</h2><div id="dashboard-activity-root">' + logList(state.logs.slice(0,6)) + '</div></div>';
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
      const banner = document.querySelector('#dashboard-approvals-root .panel');
      if (banner) banner.classList.add('attention');
    }
    if (next.latestLog && next.latestLog !== previous.latestLog) {
      const row = document.querySelector('#dashboard-activity-root .log-row');
      if (row) row.classList.add('fresh');
    }
  }
  function pendingApprovalsBanner() {
    if (!state.approvals.length) return '';
    const scoped = state.approvals.filter(a => a.scopeLabel).length;
    const summary = scoped
      ? esc(state.approvals.length) + ' request(s) waiting · ' + esc(scoped) + ' read-only scope can open a 15-minute session.'
      : esc(state.approvals.length) + ' exact local command(s) are waiting for you. Approval expires after 5 minutes and is consumed once.';
    return '<div class="panel" style="margin-top:12px;border-color:#854d0e;background:#17130f"><div class="role-head"><div><h2 class="section-title" style="margin-bottom:4px">Approval required</h2><div class="sub">' + summary + '</div></div><button class="btn primary" id="open-approvals">Review</button></div></div>';
  }
  function workflowRailHtml() {
    const e = state.execution && state.execution.execution || {};
    const current = e.phase || null;
    const activeIndex = workflowPhases.indexOf(current);
    const steps = workflowPhases.map((phase, index) => {
      const status = phase === current ? 'active' : (activeIndex >= 0 && index < activeIndex ? 'done' : 'future');
      return '<div class="workflow-step ' + status + '"><span class="workflow-dot"></span><span class="workflow-label">' + esc(phase) + '</span></div>';
    }).join('');
    const verificationClass = e.verificationStatus === 'pass' ? 'ok' : e.verificationStatus === 'fail' ? 'danger' : e.verificationStatus === 'blocked' ? 'warn' : 'default';
    if (!e.task && !e.goal && !e.phase) return '';
    return '<div class="panel workflow-panel"><div class="workflow-head"><div><h2 class="section-title" style="margin-bottom:0">실행 단계</h2><div class="sub">탐색 → 구현 → 검증 중 현재 위치를 보여줍니다.</div></div><span class="badge ' + verificationClass + '">' + esc(e.verificationStatus || 'unknown') + '</span></div><div id="workflow-rail-root"><div class="workflow-strip">' + steps + '</div><div class="workflow-meta"><span>' + esc(e.primaryStage || 'idle') + (e.supportingStages && e.supportingStages.length ? ' + ' + esc(e.supportingStages.join(', ')) : '') + '</span><span>' + esc((e.completedCount || 0) + ' 완료 · ' + (e.pendingCount || 0) + ' 대기') + '</span></div></div></div>';
  }
  async function refreshExecution() {
    try {
      state.execution = await api('/api/jk/control/execution');
      updateChrome();
      if (state.page === 'dashboard') {
        const workflowRoot = document.getElementById('workflow-rail-root');
        if (workflowRoot) {
          const holder = document.createElement('div');
          holder.innerHTML = workflowRailHtml();
          const nextWorkflow = holder.querySelector('#workflow-rail-root');
          if (nextWorkflow) workflowRoot.innerHTML = nextWorkflow.innerHTML;
        }
      }
    } catch {}
  }
  async function refreshSignals() {
    if (document.hidden) return;
    try {
      const previous = dashboardSnapshot();
      const [approvals, logs] = await Promise.all([api('/api/jk/control/approvals'), api('/api/jk/control/logs?limit=80')]);
      const nextApprovals = approvals.approvals || [];
      const nextJobs = approvals.jobs || [];
      const nextLogs = logs.logs || [];
      const approvalsChanged = nextApprovals.map(x => x.id).join('|') !== state.approvals.map(x => x.id).join('|');
      const jobsChanged = nextJobs.map(x => [x.id,x.status,x.finishedAt,x.exitCode].join(':')).join('|') !== state.jobs.map(x => [x.id,x.status,x.finishedAt,x.exitCode].join(':')).join('|');
      const logsChanged = (nextLogs[0] && nextLogs[0].ts || null) !== (state.logs[0] && state.logs[0].ts || null);
      state.approvals = nextApprovals;
      state.jobs = nextJobs;
      state.logs = nextLogs;
      updateChrome();
      if (state.page === 'dashboard') {
        const approvalsRoot = document.getElementById('dashboard-approvals-root');
        if (approvalsRoot && approvalsChanged) approvalsRoot.innerHTML = pendingApprovalsBanner();
        const activityRoot = document.getElementById('dashboard-activity-root');
        if (activityRoot && logsChanged) activityRoot.innerHTML = logList(state.logs.slice(0,8));
        requestAnimationFrame(() => animateDashboardChanges(previous, dashboardSnapshot()));
        if (approvalsChanged) {
          const openApprovals = document.getElementById('open-approvals');
          if (openApprovals) openApprovals.addEventListener('click', () => navigate('approvals'));
        }
      } else if ((state.page === 'approvals' && (approvalsChanged || jobsChanged)) || (state.page === 'logs' && logsChanged)) {
        render();
      }
    } catch {}
  }
  function projectsPage() {
    const activeId = state.status && state.status.session.activeProjectId;
    return '<div class="page-head"><div><h1>Projects</h1><div class="sub">보통은 ChatGPT 요청에 맞춰 JK가 권한과 실행 위치를 자동으로 선택합니다. Windows 우선 프로젝트만 Executor를 바꾸면 됩니다.</div></div><div class="toolbar"><label class="sub" for="activation-preset">Manual activation</label><select class="select" id="activation-preset" style="width:150px"><option value="read-only" ' + (state.activationPreset==='read-only'?'selected':'') + '>Read Only</option><option value="tests-only" ' + (state.activationPreset==='tests-only'?'selected':'') + '>Tests Only</option><option value="full-write" ' + (state.activationPreset==='full-write'?'selected':'') + '>Full Write</option><option value="image-only" ' + (state.activationPreset==='image-only'?'selected':'') + '>Image Only</option></select></div></div><div class="project-list">' + state.projects.map(p =>
      '<div class="project-row"><div><div class="project-name">' + esc(p.name) + ' ' + (p.projectId === activeId ? '<span class="badge active">ACTIVE</span>' : '') + '</div><div class="mono">' + esc(p.root) + '</div><div class="badges" style="margin-top:7px"><span class="badge">' + esc(p.branch || 'no branch') + '</span>' + (p.dirty ? '<span class="badge warn">dirty</span>' : '<span class="badge ok">clean</span>') + (p.executorKind === 'remote' ? '<span class="badge active">' + esc(p.executorId) + '</span>' : '<span class="badge default">Local</span>') + '</div></div><div class="actions">' + projectExecutorControl(p) + '<button class="btn small" data-view-project="' + esc(p.projectId) + '">Advanced</button><button class="btn small primary" data-activate-project="' + esc(p.projectId) + '">Activate</button></div></div>'
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
    return '<div class="page-head"><div><h1>Skills</h1><div class="sub">현재 Role에 주입되는 skill context입니다.</div></div>' + projectSelector() + '</div><div class="panel"><h2 class="section-title">' + esc(role ? role.name : 'Default') + '</h2>' + ((role && role.skills && role.skills.length) ? '<div class="skill-cloud">' + role.skills.map(s => '<span class="skill">' + esc(s) + '</span>').join('') + '</div>' : '<div class="empty">No role-specific skills</div>') + '<div class="kv" style="margin-top:18px"><dt>Tools</dt><dd>' + esc(role && role.tools ? role.tools.join(' · ') : '—') + '</dd><dt>Workflow</dt><dd>' + esc(role && role.workflowPreference || '—') + '</dd></div></div>';
  }
  function guidePage() {
    return '<div class="guide-hero">' +
      '<div class="panel guide-hero-copy"><div><span class="badge active">START HERE</span></div><div><h1>JK 시작 가이드</h1><div class="sub">프로젝트를 고르고 → ChatGPT에서 @jk로 요청하면 됩니다. Role·권한·실행 위치는 작업 의도와 연결 상태에 맞춰 선택됩니다.</div></div><div class="badges"><span class="badge ok">Local Hub + Workers</span><span class="badge">Auto role</span><span class="badge">Least privilege</span></div></div>' +
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
      const bundled = Boolean(a.bundleLabel && a.bundlePreviews && a.bundlePreviews.length);
      const bundleCount = bundled ? a.bundlePreviews.length : 0;
      const supervisedEligible = !bundled && Boolean(a.reason && a.needsNetwork && !a.destructive);
      const risks = (a.needsNetwork ? '<span class="badge warn">Network</span>' : '') + (a.destructive ? '<span class="badge danger">Destructive</span>' : '') + (scoped ? '<span class="badge ok">Read-only session</span>' : '') + (bundled ? '<span class="badge active">Task bundle ' + esc(bundleCount) + '</span>' : '') + (supervisedEligible ? '<span class="badge active">Supervised 30m</span>' : '');
      const riskReason = [a.needsNetwork ? (scoped ? '검증된 읽기 전용 외부 조회' : '외부 네트워크 작업') : '', a.destructive ? '파괴적 변경' : ''].filter(Boolean).join(' + ');
      const approvalReason = a.reason || (riskReason ? riskReason + ' 작업은 명시적 로컬 승인이 필요합니다.' : '이 작업은 명시적 로컬 승인이 필요합니다.');
      const grantText = bundled
        ? '승인 시 같은 프로젝트·작업 경로·goal/loop 안에서 아래 <strong>' + esc(bundleCount) + '개 exact 명령+위험 조합</strong>만 최대 ' + esc(Math.round((a.bundleTtlMs || 1800000) / 60000)) + '분 동안 재승인 없이 허용합니다. 목록 밖 명령이나 위험도 변경은 다시 승인합니다.'
        : scoped
        ? '승인 시 같은 프로젝트/작업 경로의 <strong>' + esc(a.scopeLabel) + '</strong> 조회를 최대 ' + esc(Math.round((a.scopeTtlMs || 900000) / 60000)) + '분 동안 재승인 없이 허용합니다. 쓰기·권한변경·삭제 명령에는 적용되지 않습니다.'
        : '승인 시 이 exact job을 즉시 실행 · 다른 명령에는 적용되지 않음 · 5분 후 요청 만료';
      const approveLabel = bundled ? '묶음 ' + bundleCount + '개 승인' : scoped ? '15분 조회 승인' : supervisedEligible ? '1회만 승인' : '승인하고 실행';
      const superviseButton = supervisedEligible ? '<button class="btn primary" data-approval-decision="supervise" data-approval-id="' + esc(a.id) + '">이 작업 30분 승인 · 권장</button>' : '';
      const exactApproveClass = supervisedEligible ? 'btn' : 'btn primary';
      const supervisedText = supervisedEligible ? '<div class="sub" style="margin-top:8px"><strong>반복 작업이면 위의 30분 승인을 권장합니다.</strong> 같은 프로젝트·작업 경로·작업 이유의 비파괴 네트워크 실행은 재승인 없이 진행되고, 파괴적/고위험 명령은 계속 따로 승인합니다. 승인한 queued job은 즉시 자동 실행되므로 ChatGPT가 같은 명령을 다시 보낼 필요가 없습니다.</div>' : '';
      const bundleCommands = bundled ? '<div class="sub" style="margin-top:10px">승인 묶음</div><div class="mono approval-command">' + a.bundlePreviews.map((x,i) => esc((i + 1) + '. ' + x)).join('\n') + '</div>' : '';
      return '<div class="goal-row approval-card"><div class="role-head"><div><div class="goal-title">' + (bundled ? '작업 묶음 승인' : scoped ? '읽기 전용 승인' : '명령 실행 승인') + '</div><div class="goal-meta"><span>' + esc(project ? project.name + ' · ' + a.projectId : a.projectId) + '</span><span>' + risks + '</span><span>' + esc(fmtRemaining(a.expiresAt)) + ' 후 만료</span></div></div><div class="approval-actions">' + superviseButton + '<button class="' + exactApproveClass + '" data-approval-decision="approve" data-approval-id="' + esc(a.id) + '">' + approveLabel + '</button><button class="btn danger" data-approval-decision="deny" data-approval-id="' + esc(a.id) + '">거절</button></div></div><div class="sub" style="margin-top:12px">첫 실행 명령</div><div class="mono approval-command">' + esc(a.commandPreview || '') + '</div>' + bundleCommands + '<div class="sub" style="margin-top:10px">왜 필요한가: ' + esc(approvalReason) + '</div><div class="sub" style="margin-top:8px">요청 ' + esc(fmtAge(a.createdAt)) + ' · ' + grantText + '</div>' + supervisedText + '</div>';
    }).join('') : '<div class="empty">No commands are waiting for approval.</div>';
    const recentJobs = (state.jobs || []).slice(0,8).map(j => {
      const staleRecovered = j.status === 'failed' && j.error === 'Interrupted or stale running job reconciled after timeout';
      const statusClass = staleRecovered ? 'default' : j.status === 'succeeded' ? 'ok' : j.status === 'failed' || j.status === 'denied' ? 'danger' : j.status === 'running' ? 'active' : 'default';
      const statusLabel = staleRecovered ? 'stale history' : j.status;
      const activityAt = staleRecovered && j.startedAt ? j.startedAt : j.finishedAt || j.startedAt || j.createdAt;
      const meta = [j.projectId, staleRecovered ? '이전 실행 기록 정리' : j.exitCode === undefined ? '' : 'exit ' + j.exitCode, fmtAge(activityAt)].filter(Boolean).join(' · ');
      return '<div class="goal-row"><div class="role-head"><div><div class="goal-title">Approved job</div><div class="goal-meta"><span>' + esc(meta) + '</span></div></div><span class="badge ' + statusClass + '">' + esc(statusLabel) + '</span></div><div class="mono" style="margin-top:8px;white-space:pre-wrap;word-break:break-word">' + esc(j.commandPreview || '') + '</div></div>';
    }).join('');
    return '<div class="page-head"><div><h1>Approvals</h1><div class="sub">멈춰 있는 작업만 확인하면 됩니다. 승인 범위는 표시된 exact 명령 묶음·단일 명령·읽기 세션으로 제한됩니다.</div></div><button class="btn" id="refresh-approvals">새로고침</button></div><div class="goal-list">' + rows + '</div>' + (recentJobs ? '<div class="page-head" style="margin-top:20px"><div><h2>최근 승인 작업</h2><div class="sub">승인 후 자동 실행된 작업의 결과입니다.</div></div></div><div class="goal-list">' + recentJobs + '</div>' : '');
  }
  function logsPage() { return '<div class="page-head"><div><h1>Activity</h1><div class="sub">JK가 최근에 수행한 작업과 감사 이벤트를 민감 필드 없이 요약합니다.</div></div><button class="btn" id="refresh-logs">Refresh</button></div>' + logList(state.logs); }
  function logList(logs) { return '<div class="log-list">' + (logs.length ? logs.map(l => '<div class="log-row"><div class="log-type">' + esc(l.type) + '</div><div class="log-detail">' + esc(l.detail || l.projectId || '') + '</div><div class="mono">' + esc(fmtAge(l.ts)) + '</div></div>').join('') : '<div class="empty">No recent audit events</div>') + '</div>'; }
  function systemPage() {
    const s = state.status || {runtime:{}, session:{}};
    const n = state.notifications || {enabled:false,baseUrl:'https://ntfy.sh',topic:'',clickUrl:''};
    const adminAccess = isLocalSurface ? '<span class="badge ok">Loopback only</span>' : '<span class="badge ok">Authenticated remote</span> · ' + esc(location.hostname);
    const pushPanel = '<div class="panel" style="margin-top:12px"><div class="role-head"><div><h2 class="section-title">Mobile Push</h2><div class="sub">ChatGPT 알림과 별개로 승인 필요 · 작업 완료 · 작업 실패를 ntfy로 보냅니다. 명령 전체나 secret은 전송하지 않습니다.</div></div><span class="badge ' + (n.enabled ? 'ok' : 'default') + '">' + (n.enabled ? 'ON' : 'OFF') + '</span></div>' + (n.enabled ? '<div class="kv" style="margin-top:16px"><dt>Server</dt><dd class="mono">' + esc(n.baseUrl) + '</dd><dt>Topic</dt><dd class="mono">' + esc(n.topic) + '</dd><dt>Tap action</dt><dd class="mono">' + esc(n.clickUrl || location.origin) + '</dd></div><div class="actions" style="margin-top:16px"><button class="btn primary" id="push-test">테스트 푸시</button><button class="btn" id="push-copy-topic">토픽 복사</button><button class="btn danger" id="push-disable">끄기</button></div>' : '<div class="actions" style="margin-top:16px"><button class="btn primary" id="push-enable">푸시 알림 활성화</button></div>') + '</div>';
    return '<div class="page-head"><div><h1>Settings</h1><div class="sub">평소에는 건드릴 필요 없는 런타임 정보와 고급 설정입니다. 토큰과 secret은 표시하지 않습니다.</div></div></div><div class="grid-2"><div class="panel"><h2 class="section-title">Runtime</h2><dl class="kv"><dt>Status</dt><dd><span class="badge ok">Online</span></dd><dt>Mode</dt><dd><span class="badge default">' + esc(s.runtime.mode || 'unknown') + '</span></dd><dt>Runtime root</dt><dd class="mono">' + esc(s.runtime.runtimeRoot || '—') + '</dd><dt>PID</dt><dd>' + esc(s.runtime.pid) + '</dd><dt>Node</dt><dd>' + esc(s.runtime.node) + '</dd><dt>Platform</dt><dd>' + esc(s.runtime.platform) + '</dd><dt>Uptime</dt><dd>' + esc(Math.floor(s.runtime.uptimeSec || 0)) + ' sec</dd><dt>Workspace</dt><dd class="mono">' + esc(s.runtime.workspaceRoot) + '</dd></dl></div><div class="panel"><h2 class="section-title">Advanced</h2><div class="sub">자동 판단을 특별히 조정하거나 내부 상태를 확인할 때만 사용하세요.</div><div class="advanced-links"><button class="btn" data-nav-page="guide">JK 사용법</button><button class="btn" data-nav-page="roles">Role overrides</button><button class="btn" data-nav-page="skills">Role skills</button><button class="btn" data-nav-page="goals">실행 기록</button></div><dl class="kv" style="margin-top:18px"><dt>Control Center</dt><dd>' + esc(location.origin + '/') + '</dd><dt>MCP</dt><dd>/mcp</dd><dt>Health</dt><dd>/healthz</dd><dt>Admin access</dt><dd>' + adminAccess + '</dd><dt>Lease expires</dt><dd>' + esc(fmtTime(s.session.leaseExpiresAt)) + '</dd></dl></div></div>' + pushPanel;
  }
  function render() {
    const pages = {dashboard, projects: projectsPage, roles: rolesPage, skills: skillsPage, guide: guidePage, goals: goalsPage, approvals: approvalsPage, logs: logsPage, system: systemPage};
    content.innerHTML = (pages[state.page] || dashboard)();
    bindPage(); updateChrome();
  }
  async function selectContext(projectId) { state.selectedProjectId = projectId; await loadProjectContext(projectId); updateChrome(); render(); }
  async function activateProject(projectId) { await api('/api/jk/control/projects/' + encodeURIComponent(projectId) + '/activate', {method:'POST', body: JSON.stringify({ preset: state.activationPreset || 'read-only' })}); state.selectedProjectId = projectId; await loadAll({quiet:true}); toast('Active project changed'); }
  async function applyRole(roleId) { await api('/api/jk/projects/' + encodeURIComponent(state.selectedProjectId) + '/role', {method:'POST', body:JSON.stringify({roleId})}); await loadProjectContext(state.selectedProjectId); render(); toast('Role applied'); }
  async function setDefault(roleId) { await api('/api/jk/projects/' + encodeURIComponent(state.selectedProjectId) + '/role/default', {method:'POST', body:JSON.stringify({roleId})}); await loadProjectContext(state.selectedProjectId); render(); toast('Project default updated'); }
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
  function bindPage() {
    document.querySelectorAll('[data-nav-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.navPage)));
    const ps = document.getElementById('project-context-select'); if (ps) ps.addEventListener('change', e => selectContext(e.target.value));
    const activation = document.getElementById('activation-preset'); if (activation) activation.addEventListener('change', e => { state.activationPreset = e.target.value; });
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
    document.querySelectorAll('[data-approval-decision]').forEach(b => b.addEventListener('click', async () => { try { const approval=state.approvals.find(a=>a.id===b.dataset.approvalId); const decision=b.dataset.approvalDecision; await api('/api/jk/control/approvals/' + encodeURIComponent(b.dataset.approvalId), {method:'POST', body:JSON.stringify({decision})}); await loadAll({quiet:true}); toast(decision === 'supervise' ? '승인됨 · 요청한 작업을 자동 실행합니다.' : decision === 'approve' ? (approval && approval.scopeLabel ? '조회 승인됨 · 요청한 조회를 자동 실행합니다.' : '승인됨 · 이 명령을 자동 실행합니다.') : 'Approval denied.'); } catch (e) { toast(e.message); } }));
  }
  function navigate(page) { if (!allowedPages.includes(page)) return; state.page=page; history.replaceState(null, '', page === 'dashboard' ? '/' : page === 'approvals' ? '/approvals' : '/?page=' + encodeURIComponent(page)); render(); }
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
  setInterval(refreshExecution,2500);
  setInterval(refreshSignals,5000);
  setInterval(() => loadAll({quiet:true}), 15000);
})();
</script>
</body>
</html>`;
