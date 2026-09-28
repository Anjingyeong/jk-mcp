export const EPOCH = Date.UTC(2026, 8, 6, 3, 0, 0);
export const CASES = ['active', 'quiet-active', 'empty', 'offline-worker', 'verification-failure', 'long-ko'];
export const ROUTES = ['dashboard', 'projects', 'approvals', 'logs', 'system', 'roles', 'skills', 'guide', 'goals'];

// Identifiers, paths, commands and account-looking values are all synthetic.
export function fixture(name = 'active') {
  if (!CASES.includes(name)) throw new Error(`Unknown QA case: ${name}`);
  const projects = [
    { projectId: 'qa-oci', name: 'Orbit API', root: '/srv/qa/orbit-api', branch: 'qa/command-center', dirty: false, executorKind: 'local', executorId: 'oci-main' },
    { projectId: 'qa-windows', name: 'Windows Studio', root: 'C:\\QA\\Windows Studio', branch: 'qa/desktop', dirty: true, executorKind: 'remote', executorId: 'windows-main' },
  ];
  const roles = [
    { id: 'qa-reviewer', name: 'QA Reviewer', description: 'Synthetic review role', builtIn: true, permissionPreset: 'read-only', instructions: 'Inspect the synthetic project.', tools: ['code_search', 'file_read', 'tests', 'browser'], skills: ['browser-qa', 'typescript'], workflowPreference: 'discover -> verify -> review' },
    { id: 'qa-custom', name: 'QA Custom', description: 'Editable synthetic role', builtIn: false, permissionPreset: 'tests-only', instructions: 'Validate fixtures.', tools: ['file_read', 'tests'], skills: ['deterministic-qa'], workflowPreference: 'verify -> review' },
  ];
  const roleContext = { role: roles[0], defaultRoleId: roles[0].id, selectionSource: 'auto', effectivePermission: 'read-only', projectPermission: 'full-write', rolePermission: 'read-only' };
  const approval = { id: 'qa-approval-1', projectId: 'qa-oci', commandPreview: 'node scripts/qa-synthetic-check.mjs --network-fixture', createdAt: EPOCH - 20000, expiresAt: EPOCH + 280000, needsNetwork: true, destructive: false, reason: 'Synthetic approval; no command can run in this harness.', taskIdentity: 'qa-task-1', workSessionId: 'qa-session-1' };
  const execution = { projectId: 'qa-oci', projectName: projects[0].name, goal: 'Release the synthetic command center', task: 'Validate approval navigation and worker boundaries', mode: 'implement', modeSource: 'loop', phase: 'verify', primaryStage: 'verifier', supportingStages: ['reviewer'], massUlw: null, verificationStatus: 'unknown', failureCount: 0, completedCount: 4, pendingCount: 2, lastProgressSummary: 'Four checks complete; approval remains pending.', updatedAt: EPOCH - 10000, recoveryNeeded: false, lastVerificationFailed: false };
  const result = {
    projects: { ok: true, projects, activeProjectId: 'qa-oci' },
    status: { ok: true,
      runtime: { name: 'JK', pid: 4242, node: 'v22.0.0-qa', platform: 'linux/arm64', mode: 'qa-fixture', runtimeRoot: '/srv/qa/jk', workspaceRoot: '/srv/qa', stateDir: '/srv/qa/state', uptimeSec: 3600, schema: { status: 'ok', reasons: [] } },
      session: { activeProjectId: 'qa-oci', mode: 'implement', leasePreset: 'read-only', leaseExpiresAt: EPOCH + 900000 }, roleContext,
      executors: { local: { executorId: 'oci-main', label: 'OCI Hub', online: true, platform: 'linux/arm64', workspaceRoot: '/srv/qa', projectCount: 1 }, items: [{ executorId: 'windows-main', label: 'Windows Workstation', online: true, platform: 'win32/x64', workspaceRoot: 'C:\\QA', lastSeenAtMs: EPOCH - 1000, projects: [projects[1]] }], routes: { 'qa-windows': 'windows-main' } },
      quickLinks: [{ title: 'Fixture release', href: '/?page=system', note: 'Local fixture only', badge: 'QA', badgeClass: 'default' }],
      deployment: { state: 'synced', upstreamSha: 'abc12345abc12345', deployedSha: 'abc12345abc12345', lastSyncAtMs: EPOCH - 1800000, build: 'pass', health: 'pass', tunnel: 'pass' } },
    execution: { ok: true, execution, effectivePermission: 'read-only', projectPermission: 'full-write' },
    approvals: { ok: true, approvals: [approval], jobs: [{ id: 'qa-job-history', projectId: 'qa-oci', commandPreview: 'node --version', status: 'succeeded', createdAt: EPOCH - 120000, startedAt: EPOCH - 119000, finishedAt: EPOCH - 118000, exitCode: 0 }] },
    goals: { ok: true, goals: [{ projectId: 'qa-oci', projectName: projects[0].name, loopId: 'qa-loop-1', currentGoal: execution.goal, currentTask: execution.task, active: true, updatedAt: EPOCH - 10000, pending: ['Review approval', 'Verify keyboard navigation'], completed: ['Inspect', 'Plan', 'Implement', 'Test'] }] },
    logs: { ok: true, logs: [{ ts: EPOCH - 10000, type: 'qa.verification.started', projectId: 'qa-oci', detail: 'Synthetic verification started' }, { ts: EPOCH - 20000, type: 'qa.approval.requested', projectId: 'qa-oci', detail: 'Synthetic approval queued' }] },
    notifications: { ok: true, notifications: { enabled: false, baseUrl: 'http://127.0.0.1', topic: 'qa-synthetic-topic', clickUrl: '/' } },
    roles: { ok: true, roles, activeRoleContext: roleContext, workflowPresets: [{ id: 'qa-review', name: 'QA Review', preference: 'discover -> verify -> review' }] },
  };
  if (name === 'quiet-active') result.approvals.approvals = [];
  if (name === 'offline-worker') {
    result.status.executors.items[0].online = false;
    result.status.executors.items[0].lastSeenAtMs = EPOCH - 3600000;
    result.projects.activeProjectId = projects[1].projectId;
    result.status.session.activeProjectId = projects[1].projectId;
    approval.projectId = projects[1].projectId;
    Object.assign(execution, { projectId: projects[1].projectId, projectName: projects[1].name, task: 'Validate approval navigation on the routed Windows worker' });
    Object.assign(result.goals.goals[0], { projectId: projects[1].projectId, projectName: projects[1].name, currentTask: execution.task });
    result.logs.logs.forEach(log => { log.projectId = projects[1].projectId; });
  }
  if (name === 'verification-failure') {
    Object.assign(execution, { verificationStatus: 'fail', lastVerificationFailed: true, failureCount: 1, lastProgressSummary: 'Synthetic assertion failed: worker identity differs from selected route.' });
    result.logs.logs.unshift({ ts: EPOCH, type: 'qa.verification.failed', projectId: 'qa-oci', detail: execution.lastProgressSummary });
  }
  if (name === 'long-ko') {
    projects[0].name = '한국어 프로젝트 승인 및 실행 상태 확인을 위한 아주 긴 프로젝트 이름';
    projects[0].root = '/srv/qa/' + '매우긴프로젝트경로_공백없는경계조건/'.repeat(7);
    projects[1].root = 'C:\\QA\\' + '한국어 Windows 프로젝트 경로\\'.repeat(5);
    execution.projectName = projects[0].name;
    execution.task = '한국어와 English가 함께 있는 긴 작업 제목으로 승인 요청과 진행 상태 및 줄바꿈을 검증합니다 '.repeat(3);
    approval.commandPreview = 'node "' + projects[0].root + 'synthetic-check.mjs" --fixture-only';
    approval.reason = '이 승인은 실제 실행되지 않는 합성 요청이며 긴 한국어 설명과 경로의 줄바꿈을 확인합니다. '.repeat(4);
  }
  if (name === 'empty') {
    result.projects = { ok: true, projects: [], activeProjectId: null };
    result.status.session = { activeProjectId: null, mode: null, leasePreset: null, leaseExpiresAt: null };
    result.status.roleContext = null;
    result.status.executors.items = [];
    result.status.executors.local.projectCount = 0;
    result.status.executors.routes = {};
    result.status.quickLinks = [];
    result.status.deployment = null;
    Object.assign(execution, { projectId: null, projectName: null, goal: null, task: null, mode: null, modeSource: 'idle', phase: null, primaryStage: null, supportingStages: [], completedCount: 0, pendingCount: 0, lastProgressSummary: null });
    result.approvals = { ok: true, approvals: [], jobs: [] };
    result.goals.goals = [];
    result.logs.logs = [];
  }
  if (result.approvals.approvals.length) {
    const project = projects.find(project => project.projectId === approval.projectId);
    const remote = project.executorKind === 'remote';
    // PublicLocalShellJobRecord preserves this persisted target and approvalId.
    // Local targets use executorId "local", not the hub's display ID "oci-main".
    result.approvals.jobs.unshift({
      id: 'qa-job-pending', approvalId: approval.id, projectId: approval.projectId,
      commandPreview: approval.commandPreview, executionKind: 'local-shell',
      cwd: project.root, reason: approval.reason, taskIdentity: approval.taskIdentity,
      workSessionId: approval.workSessionId, needsNetwork: approval.needsNetwork,
      destructive: approval.destructive, timeoutSec: null, writesWorkspace: false,
      createdAt: approval.createdAt, expiresAt: approval.expiresAt, status: 'pending',
      executionTarget: {
        kind: remote ? 'remote' : 'local', protocolVersion: 1,
        executorId: remote ? 'windows-main' : 'local',
        instanceId: remote ? 'qa-windows-instance' : 'qa-oci-instance',
        workspaceRoot: remote ? 'C:\\QA' : '/srv/qa',
        projectId: project.projectId, sourceProjectId: project.projectId, projectRoot: project.root,
      },
    });
  }
  return result;
}
