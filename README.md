<p align="center">
  <img src="assets/readme-hero.png" alt="JK local coding bridge" width="100%" />
</p>

# JK

**Local coding hands for ChatGPT, with persistent work, guarded execution, and verifiable results.**

[English](README.md) | [한국어](README.ko.md)

JK is a free local MCP coding app designed and built by **Anjingyeong**. Install it, pick a project folder, and connect it to ChatGPT. The current conversation can then inspect code, edit files, run tests, operate Git, run E2E checks, and return execution evidence.

JK is not another AI model. ChatGPT does the reasoning; JK is the local execution layer that remembers the work and enforces safety.

> JK is an independent project and is not affiliated with or endorsed by OpenAI. OpenAI, ChatGPT, GPT, and Codex are marks or products of OpenAI.

## Download

Download the app from the [Releases page](https://github.com/Anjingyeong/jk-mcp/releases). No Node.js or terminal is required. Node.js, cloudflared, and ripgrep are bundled.

| OS | File |
|---|---|
| Windows | `JK-...-setup.exe` |
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

## Features

- **Persistent work sessions**: keeps the current goal, touched files, pending work, decisions, checkpoints, and verification results, so follow-up requests resume the real task instead of starting over.
- **Guarded edits**: existing-file edits can use SHA-256 preconditions. A change is rejected if the file changed after it was read.
- **JK-native orchestration**: `goal_intake` and `goal_loop` coordinate longer coding loops through Explorer, Oracle, Implementer, Reviewer, Verifier, and Recovery roles. Failed verification re-plans instead of repeating the same approach.
- **MASS ULW**: dependency-aware implementation, verification, repair, and review lanes inside one ChatGPT conversation. See [MASS ULW workflow](docs/MASS_ULW_WEB.ko.md).
- **Task workspaces**: implement and verify in a private workspace, then publish accepted changes back with conflict checks. See [Task Workspaces](docs/TASK_WORKSPACES.ko.md).
- **Local execution bridge**: project selection, code search, narrow reads, guarded patches, allowlisted commands and shell jobs, Git status/diff/commit/explicit push, dev servers, E2E and screenshots, image intake, external MCP routing, runtime health checks.
- **Control Center**: a local dashboard for work status, approvals, runs, executor identity, and runtime operations.
- **Optional OMO delegation**: hand selected passes to a local OMO / Oh My OpenAgent install while JK keeps state, safety, and verification authoritative.

## Safety model

JK is intended for trusted development environments.

- Access is scoped to the selected project folder.
- Sensitive shell, network, Git publication, and destructive operations require approval.
- Secret-looking values are redacted from tool output.
- Project leases and task ownership prevent conflicting concurrent edits.
- The MCP endpoint rejects requests without Owner Token authorization.

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

JK is designed, built, and maintained by **Anjingyeong**.

The earliest codebase incorporated work from another project, used with the original author's permission. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) and [Attribution and compliance notes](docs/ATTRIBUTION_AND_COMPLIANCE.md).
