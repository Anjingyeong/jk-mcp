<p align="center">
  <img src="assets/readme-hero.png" alt="JK local coding bridge" width="100%" />
</p>

# JK

**Give ChatGPT real hands on your computer: it reads your code, edits files, runs tests, and shows you the evidence, while JK remembers the work and keeps it safe.**

[English](README.md) | [한국어](README.ko.md)

JK is a free local MCP app designed and built by **Anjingyeong**. Install it, pick a project folder, and connect it to ChatGPT. From then on the chat you already use can work on your real project instead of only talking about it.

> JK is an independent project and is not affiliated with or endorsed by OpenAI. OpenAI, ChatGPT, GPT, and Codex are marks or products of OpenAI.

## Why JK exists

ChatGPT is good at reasoning about code, but on its own it can't see your repository, can't run your tests, and forgets where it left off. The usual workaround is copying files into the chat and pasting answers back. That's slow, error-prone, and you never know whether the suggested fix actually works.

JK was built to close that gap without adding another AI subscription:

- **ChatGPT keeps doing the thinking.** JK is not a model. It is the local execution layer, so you keep using the ChatGPT plan you already have.
- **Work continues across turns.** JK stores the goal, touched files, decisions, and verification results, so "continue what you were doing" means exactly that.
- **Results come with proof.** Changes are verified by running your own commands, and the output is shown back instead of a "should work now".
- **Your machine stays yours.** Access is limited to the folder you choose, risky actions wait for your approval, and secrets are redacted.

## Why use it

| Without JK | With JK |
|---|---|
| Copy files into the chat, paste answers back | ChatGPT reads and edits the files directly |
| "This should fix it" | The fix is tested and the passing output is shown |
| A new chat starts from zero | The previous task, files, and decisions are resumed |
| One long change on your working copy | Work in an isolated task workspace, publish only verified changes |
| No idea what an agent is doing | Live Control Center with a dependency graph of parallel work |

## Download

