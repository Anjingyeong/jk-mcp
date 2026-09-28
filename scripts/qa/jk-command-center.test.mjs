import { test, expect } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startQaServer, READY } from './jk-command-center-server.mjs';
import { CASES, ROUTES } from './jk-command-center-fixtures.mjs';
import { ExecutionTargetSchema } from '../../src/executors/target-protocol.ts';

async function withServer(run) {
  const server = await startQaServer();
  try { await run(server); } finally { server.stop(); }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
const get = url => fetch(url, { signal: AbortSignal.timeout(10000) });

test('serves real HTML on every frontend route when isolated server starts', () => withServer(async server => {
  // Given imported UI, when each route is requested, then shipped bytes match.
  const { CONTROL_CENTER_HTML } = await import('../../src/control-center/ui.ts');
  const readiness = await (await get(server.url + '/__qa/ready')).json();
  expect(readiness.sentinel).toBe(READY);
  expect(new URL(server.url).hostname).toBe('127.0.0.1');
  for (const route of ROUTES) {
    const path = route === 'dashboard' ? '/' : route === 'approvals' ? '/approvals' : '/?page=' + route;
    const response = await get(server.url + path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CONTROL_CENTER_HTML);
  }
}));

test('switches explicit cases without leaking previous requests or fixtures', () => withServer(async server => {
  // Given populated state, when fixtures switch, then each case is isolated.
  for (const caseName of CASES) {
    expect((await post(server.url + '/__qa/case', { caseName })).status).toBe(200);
    const state = await (await get(server.url + '/__qa/state')).json();
    expect(state.caseName).toBe(caseName);
    expect(state.requests).toEqual([]);
    expect(state.fixture.approvals.approvals.length).toBe(['empty', 'quiet-active'].includes(caseName) ? 0 : 1);
    if (caseName === 'offline-worker') expect(state.fixture.status.executors.items[0].online).toBe(false);
    if (caseName === 'verification-failure') expect(state.fixture.execution.execution.verificationStatus).toBe('fail');
    if (caseName !== 'empty') {
      expect(state.fixture.status.executors.local.platform).toBe('linux/arm64');
      expect(state.fixture.status.executors.items[0].platform).toBe('win32/x64');
    }
  }
}));

test('joins active approval to a schema-valid persisted local job target', () => withServer(async server => {
  // Given active work, when approval evidence is read, then its job carries the local target.
  const envelope = await (await get(server.url + '/api/jk/control/approvals')).json();
  const approval = envelope.approvals.find(item => item.id === 'qa-approval-1');
  const jobs = envelope.jobs.filter(job => job.approvalId === approval.id);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ projectId: 'qa-oci', status: 'pending', executionKind: 'local-shell', commandPreview: approval.commandPreview, createdAt: approval.createdAt, expiresAt: approval.expiresAt });
  expect(ExecutionTargetSchema.parse(jobs[0].executionTarget)).toEqual({
    kind: 'local', protocolVersion: 1, executorId: 'local', instanceId: 'qa-oci-instance',
    workspaceRoot: '/srv/qa', projectId: 'qa-oci', sourceProjectId: 'qa-oci', projectRoot: '/srv/qa/orbit-api',
  });
}));

test('keeps offline Windows work and its approval target separate from active OCI work', () => withServer(async server => {
  // Given repeated case switches, when each case is loaded, then no target or active context leaks.
  for (const caseName of ['offline-worker', 'active', 'quiet-active', 'empty']) {
    expect((await post(server.url + '/__qa/case', { caseName })).status).toBe(200);
    const { fixture } = await (await get(server.url + '/__qa/state')).json();
    const pending = fixture.approvals.jobs.filter(job => job.approvalId === 'qa-approval-1');
    if (caseName === 'quiet-active' || caseName === 'empty') {
      expect(pending).toEqual([]);
      expect(fixture.approvals.approvals).toEqual([]);
      continue;
    }
    const offline = caseName === 'offline-worker';
    const projectId = offline ? 'qa-windows' : 'qa-oci';
    expect(fixture.projects.activeProjectId).toBe(projectId);
    expect(fixture.status.session.activeProjectId).toBe(projectId);
    expect(fixture.execution.execution.projectId).toBe(projectId);
    expect(fixture.goals.goals[0].projectId).toBe(projectId);
    expect(fixture.goals.goals[0].currentTask).toBe(fixture.execution.execution.task);
    expect(fixture.approvals.approvals[0].projectId).toBe(projectId);
    expect(fixture.status.executors.items[0].online).toBe(!offline);
    expect(pending).toHaveLength(1);
    expect(pending[0].projectId).toBe(projectId);
    expect(ExecutionTargetSchema.parse(pending[0].executionTarget)).toEqual(offline ? {
      kind: 'remote', protocolVersion: 1, executorId: 'windows-main', instanceId: 'qa-windows-instance',
      workspaceRoot: 'C:\\QA', projectId: 'qa-windows', sourceProjectId: 'qa-windows', projectRoot: 'C:\\QA\\Windows Studio',
    } : {
      kind: 'local', protocolVersion: 1, executorId: 'local', instanceId: 'qa-oci-instance',
      workspaceRoot: '/srv/qa', projectId: 'qa-oci', sourceProjectId: 'qa-oci', projectRoot: '/srv/qa/orbit-api',
    });
    if (offline) expect(fixture.status.executors.routes[projectId]).toBe('windows-main');
  }
}));

