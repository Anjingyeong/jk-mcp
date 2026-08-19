<p align="center">
  <img src="assets/readme-hero.png" alt="JK local coding bridge" width="100%" />
</p>

# JK

**A local coding bridge that lets ChatGPT inspect, edit, test, and run Git workflows against projects on your own computer.**

[한국어 사용법](README.md) | [English](README.en.md)

> JK is an unofficial project and is not affiliated with OpenAI. It is a modified fork based on `ezBuilder/chatgpt2codex`. Review [Attribution & Compliance](docs/ATTRIBUTION_AND_COMPLIANCE.md) before redistributing derived source or binaries.

## What JK does

JK is not a second AI model.

```text
You
→ ChatGPT
→ JK
→ your local projects / shell / Git / tests
```

ChatGPT reasons; JK provides the local execution layer.

The old term **“ChatGPT plugin”** is no longer the clearest way to describe setup. Use one of these paths instead:

1. **Recommended for individual Plus users:** Custom GPT + Actions
2. **Where supported on Business / Enterprise / Edu:** ChatGPT Apps + MCP

Both paths can be protected by the JK **Owner Token**.

## 1. Install

Requirements:

- Git
- Node.js 22+
- npm
- Windows 10/11 recommended for the friend-distribution workflow
- **One domain you own** (for example `example.com`, used to create the public HTTPS hostname ChatGPT connects to)

```powershell
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run build
npm run chatgpt:windows
```

macOS/Linux:

```bash
npm run chatgpt
```

A healthy launch prints the local endpoints:

```text
MCP URL: http://127.0.0.1:7979/mcp
Dashboard: http://127.0.0.1:7979/
```

## 2. Save the Owner Token

On first setup JK generates an **Owner Token** and prints it once in the terminal.

Treat it like a password. Do not commit it, paste it into issues, or expose it in screenshots.

If you lose it, rotate to a new token:

```powershell
node dist/cli.js owner-token --generate
```

Rotating the token may require existing OAuth connections to authenticate again.

> The public `jk-mcp` build does **not** use the old private desktop GUI to reveal the token. The CLI/launcher generates and prints it during setup.

## 3. Prepare an HTTPS endpoint

> **This friend-distribution guide treats a personal domain as a prerequisite.** If you own `example.com`, use a subdomain such as `jk.example.com` for JK. JK does not purchase a domain or automatically configure DNS/HTTPS for you.

Another public HTTPS hostname that you control can work technically, but this guide assumes that you use your own domain.

JK binds to loopback by default:

```text
http://127.0.0.1:7979
```

ChatGPT cannot directly reach your computer's `127.0.0.1`, so a ChatGPT web connection needs an HTTPS endpoint that routes to JK.

The public distribution intentionally does not provision a tunnel, DNS provider, or cloud host. Manage that transport separately, then pass its hostname to JK:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-chatgpt.ps1 `
  -Workspace "C:\workspace" `
  -PublicHostname "jk.example.com"
```

Endpoints then become:

```text
MCP:     https://jk.example.com/mcp
Actions: https://jk.example.com/actions/openapi.json
```

## 4-A. Plus: connect with Custom GPT Actions

For an individual Plus setup, this is the simplest path.

1. Create a GPT in ChatGPT.
2. Open **Actions → Create new action**.
3. Import this schema:

```text
https://jk.example.com/actions/openapi.json
```

4. Configure authentication as **API Key → Bearer**.
5. Paste the JK **Owner Token** as the API key.
6. Test a harmless action in Preview.

The Actions bridge accepts either:

- the Owner Token directly as a Bearer token, or
- an OAuth access token issued by JK.

For a friend installing JK on their own machine, the direct Bearer Owner Token path has the least setup.

## 4-B. Apps / MCP

If your ChatGPT workspace supports custom MCP apps with the permissions you need:

1. Enable Developer Mode.
2. Create a custom app.
3. Use this MCP endpoint:

```text
https://jk.example.com/mcp
```

4. Complete OAuth.
5. When JK's local approval page appears, paste the **Owner Token** generated during JK setup.
6. Scan/connect the JK tools.

ChatGPT app/MCP availability varies by plan and workspace policy. If the required MCP path is not available, use Custom GPT Actions where supported.

## 5. Use JK naturally

You do not need to memorize internal tool names.

```text
@JK explain this project structure without modifying files.
```

```text
@JK find the cause of this bug, fix it, and run the relevant tests.
```

```text
@JK review the current diff and commit it if everything looks good.
```

Long tasks work best when you include:

```text
project + goal + constraints + done condition
```

## Security notes

- Work is scoped around selected workspace/projects.
- Secret-looking values are redacted from tool output.
- Existing-file edits can use hash preconditions.
- Sensitive shell/network/destructive operations use safety gates.
- Commit/push require explicit user intent.
- The Owner Token must remain private.

## More documentation

- [한국어 README](README.ko.md)
- [Installation guide](docs/INSTALL.md)
- [Usage guide](docs/USAGE.md)
- [Execution policy](docs/EXECUTION_POLICY.md)
- [Local overrides](docs/LOCAL_OVERRIDES.md)
- [Attribution & Compliance](docs/ATTRIBUTION_AND_COMPLIANCE.md)

## Attribution

JK is an independent, unofficial fork based on [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex).

OpenAI, ChatGPT, GPT, and Codex are trademarks of their respective owners. JK is not an official OpenAI product, plugin, or partner project.
