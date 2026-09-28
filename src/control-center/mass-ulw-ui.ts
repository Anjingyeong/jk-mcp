export const MASS_ULW_DASHBOARD_SCRIPT = String.raw`  function massUlwNodeIcon(status) {
    if (status === 'completed') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5 8.2 14 15 6.5"/></svg>';
    if (status === 'in-flight') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v3m0 8v3M3 10h3m8 0h3M5 5l2 2m6 6 2 2m0-10-2 2M7 13l-2 2"/></svg>';
    if (status === 'failed') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>';
    if (status === 'blocked') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 9V7a4 4 0 0 1 8 0v2M5 9h10v8H5z"/></svg>';
    if (status === 'review') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12v10H4zM7 8h6m-6 3h4"/></svg>';
    if (status === 'ready') return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5v9l7-4.5z"/></svg>';
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5.5"/></svg>';
  }

  function massUlwSemanticStatus(lane, laneById) {
    if (lane.status !== 'planned') return lane.status;
    const dependencies = Array.isArray(lane.dependsOn) ? lane.dependsOn : [];
    return dependencies.every(id => laneById[id] && laneById[id].status === 'completed') ? 'ready' : 'planned';
  }

  const MASS_ULW_STATUS_LABEL = { completed: '완료', 'in-flight': '실행 중', ready: '준비됨', planned: '대기', failed: '실패', blocked: '막힘', review: '리뷰' };

  // Edge state is derived from both endpoints so the graph reads like a flow:
  // done = satisfied dependency, active = feeding a running lane (animated beam),
  // blocked = upstream failure, pending = not yet reachable.
  function massUlwEdgeState(source, target, laneById) {
    const from = massUlwSemanticStatus(source, laneById);
    const to = massUlwSemanticStatus(target, laneById);
    if (from === 'failed' || from === 'blocked') return 'blocked';
    if (from === 'completed' && to === 'in-flight') return 'active';
    if (from === 'completed') return 'done';
    return 'pending';
  }

  function massUlwGraphHtml(lanes, currentWave) {
    if (!lanes.length) return '<div class="sub" role="status">세부 lane 정보는 다음 상태 갱신부터 표시됩니다.</div>';
    const laneById = Object.fromEntries(lanes.map(lane => [lane.id, lane]));
    const columns = new Map();
    lanes.forEach(lane => {
      const wave = Number.isInteger(lane.wave) && lane.wave >= 0 ? lane.wave : 0;
      if (!columns.has(wave)) columns.set(wave, []);
      columns.get(wave).push(lane);
    });
    const waves = [...columns.keys()].sort((a,b) => a-b);
    const nodeWidth = 214;
    const nodeHeight = 126;
    const colGap = 54;
    const rowGap = 18;
    const pad = 18;
    const headerHeight = 34;
    const positions = {};
    let maxRows = 1;
    waves.forEach((wave, columnIndex) => {
      const column = columns.get(wave) || [];
      maxRows = Math.max(maxRows, column.length);
      column.forEach((lane, rowIndex) => {
        positions[lane.id] = {
          x: pad + columnIndex * (nodeWidth + colGap),
          y: pad + headerHeight + rowIndex * (nodeHeight + rowGap),
          wave,
        };
      });
    });
    const width = Math.max(280, pad * 2 + waves.length * nodeWidth + Math.max(0, waves.length - 1) * colGap);
    const height = pad * 2 + headerHeight + maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap;
    const bands = waves.map((wave, columnIndex) => {
      const members = columns.get(wave) || [];
      const done = members.filter(lane => lane.status === 'completed').length;
      const state = done === members.length ? 'done' : wave === currentWave ? 'current' : 'idle';
      const x = pad + columnIndex * (nodeWidth + colGap) - 10;
      return '<div class="run-dag-wave" data-wave-state="' + state + '" style="left:' + x + 'px;width:' + (nodeWidth + 20) + 'px;height:' + (height - pad + 6) + 'px">' +
        '<span class="run-dag-wave-label">WAVE ' + esc(wave + 1) + '</span><span class="run-dag-wave-count">' + esc(done) + '/' + esc(members.length) + '</span></div>';
    }).join('');
    const edges = lanes.flatMap(lane => {
      const target = positions[lane.id];
      if (!target) return [];
      return (Array.isArray(lane.dependsOn) ? lane.dependsOn : []).map(sourceId => {
        const source = positions[sourceId];
        if (!source) return '';
        const x1 = source.x + nodeWidth;
        const y1 = source.y + nodeHeight / 2;
        const x2 = target.x - 2;
        const y2 = target.y + nodeHeight / 2;
        const bend = Math.max(24, Math.abs(x2 - x1) / 2);
        const edgeState = massUlwEdgeState(laneById[sourceId], lane, laneById);
        return '<path class="run-dag-edge" data-edge-state="' + edgeState + '" data-edge-from="' + esc(sourceId) + '" data-edge-to="' + esc(lane.id) + '" d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '" marker-end="url(#run-dag-arrow)" />';
      });
    }).join('');
    const nodes = lanes.map(lane => {
      const pos = positions[lane.id];
      const semanticStatus = massUlwSemanticStatus(lane, laneById);
      const dependencies = Array.isArray(lane.dependsOn) ? lane.dependsOn : [];
      const label = semanticStatus === 'completed' ? 'accepted' : semanticStatus === 'in-flight' ? 'running' : semanticStatus;
      const badgeClass = semanticStatus === 'completed' ? 'ok' : semanticStatus === 'in-flight' ? 'active' : semanticStatus === 'failed' ? 'danger' : semanticStatus === 'blocked' ? 'warn' : semanticStatus === 'ready' ? 'default' : '';
      const attempts = Number(lane.attempts) > 1 ? '<span>재시도 ' + esc(lane.attempts) + '</span>' : '';
      return '<article class="run-dag-node status-' + esc(semanticStatus) + '" tabindex="0" data-lane-id="' + esc(lane.id) + '" data-lane-status="' + esc(semanticStatus) + '" style="left:' + pos.x + 'px;top:' + pos.y + 'px;width:' + nodeWidth + 'px;height:' + nodeHeight + 'px" aria-label="' + esc(lane.id + ' · ' + label + ' · ' + (lane.task || '')) + '">' +
        '<div class="run-dag-node-head"><span class="run-dag-icon">' + massUlwNodeIcon(semanticStatus) + '</span><span class="run-lane-id">' + esc(lane.id) + '</span><span class="badge ' + badgeClass + '">' + esc(MASS_ULW_STATUS_LABEL[semanticStatus] || label) + '</span></div>' +
        '<div class="run-lane-task">' + esc(lane.task || lane.id) + '</div>' +
        '<div class="run-dag-node-meta"><span>' + (dependencies.length ? '← ' + esc(dependencies.join(', ')) : 'root') + '</span>' + attempts + '</div>' +
        '</article>';
    }).join('');
    return '<div class="run-dag-scroll" tabindex="0" aria-label="MASS ULW dependency graph viewport"><div class="run-dag-graph" role="img" aria-label="MASS ULW lane dependency graph" style="width:' + width + 'px;height:' + height + 'px">' + bands +
      '<svg class="run-dag-edges" viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '" aria-hidden="true"><defs><marker id="run-dag-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>' + edges + '</svg>' + nodes + '</div></div>';
  }

  function massUlwProgressHtml(counts, total) {
    if (!total) return '';
    const seg = (key, value) => value ? '<span class="run-progress-seg" data-seg="' + key + '" style="flex-grow:' + value + '"></span>' : '';
    return '<div class="run-progress" role="img" aria-label="' + esc(counts.completed + '/' + total + ' 완료') + '">' +
      seg('completed', counts.completed) + seg('running', counts.running) + seg('trouble', counts.trouble) + seg('waiting', counts.waiting) + '</div>';
  }

  function massUlwStatusHtml(e) {
    const massUlw = e.massUlw;
    if (!massUlw) return '';
    const lanes = Array.isArray(massUlw.lanes) ? massUlw.lanes : [];
    const completed = lanes.filter(lane => lane.status === 'completed').length;
    const running = lanes.filter(lane => lane.status === 'in-flight').length;
    const waiting = lanes.filter(lane => lane.status === 'planned').length;
    const trouble = lanes.filter(lane => lane.status === 'failed' || lane.status === 'blocked').length;
    const percent = lanes.length ? Math.round(completed / lanes.length * 100) : 0;
    const legend = [['in-flight','실행 중'],['ready','준비됨'],['planned','대기'],['completed','완료'],['failed','실패'],['blocked','막힘']]
      .map(([status, text]) => '<span class="run-legend-item" data-legend="' + status + '"><i></i>' + text + '</span>').join('');
    return '<section class="mass-run" aria-label="MASS ULW 작업 그래프">' +
      '<div class="mass-run-head"><div><div class="dashboard-eyebrow">PARALLEL WORK</div><div class="mass-run-title">병렬 작업 ' + esc(running) + '개 실행 중 · ' + esc(completed) + '/' + esc(lanes.length) + ' 완료</div></div>' +
      '<div class="badges"><span class="badge">Wave ' + esc(massUlw.currentWave === null ? '—' : massUlw.currentWave + 1) + '</span><span class="badge default">검증 ' + esc(massUlw.verification) + '</span><span class="run-percent">' + esc(percent) + '%</span></div></div>' +
      massUlwProgressHtml({ completed, running, waiting, trouble }, lanes.length) +
      '<div class="run-stats" aria-label="Lane status summary"><span data-stat="running"><strong>' + esc(running) + '</strong> 실행</span><span data-stat="waiting"><strong>' + esc(waiting) + '</strong> 대기</span><span data-stat="completed"><strong>' + esc(completed) + '</strong> 완료</span><span data-stat="trouble" class="' + (trouble ? 'danger-text' : '') + '"><strong>' + esc(trouble) + '</strong> 문제</span></div>' +
      '<div class="run-dag">' + massUlwGraphHtml(lanes, massUlw.currentWave) + '<div class="run-legend" aria-hidden="true">' + legend + '<span class="run-legend-hint">노드에 마우스를 올리면 연결된 의존관계가 강조됩니다</span><span class="run-legend-swipe">옆으로 밀어서 전체 보기 →</span></div></div>' +
      '</section>';
  }

  // Hover/focus a node to highlight its dependency chain. Delegated once so it
  // survives dashboard re-renders; presentation-only.
  (function installMassUlwGraphFocus() {
    if (window.__jkDagFocus) return;
    window.__jkDagFocus = true;
    const clear = graph => {
      graph.classList.remove('is-focus');
      graph.querySelectorAll('.is-focus, .is-related').forEach(el => el.classList.remove('is-focus', 'is-related'));
    };
    const focusNode = node => {
      const graph = node.closest('.run-dag-graph');
      if (!graph) return;
      clear(graph);
      const id = node.getAttribute('data-lane-id');
      graph.classList.add('is-focus');
      node.classList.add('is-focus');
      graph.querySelectorAll('.run-dag-edge').forEach(edge => {
        const from = edge.getAttribute('data-edge-from');
        const to = edge.getAttribute('data-edge-to');
        if (from !== id && to !== id) return;
        edge.classList.add('is-focus');
        const other = graph.querySelector('.run-dag-node[data-lane-id="' + CSS.escape(from === id ? to : from) + '"]');
        if (other) other.classList.add('is-related');
      });
    };
    const leave = event => {
      const node = event.target.closest && event.target.closest('.run-dag-node');
      if (!node || (event.relatedTarget && node.contains(event.relatedTarget))) return;
      const graph = node.closest('.run-dag-graph');
      if (graph) clear(graph);
    };
    const enter = event => {
      const node = event.target.closest && event.target.closest('.run-dag-node');
      if (node) focusNode(node);
    };
    document.addEventListener('mouseover', enter);
    document.addEventListener('focusin', enter);
    document.addEventListener('mouseout', leave);
    document.addEventListener('focusout', leave);
  })();`;