test('allows missing persisted target evidence through the fixture patch endpoint', () => withServer(async server => {
  // Given a joined job, when its optional target is omitted, then Unknown evidence remains testable.
  const envelope = await (await get(server.url + '/api/jk/control/approvals')).json();
  const job = envelope.jobs.find(item => item.approvalId === 'qa-approval-1');
  delete job.executionTarget;
  expect((await post(server.url + '/__qa/patch', { approvals: envelope })).status).toBe(200);
  const patched = await (await get(server.url + '/api/jk/control/approvals')).json();
  expect(patched.approvals[0].id).toBe('qa-approval-1');
  const joined = patched.jobs.find(item => item.approvalId === 'qa-approval-1');
  expect(joined.id).toBe(job.id);
  expect(Object.hasOwn(joined, 'executionTarget')).toBe(false);
}));

test('records approval decisions without creating or executing jobs', () => withServer(async server => {
  // Given one approval, when approved, then only fixture state and ledger change.
  const before = await (await get(server.url + '/__qa/state')).json();
  const response = await post(server.url + '/api/jk/control/approvals/qa-approval-1', { decision: 'approve' });
  expect(response.status).toBe(200);
  expect((await response.json()).job).toBeNull();
  const after = await (await get(server.url + '/__qa/state')).json();
  expect(after.fixture.approvals.approvals).toEqual([]);
  expect(after.fixture.approvals.jobs).toEqual(before.fixture.approvals.jobs);
  expect(after.requests).toEqual([{ sequence: 1, method: 'POST', path: '/api/jk/control/approvals/qa-approval-1', body: { decision: 'approve' }, handled: true }]);
}));

test('persists synthetic role writes through the real API envelope', () => withServer(async server => {
  // Given dialog payload, when saved, then the next role read contains it.
  const body = { name: 'QA Created', description: '', instructions: '', permissionPreset: 'read-only', workflowPreference: '', tools: ['file_read'], skills: [] };
  const response = await post(server.url + '/api/jk/roles', body);
  expect(response.status).toBe(201);
  const saved = await response.json();
  const read = await (await get(server.url + '/api/jk/roles?projectId=qa-oci')).json();
  expect(read.roles.find(role => role.id === saved.role.id)).toEqual({ ...body, id: saved.role.id, builtIn: false });
}));

test('rejects unknown API seams rather than masking contract mismatches', () => withServer(async server => {
  // Given unsupported route, when called, then the ledger exposes it as unhandled.
  expect((await post(server.url + '/api/jk/unknown', {})).status).toBe(501);
  const state = await (await get(server.url + '/__qa/state')).json();
  expect(state.requests[0].handled).toBe(false);
}));

test('rejects cross-origin control writes', () => withServer(async server => {
  // Given active case, when a foreign origin writes, then state stays active.
  const response = await fetch(server.url + '/__qa/case', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ caseName: 'empty' }), signal: AbortSignal.timeout(10000) });
  expect(response.status).toBe(403);
  expect((await (await get(server.url + '/__qa/state')).json()).caseName).toBe('active');
}));

test('serves production HTML with the same bytes as the Node runtime', async () => {
  const moduleUrl = new URL('../../dist/control-center/ui.js', import.meta.url).href;
  const { stdout } = await promisify(execFile)('node', [
    '--input-type=module', '--eval',
    'const module = await import(process.argv[1]); process.stdout.write(module.CONTROL_CENTER_HTML);',
    moduleUrl,
  ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const server = await startQaServer({ source: 'dist' });
  try {
    expect(await (await get(server.url)).text()).toBe(stdout);
  } finally {
    server.stop();
  }
});