Get the app from the [Releases page](https://github.com/Anjingyeong/jk-mcp/releases). Node.js, cloudflared, and ripgrep are bundled, so no terminal is needed.

| OS | File |
|---|---|
| Windows | `JK-...-windows-setup.exe` |
| macOS | `jk-....pkg` |

The installers are not code-signed yet. If Windows SmartScreen appears, choose **More info → Run anyway** only when the file came from the official Releases page.

### Prefer the terminal?

With Node.js 22+ installed, one command sets everything up and prints the connector URL, Control Center link, and health check (Ctrl+click to open):

```bash
npx -y jk-mcp setup
```

Run the same command next time; it reuses your folder and connection code. `jk start` also works after `npm install -g jk-mcp`.

## Quick start

1. Install and open **JK**. The tray icon appears near the clock (menu bar on macOS).
2. Open **Settings...** and choose the project folder ChatGPT may work in.
3. Click **Auto-generate Token**, then **Copy Owner Token**. Treat it like a password.
4. Enable **ChatGPT web connector** and click **Start MCP**.
5. Click **Copy Connector URL**. It ends in `/mcp`.
6. In ChatGPT, open **Apps & Connectors / Connectors**, create a new connector, and paste the URL.
7. When ChatGPT shows the JK login window, paste the **Owner Token**.
8. Try: `@jk Read this project's README and summarize its current state.`

<p align="center">
  <img src="assets/screenshots/windows-app.png" alt="JK Windows app: connector URL, owner token, status, and activity log" width="760" />
</p>

### Connector URL: temporary vs. your own domain

| | No domain (default) | Your own domain (optional) |
|---|---|---|
| URL | `https://<random>.trycloudflare.com/mcp` | `https://mcp.example.com/mcp` |
| Setup | Nothing. JK creates a Cloudflare Quick Tunnel automatically. | Run a Cloudflare Named Tunnel or HTTPS reverse proxy to `http://127.0.0.1:7979`, then enter the hostname in **Owned fixed domain**. |
| After JK restarts | **The URL changes.** Update the connector URL in ChatGPT and log in again. | The URL stays the same. |
| Best for | Trying JK, short sessions | Daily use |

A domain is nice to have, not required. See the [installation guide](docs/INSTALL.md) for the full setup.

## What you can ask

```text
@jk Inspect this project and explain how it works. Do not edit anything.
@jk Find the cause of this bug, fix it, and run the relevant tests.
@jk Continue the previous task and finish it.
@jk Implement this in a separate task workspace, verify it, then apply it.
@jk Run E2E and show the passing evidence.
@jk Review the current diff and commit it if verification passes.
```

You describe the goal in plain language; you don't need to know any tool names.

## Features

### Work that carries on
- **Persistent work sessions**: the current goal, touched files, pending items, decisions, checkpoints, and verification results are saved per project, so follow-ups resume the real task.
- **Checkpoints**: restore an earlier state of the files JK changed.

### Changes you can trust
- **Guarded edits**: edits to existing files can carry a SHA-256 precondition. If the file changed after it was read, the edit is rejected instead of overwriting newer work.
- **Verification evidence**: tests, builds, and E2E runs are executed locally and their output is returned as proof.
- **Task workspaces**: implement and verify in a private copy of the project, then publish only verified, reviewed changes back. If the original moved on in the meantime, publishing is refused rather than merged blindly. See [Task Workspaces](docs/TASK_WORKSPACES.ko.md).

### Bigger jobs, organized
- **JK orchestration**: `goal_intake` and `goal_loop` run longer coding loops through Explorer, Oracle, Implementer, Reviewer, Verifier, and Recovery roles. A failed verification re-plans instead of repeating the same attempt.
- **MASS ULW parallel work**: split a job into dependency-aware lanes that implement, verify, repair, and review in parallel inside one ChatGPT conversation. See [MASS ULW workflow](docs/MASS_ULW_WEB.ko.md).
- **Optional OMO delegation**: hand selected passes to a local OMO / Oh My OpenAgent install while JK keeps state, safety, and verification authoritative.

### See what's happening
- **Control Center**: a local dashboard for the current task, approvals, execution hosts, and activity.
- **Live dependency graph**: parallel work is drawn as a DAG with waves, colour-coded lane states, animated flow into running lanes, and hover highlighting of each lane's dependencies.

<p align="center">
  <img src="assets/screenshots/control-center-dag.png" alt="Control Center DAG: waves, lane states, and dependency edges" width="860" />
</p>

### Everything a coding session needs
Project selection, code search, narrow file reads, guarded patches, allowlisted commands and shell jobs, Git status/diff/commit/explicit push, dev servers, browser E2E with screenshots, image intake, external MCP routing, and runtime health checks.

## Safety model

JK is intended for trusted development environments.

- Access is scoped to the selected project folder.
- Sensitive shell, network, Git publication, and destructive operations require your approval.
- Secret-looking values are redacted from tool output.
- Project leases and task ownership prevent conflicting concurrent edits.
- The MCP endpoint rejects requests without Owner Token authorization. Rotating the token signs out existing sessions but keeps the connector registered.

Never share your Owner Token, tunnel credentials, or domain credentials in screenshots, logs, issues, or chats. If one leaks, rotate it in **Settings**.

## For developers: build from source

Requirements: Node.js 22+, npm, and PowerShell on Windows.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Run from source:

```powershell
npm run chatgpt:windows   # Windows
```

```bash
npm run chatgpt           # macOS
npm run chatgpt:linux     # Linux
```

Packaging and E2E:

```powershell
npm run windows:package
npm run windows:e2e
```

<details>
<summary>Repository layout</summary>

```text
src/
  auth/           authentication / owner-token support
  code/           search, read, patch operations
  control/        desktop/control safety paths
  control-center/ local operations UI
  e2e/            local browser E2E and evidence
  exec/           command, shell, OMO runners
  executors/      remote/local execution routing
  orchestration/  MASS ULW and longer-running task logic
  policy/         approvals, paths, secrets, shell-job policy
  roles/          JK orchestration roles
  server/         MCP tools and Actions bridge
  state/          persistent project/work-session state
  workspace/      project registry and lease handling

windows/          Windows launcher / tray / installer
macos/            macOS launcher/status-bar path
linux/            Linux launch/install path
scripts/          build, packaging, verification, release helpers
docs/             usage, architecture notes, engineering docs
assets/           JK public assets
```

</details>

## Author

JK is designed, built, and maintained by **Anjingyeong**. Issues and feedback are welcome on the [issue tracker](https://github.com/Anjingyeong/jk-mcp/issues).

The earliest codebase incorporated work from another project, used with the original author's permission. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) and [Attribution and compliance notes](docs/ATTRIBUTION_AND_COMPLIANCE.md).
