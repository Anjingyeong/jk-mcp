import assert from 'node:assert/strict';
import { EPOCH, ROUTES } from './jk-command-center-fixtures.mjs';
export const PLAYWRIGHT_PATH = 'C:/JK/chatgpt2codex/.local-tools/command-center-audit/node_modules/playwright-core/index.mjs';
export const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// Observation/scheduling only: all render, fetch parsing and event handlers are real.
export function installHooks(epoch = 1788663600000) {
  Date.now = () => epoch;
  const intervals = new Map();
  let nextId = 100000;
  window.setInterval = (callback, ms, ...args) => {
    const id = nextId++;
    intervals.set(id, { name: callback.name || `interval-${ms}`, ms, invoke: () => callback(...args) });
    return id;
  };
  window.clearInterval = id => intervals.delete(id);
  const completed = new Set();
  const required = ['/api/jk/projects', '/api/jk/control/status', '/api/jk/control/execution', '/api/jk/control/goals', '/api/jk/control/approvals', '/api/jk/control/logs', '/api/jk/control/notifications'];
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.ok) completed.add(new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname);
    return response;
  };
  const ready = new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('#content')?.children.length || !required.every(path => completed.has(path))) return;
      clearTimeout(timeout); observer.disconnect();
      document.documentElement.dataset.jkQaReady = 'JK_COMMAND_CENTER_UI_READY';
      resolve('JK_COMMAND_CENTER_UI_READY');
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('QA initial API/render readiness timeout')); }, 10000);
    observer.observe(document, { childList: true, subtree: true });
  });
  window.__jkQA = { ready, intervals: () => [...intervals.values()].map(({ name, ms }) => ({ name, ms })), tick: async name => {
    const matches = [...intervals.values()].filter(item => item.name === name || item.ms === name);
    if (matches.length !== 1) throw new Error(`Expected one interval for ${name}, found ${matches.length}`);
    await matches[0].invoke();
  } };
}

export async function createQaPage(browser, url, { width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(installHooks, EPOCH);
  const externalRequests = [];
  await context.route('**/*', route => {
    const target = new URL(route.request().url());
    if (target.origin !== new URL(url).origin) { externalRequests.push(target.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__jkQA.ready), 'JK_COMMAND_CENTER_UI_READY');
  return { context, page, errors, externalRequests };
}

export async function setCase(page, caseName, { reload = true } = {}) {
  const response = await page.request.post(new URL('/__qa/case', page.url()).href, { data: { caseName } });
  assert.equal(response.status(), 200, await response.text());
  if (reload) { await page.reload({ waitUntil: 'load', timeout: 15000 }); await page.evaluate(() => window.__jkQA.ready); }
}

export async function recordedRequests(page) {
  const response = await page.request.get(new URL('/__qa/state', page.url()).href);
  assert.equal(response.status(), 200);
  return (await response.json()).requests;
}

export async function visitRoute(page, name) {
  assert.ok(ROUTES.includes(name), `Unknown route ${name}`);
  const path = name === 'dashboard' ? '/' : name === 'approvals' ? '/approvals' : `/?page=${name}`;
  await page.goto(new URL(path, page.url()).href, { waitUntil: 'load', timeout: 15000 });
  await page.evaluate(() => window.__jkQA.ready);
}

// The initial viewport must expose the incoming approval action, not bury it
// below deployment and executor panels. No copy pins or UI mirror implementation.
export async function regressionAttentionNavigation(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setCase(page, 'quiet-active');
  await visitRoute(page, 'dashboard');
  await setCase(page, 'active', { reload: false });
  await page.evaluate(() => window.__jkQA.tick('refreshSignals'));
  const selector = '#dashboard-approvals-root button, #open-approvals, [data-attention-action=approvals]';
  const action = await page.evaluate(selector => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }, selector);
  assert.ok(action, 'Incoming approval must expose a dashboard attention action');
  assert.ok(action.width > 0 && action.height > 0 && action.top >= 0 && action.left >= 0 && action.right <= action.viewportWidth && action.bottom <= action.viewportHeight, `Approval attention action must be reachable without scrolling: ${JSON.stringify(action)}`);
  await page.evaluate(selector => {
    // Subscribe before clicking. DOM navigation is synchronous; observer resolves
    // after the actual render. Timer is only a bounded failure deadline.
    window.__jkQA.action = new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (location.pathname === '/approvals' && document.querySelector('[data-approval-id=qa-approval-1]')) {
          observer.disconnect(); clearTimeout(timeout); resolve(true);
        }
      });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Approval navigation did not render the fixture approval')); }, 10000);
      observer.observe(document, { childList: true, subtree: true });
      document.querySelector(selector).click();
    });
  }, selector);
  await page.evaluate(() => window.__jkQA.action);
  assert.equal(new URL(page.url()).pathname, '/approvals');
  assert.equal((await recordedRequests(page)).filter(request => request.method !== 'GET').length, 0, 'Navigation must not approve or execute work');
  return { contract: 'incoming approval above fold and navigable without writes', action };
}

export async function regressionMobileChromeStability(browser, url) {
  const context = await browser.newContext({ viewport: { width: 375, height: 900 }, isMobile: true, hasTouch: true });
  await context.addInitScript(installHooks, EPOCH);
  const page = await context.newPage();
  let release;
  const pendingStatus = new Promise(resolve => { release = resolve; });
  try {
    await page.route('**/api/jk/control/status', async route => {
      await pendingStatus;
      await route.continue();
    });
    await page.goto(url, { waitUntil: 'load' });
    const before = await page.locator('#content').boundingBox();
    release();
    await page.evaluate(() => window.__jkQA.ready);
    const after = await page.locator('#content').boundingBox();
    assert.ok(before && after, 'The main content region must exist before and after initial data');
    assert.equal(after.y, before.y, 'Mobile chrome must not move content when approval and active navigation state arrive');
    return { contract: 'stable mobile chrome while initial data arrives', beforeY: before.y, afterY: after.y };
  } finally {
    release();
    await context.close();
  }
}

export async function regressionExecutionRefresh(page) {
  await setCase(page, 'quiet-active');
  await visitRoute(page, 'dashboard');
  await page.evaluate(() => { window.__qaWorkNode = document.querySelector('[data-dashboard-region="work"]'); });
  await page.evaluate(() => window.__jkQA.tick('refreshExecution'));
  assert.equal(await page.evaluate(() =>
    window.__qaWorkNode === document.querySelector('[data-dashboard-region="work"]')),
  true, 'An unchanged execution poll must preserve the current workspace DOM');
  const response = await page.request.get(new URL('/__qa/state', page.url()).href);
  const { fixture } = await response.json();
  fixture.execution.execution.pendingCount += 1;
  const changedCount = fixture.execution.execution.pendingCount;
  await page.request.post(new URL('/__qa/patch', page.url()).href, { data: { execution: fixture.execution } });
  await page.evaluate(() => window.__jkQA.tick('refreshExecution'));
  assert.equal(await page.locator('.work-counts strong').nth(1).textContent(), String(changedCount));
  return { contract: 'unchanged execution preserves DOM; changed execution updates counts', changedCount };
}
