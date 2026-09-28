import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CASES, ROUTES, EPOCH, fixture } from './jk-command-center-fixtures.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const READY = 'JK_COMMAND_CENTER_QA_READY';

// Imports HTML only: never runtime code, jobs, user state, or secrets.
export async function startQaServer({ source = 'src', caseName = 'active', html } = {}) {
  if (!['src', 'dist', 'baseline'].includes(source)) throw new Error(`Unknown source: ${source}`);
  const modulePath = source === 'baseline' ? '.omo/evidence/jk-command-center/baseline/ui.ts' : `${source}/control-center/ui.${source === 'src' ? 'ts' : 'js'}`;
  const moduleUrl = pathToFileURL(resolve(root, modulePath)).href;
  // Bun rewrites non-ASCII raw-template text. Production runs Node, so import
  // the built module in Node to preserve the actual shipped HTML bytes.
  const realHtml = html ?? (source === 'dist'
    ? (await promisify(execFile)('node', ['--input-type=module', '--eval',
      'const module = await import(process.argv[1]); process.stdout.write(module.CONTROL_CENTER_HTML);',
      moduleUrl], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })).stdout
    : (await import(moduleUrl)).CONTROL_CENTER_HTML);
  if (typeof realHtml !== 'string') throw new Error('Missing CONTROL_CENTER_HTML export');
  let currentCase = caseName;
  let data = fixture(caseName);
  const requests = [];
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (req.headers.has('origin') && req.headers.get('origin') !== url.origin) return json({ ok: false, error: 'QA origin mismatch' }, 403);
    if (path === '/__qa/ready') return json({ sentinel: READY, source, caseName: currentCase, cases: CASES, routes: ROUTES, epoch: EPOCH });
    if (path === '/__qa/state' && req.method === 'GET') return json({ caseName: currentCase, fixture: data, requests });
    let body = null;
    if (!['GET', 'HEAD'].includes(req.method)) {
      try { body = await req.json(); }
      catch (error) { return json({ ok: false, error: `Invalid JSON: ${error.message}` }, 400); }
    }
    if (path === '/__qa/case' && req.method === 'POST') {
      if (!CASES.includes(body?.caseName)) return json({ ok: false, error: 'Unknown case', cases: CASES }, 400);
      currentCase = body.caseName; data = fixture(currentCase); requests.length = 0;
      return json({ ok: true, caseName: currentCase });
    }
    if (path === '/__qa/patch' && req.method === 'POST') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !Object.hasOwn(data, key))) return json({ ok: false, error: 'Expected fixture envelope keys' }, 400);
      Object.assign(data, body); return json({ ok: true });
    }
    if (path.startsWith('/api/')) {
      const record = { sequence: requests.length + 1, method: req.method, path: path + url.search, body, handled: true };
      requests.push(record);
      const readRoutes = { '/api/jk/projects': 'projects', '/api/jk/roles': 'roles', '/api/jk/control/status': 'status', '/api/jk/control/execution': 'execution', '/api/jk/control/goals': 'goals', '/api/jk/control/approvals': 'approvals', '/api/jk/control/logs': 'logs', '/api/jk/control/notifications': 'notifications' };
      if (req.method === 'GET' && readRoutes[path]) return json(data[readRoutes[path]]);
      if (req.method === 'GET' && path === '/api/jk/roles/export') return json({ ok: true, bundle: { version: 1, roles: data.roles.roles.filter(role => !role.builtIn) } });
      const match = path.match(/^\/api\/jk\/control\/approvals\/([^/]+)$/);
      if (req.method === 'POST' && match) {
        const approval = data.approvals.approvals.find(item => item.id === decodeURIComponent(match[1]));
        if (!approval) return json({ ok: false, error: 'Synthetic approval not found' }, 404);
        if (!['approve', 'deny', 'supervise'].includes(body?.decision)) return json({ ok: false, error: 'Invalid decision' }, 400);
        data.approvals.approvals = data.approvals.approvals.filter(item => item !== approval);
        return json({ ok: true, approval: { ...approval, status: body.decision === 'deny' ? 'denied' : 'approved' }, job: null });
      }
      const write = fixtureWrite(data, req.method, path, body, requests.length);
      if (write) return json(write.body, write.status ?? 200);
      record.handled = false;
      return json({ ok: false, error: `Unimplemented fixture API: ${req.method} ${path}` }, 501);
    }
    if (req.method === 'GET' && (path === '/' || path === '/approvals')) return new Response(realHtml, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" } });
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    return json({ ok: false, error: 'No fixture route' }, 404);
  } });
  return { url: `http://127.0.0.1:${server.port}`, source, sentinel: READY, stop: () => server.stop(true) };
}

