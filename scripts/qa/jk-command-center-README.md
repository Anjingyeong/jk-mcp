# JK isolated browser QA

No package dependencies added. Server uses Bun; browser helpers accept an existing
Playwright Page/Browser. No Chrome is launched by these modules. API data is
synthetic, writes affect memory only, unknown APIs return 501, and CSP blocks
external connections. Parent owns hands-on browser checks and screenshots.

## Start

From C:/JK/chatgpt2codex:

    bun scripts/qa/jk-command-center-server.mjs src active

Stdout begins with `JK_COMMAND_CENTER_QA_READY` followed by JSON containing `url`.
Port is ephemeral. Use `dist` for final built QA or `baseline` for the preserved
HEAD source under .omo/evidence/jk-command-center/baseline. HTML is snapshotted
at startup: restart the server after source/build changes.

Final QA requires `npm run build` first. In `dist` mode the harness imports the
compiled module in Node, matching the production runtime byte-for-byte. Bun's
raw-template transformation can escape non-ASCII text in source previews; those
previews are not the authority for final Korean typography.
Use separate server instances for state-changing interaction tests and Lighthouse
so fixture mutations cannot affect an audit in progress.

Persistent Bun kernel:

```js
var { startQaServer } = await import('file:///C:/JK/chatgpt2codex/scripts/qa/jk-command-center-server.mjs');
var qaServer = await startQaServer({ source: 'src', caseName: 'active' });
qaServer.url; // give this to the parent browser bridge
// qaServer.stop() at teardown
```

Existing Node browser bridge / Playwright context:

```js
var qa = await import('file:///C:/JK/chatgpt2codex/scripts/qa/jk-command-center-browser.mjs');
var session = await qa.createQaPage(browser, fixtureUrl);
var page = session.page;
await qa.setCase(page, 'offline-worker');
await qa.visitRoute(page, 'projects');
await qa.visitRoute(page, 'roles');
await page.locator('#create-role').click(); // real native role dialog
await qa.recordedRequests(page);
// await session.context.close() at teardown
```

For an already-created page, install hooks before navigation:

```js
await page.addInitScript(qa.installHooks, 1788663600000);
await page.goto(fixtureUrl, { waitUntil: 'load' });
await page.evaluate(() => window.__jkQA.ready);
```

UI sentinel: `JK_COMMAND_CENTER_UI_READY`, also exposed as
`document.documentElement.dataset.jkQaReady`. Readiness observes DOM mutations
before the real application loads and requires initial successful API responses.
Date.now is fixed. App intervals register but never run by wall clock:

```js
await page.evaluate(() => window.__jkQA.intervals());
await page.evaluate(() => window.__jkQA.tick('refreshSignals'));
await page.evaluate(() => window.__jkQA.tick('refreshExecution'));
```

These await actual application callbacks, not reimplemented UI logic. Animation
callbacks and timeout deadlines remain native. There are no fixed sleeps.

## HTTP controls

- GET /__qa/ready: sentinel, source, available cases/routes, epoch.
- POST /__qa/case with `{caseName: 'active'}` as JSON: replace fixture and clear ledger.
- GET /__qa/state: `{caseName, fixture, requests}` with method/path/body/handled records.
- POST /__qa/patch: replace selected complete API envelopes, e.g.
  `{approvals: {ok: true, approvals: [], jobs: []}}` as JSON. Does not trigger UI
  rendering: invoke the appropriate actual refresh callback afterwards.

Cases: active, quiet-active, empty, offline-worker, verification-failure, long-ko.
Routes: dashboard, projects, approvals, logs, system, roles, skills, guide, goals.
Routes use /?page=NAME except dashboard (/) and approvals (/approvals).

## Behavioral red/green regression

```js
await qa.regressionAttentionNavigation(page);
await qa.regressionMobileChromeStability(browser, fixtureUrl);
await qa.regressionExecutionRefresh(page);
```

Starts with active work and no approval, introduces one approval without reload,
then invokes the real signal refresh. The dashboard attention action must be
inside the 1440x900 initial viewport and navigate to that exact approval without
issuing a write. Baseline puts the action below unrelated deployment, links and
executor panels; the failure should report an offscreen bounding rectangle.
Assertions are geometry plus navigation, never prose or a mirrored renderer.
Selectors accept the original approval root/button or data-attention-action=approvals.
Parent executes red/green in the real browser; the child does not launch a browser.

The mobile stability check holds the initial status response, then verifies that
loading approval/navigation state does not move the content origin. The execution
refresh check preserves workspace DOM on identical responses and verifies that a
changed pending count still reaches the actual UI.

## Validation and dependencies

    npm run build
    bun test scripts/qa/jk-command-center.test.mjs

Playwright: C:/JK/chatgpt2codex/.local-tools/command-center-audit/node_modules/playwright-core/index.mjs

Chrome: C:/Program Files/Google/Chrome/Application/chrome.exe

UI Set default posts /api/jk/projects/:projectId/default-role, matching the
backend contract. The real-route regression in src/roles/http.test.ts executes
the handler from the exported HTML and checks persisted and refreshed default
role context. Run it with:

    node node_modules/vitest/vitest.mjs run src/roles/http.test.ts --maxWorkers=1 --minWorkers=1

This harness still implements only the backend contract: unknown APIs return
501 rather than a false pass.
