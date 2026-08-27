export const MASS_ULW_DASHBOARD_SCRIPT = String.raw`  function massUlwStatusHtml(e) {
    const massUlw = e.massUlw;
    if (!massUlw) return '';
    return '<div class="badges" aria-label="MASS ULW execution status">' +
      '<span class="badge" aria-label="Current MASS ULW wave">Wave ' + esc(massUlw.currentWave === null ? '—' : massUlw.currentWave) + '</span>' +
      '<span class="badge active" aria-label="Running MASS ULW lanes">Running ' + esc(massUlw.runningLanes.length ? massUlw.runningLanes.join(', ') : 'none') + '</span>' +
      '<span class="badge warn" aria-label="Blocked MASS ULW dependencies">Blocked ' + esc(massUlw.blockedDependencies.length ? massUlw.blockedDependencies.join(', ') : 'none') + '</span>' +
      '<span class="badge default" aria-label="MASS ULW verification">Verification ' + esc(massUlw.verification) + '</span>' +
      '</div>';
  }`;