function fixtureWrite(data, method, path, body, sequence) {
  const ok = body => ({ body: { ok: true, ...body } });
  if (method === 'POST' && path === '/api/jk/control/notifications') {
    Object.assign(data.notifications.notifications, body); return ok(data.notifications);
  }
  if (method === 'POST' && path === '/api/jk/control/notifications/test') return ok({ delivered: true });
  if (method === 'POST' && path === '/api/jk/control/executors/windows-main/token') return ok({ executorId: 'windows-main', token: 'QA_SYNTHETIC_NOT_A_REAL_TOKEN' });
  if (method === 'POST' && path === '/api/jk/control/executors/routes') {
    data.status.executors.routes[body.projectId] = body.executorId; return ok(body);
  }
  const activate = path.match(/^\/api\/jk\/control\/projects\/([^/]+)\/activate$/);
  if (method === 'POST' && activate) {
    const projectId = decodeURIComponent(activate[1]);
    const project = data.projects.projects.find(item => item.projectId === projectId);
    if (!project) return { status: 404, body: { ok: false, error: 'Synthetic project not found' } };
    data.projects.activeProjectId = projectId;
    Object.assign(data.status.session, { activeProjectId: projectId, leasePreset: body.preset });
    return ok({ project, lease: { preset: body.preset, expiresAt: EPOCH + 900000 }, roleContext: data.roles.activeRoleContext });
  }
  const roleMatch = path.match(/^\/api\/jk\/roles\/([^/]+)$/);
  if ((method === 'POST' && path === '/api/jk/roles') || (method === 'PUT' && roleMatch)) {
    const role = { ...body, id: roleMatch ? decodeURIComponent(roleMatch[1]) : `qa-created-${sequence}`, builtIn: false };
    data.roles.roles = [...data.roles.roles.filter(item => item.id !== role.id), role];
    return { ...ok({ role }), status: method === 'POST' ? 201 : 200 };
  }
  if (method === 'DELETE' && roleMatch) {
    const roleId = decodeURIComponent(roleMatch[1]);
    data.roles.roles = data.roles.roles.filter(item => item.id !== roleId); return ok({ roleId });
  }
  if (method === 'POST' && path === '/api/jk/roles/import') {
    if (!Array.isArray(body?.roles)) return { status: 400, body: { ok: false, error: 'Expected role bundle' } };
    data.roles.roles.push(...body.roles.map(role => ({ ...role, builtIn: false }))); return ok({ imported: body.roles.length });
  }
  const selected = path.match(/^\/api\/jk\/projects\/([^/]+)\/(role|default-role)$/);
  if (method === 'POST' && selected) {
    const role = data.roles.roles.find(item => item.id === body.roleId);
    if (!role) return { status: 404, body: { ok: false, error: 'Synthetic role not found' } };
    if (selected[2] === 'default-role') data.roles.activeRoleContext.defaultRoleId = role.id;
    else Object.assign(data.roles.activeRoleContext, { role, selectionSource: 'last-used', effectivePermission: role.permissionPreset });
    return ok({ role, context: data.roles.activeRoleContext });
  }
  if (method === 'POST' && path === '/api/jk/control/deployment/sync') {
    const approval = { ...fixture('active').approvals.approvals[0], id: 'qa-deploy-approval', commandPreview: 'bash scripts/sync-jk-oci.sh --reload-current' };
    const reused = data.approvals.approvals.some(item => item.id === approval.id);
    if (!reused) data.approvals.approvals.push(approval);
    return { ...ok({ status: 'pending', approvalId: approval.id, job: null, reused }), status: 202 };
  }
  return null;
}

if (import.meta.main) {
  const server = await startQaServer({ source: process.argv[2] ?? 'src', caseName: process.argv[3] ?? 'active' });
  console.log(`${READY} ${JSON.stringify({ url: server.url, source: server.source, epoch: EPOCH })}`);
}
