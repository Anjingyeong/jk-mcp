export const MASS_ULW_DASHBOARD_SCRIPT = String.raw`  function massUlwNodeIcon(status) {
    if (status === 'completed') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5 8.2 14 15 6.5"/></svg>';
    if (status === 'in-flight') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v3m0 8v3M3 10h3m8 0h3M5 5l2 2m6 6 2 2m0-10-2 2M7 13l-2 2"/></svg>';
    if (status === 'failed') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>';
    if (status === 'blocked') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 9V7a4 4 0 0 1 8 0v2M5 9h10v8H5z"/></svg>';
    if (status === 'review') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12v10H4zM7 8h6m-6 3h4"/></svg>';
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14M3 10h14"/></svg>';
  }

  function massUlwSemanticStatus(lane, laneById) {
    if (lane.status !== 'planned') return lane.status;
    const dependencies = Array.isArray(lane.dependsOn) ? lane.dependsOn : [];
    return dependencies.every(id => laneById[id] && laneById[id].status === 'completed') ? 'ready' : 'planned';
  }

  function massUlwGraphHtml(lanes) {
    if (!lanes.length) return '<div class="sub" role="status">세부 lane 정보는 다음 상태 갱신부터 표시됩니다.</div>';
    const laneById = Object.fromEntries(lanes.map(lane => [lane.id, lane]));
    const columns = new Map();
    lanes.forEach(lane => {
      const wave = Number.isInteger(lane.wave) && lane.wave >= 0 ? lane.wave : 0;
      if (!columns.has(wave)) columns.set(wave, []);
      columns.get(wave).push(lane);
    });
    const waves = [...columns.keys()].sort((a,b) => a-b);
    const nodeWidth = 224;
    const nodeHeight = 104;
    const colGap = 56;
    const rowGap = 22;
    const pad = 16;
    const positions = {};
    let maxRows = 1;
    waves.forEach((wave, columnIndex) => {
      const column = columns.get(wave) || [];
      maxRows = Math.max(maxRows, column.length);
      column.forEach((lane, rowIndex) => {
        positions[lane.id] = {
          x: pad + columnIndex * (nodeWidth + colGap),
          y: pad + rowIndex * (nodeHeight + rowGap),
          wave,
        };
      });
    });
    const width = Math.max(280, pad * 2 + waves.length * nodeWidth + Math.max(0, waves.length - 1) * colGap);
    const height = pad * 2 + maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap;
    const edges = lanes.flatMap(lane => {
      const target = positions[lane.id];
      if (!target) return [];
      return (Array.isArray(lane.dependsOn) ? lane.dependsOn : []).map(sourceId => {
        const source = positions[sourceId];
        if (!source) return '';
        const x1 = source.x + nodeWidth;
        const y1 = source.y + nodeHeight / 2;
        const x2 = target.x;
        const y2 = target.y + nodeHeight / 2;
        const bend = Math.max(20, Math.abs(x2 - x1) / 2);
        return '<path class="run-dag-edge" data-edge-from="' + esc(sourceId) + '" data-edge-to="' + esc(lane.id) + '" d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '" marker-end="url(#run-dag-arrow)" />';
      });
    }).join('');
    const nodes = lanes.map(lane => {
      const pos = positions[lane.id];
      const semanticStatus = massUlwSemanticStatus(lane, laneById);
      const dependencies = Array.isArray(lane.dependsOn) ? lane.dependsOn : [];
      const label = semanticStatus === 'completed' ? 'accepted' : semanticStatus === 'in-flight' ? 'running' : semanticStatus;
      const badgeClass = semanticStatus === 'completed' ? 'ok' : semanticStatus === 'in-flight' ? 'active' : semanticStatus === 'failed' ? 'danger' : semanticStatus === 'blocked' ? 'warn' : 'default';
      return '<article class="run-dag-node status-' + esc(semanticStatus) + '" data-lane-id="' + esc(lane.id) + '" data-lane-status="' + esc(semanticStatus) + '" style="left:' + pos.x + 'px;top:' + pos.y + 'px;width:' + nodeWidth + 'px;height:' + nodeHeight + 'px" aria-label="' + esc(lane.id + ' · ' + label) + '">' +
        '<div class="run-dag-node-head"><span class="run-dag-icon">' + massUlwNodeIcon(semanticStatus) + '</span><span class="run-lane-id">' + esc(lane.id) + '</span><span class="badge ' + badgeClass + '">' + esc(label) + '</span></div>' +
        '<div class="run-lane-task">' + esc(lane.task || lane.id) + '</div>' +
        '<div class="run-dag-node-meta"><span>Wave ' + esc(pos.wave + 1) + '</span><span>' + (dependencies.length ? esc(dependencies.length) + ' deps' : 'root') + '</span></div>' +
        '</article>';
    }).join('');
    return '<div class="run-dag-scroll" tabindex="0" aria-label="MASS ULW dependency graph viewport"><div class="run-dag-graph" role="img" aria-label="MASS ULW lane dependency graph" style="width:' + width + 'px;height:' + height + 'px"><svg class="run-dag-edges" viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '" aria-hidden="true"><defs><marker id="run-dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>' + edges + '</svg>' + nodes + '</div></div>';
  }

  function massUlwStatusHtml(e) {
    const massUlw = e.massUlw;
    if (!massUlw) return '';
    const lanes = Array.isArray(massUlw.lanes) ? massUlw.lanes : [];
    const completed = lanes.filter(lane => lane.status === 'completed').length;
    const running = lanes.filter(lane => lane.status === 'in-flight').length;
    const waiting = lanes.filter(lane => lane.status === 'planned').length;
    const trouble = lanes.filter(lane => lane.status === 'failed' || lane.status === 'blocked').length;
    return '<section class="mass-run" aria-label="MASS ULW 작업 그래프">' +
      '<div class="mass-run-head"><div><div class="dashboard-eyebrow">PARALLEL WORK</div><div class="mass-run-title">작업 ' + esc(running) + '개 실행 중 · ' + esc(completed) + '/' + esc(lanes.length) + ' 완료</div></div>' +
      '<div class="badges"><span class="badge">Wave ' + esc(massUlw.currentWave === null ? '—' : massUlw.currentWave + 1) + '</span><span class="badge default">검증 ' + esc(massUlw.verification) + '</span></div></div>' +
      '<div class="run-stats" aria-label="Lane status summary"><span><strong>' + esc(running) + '</strong> 실행</span><span><strong>' + esc(waiting) + '</strong> 대기</span><span><strong>' + esc(completed) + '</strong> 완료</span><span class="' + (trouble ? 'danger-text' : '') + '"><strong>' + esc(trouble) + '</strong> 문제</span></div>' +
      '<div class="run-dag">' + massUlwGraphHtml(lanes) + '</div>' +
      '</section>';
  }`;