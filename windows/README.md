# JK for Windows

Beginner install:

1. Download `JK-Setup.exe` from the official JK GitHub releases page:
   <https://github.com/Anjingyeong/jk-mcp/releases>
2. Double-click the installer.
3. If Windows SmartScreen appears, choose **More info** -> **Run anyway** only
   when the file came from the official release page.
4. Open **JK**.
5. Confirm the tray icon appears near the clock.
6. Open **Settings...**, choose a project folder, enable the ChatGPT web
   connector if needed, then click **Start MCP**.
7. Copy the `/mcp` Connector URL and approve it in ChatGPT with the Owner Token.

Keep the Owner Token private. Treat it like a password.

Portable/source install:

- From a packaged folder, double-click `JK.exe`.
- If the exe has not been built yet, run `windows\Build-JKExe.ps1`
  once on Windows.
- Fallback launcher: `windows\Start-JKTray.cmd`.

Runtime modes:

- **Development**: launch the repository-root `JK.exe` or `start-jk.ps1`.
  The source launcher owns the repository-root `dist\cli.js` and rebuilds it when
  `src`, package metadata, or `tsconfig.json` is newer.
- **Portable**: launch `build\windows\JK\JK.exe` (or an installed/extracted
  release). It always uses the `dist` bundled next to that executable and never
  silently delegates to a nearby source checkout.
- The launcher exports `JK_RUNTIME_MODE` and `JK_RUNTIME_ROOT`; the Control Center
  shows the active mode so the runtime source of truth is visible.
- Run `npm run windows:launcher:test` to verify mode detection, stale-build
  detection, PowerShell parsing, and, when present, generated-launcher sync.

The app uses `winget` to install Node.js LTS and `cloudflared` only when they
are missing, then opens a tray controller. Starting MCP is loopback-only by
default. For ChatGPT web, prefer your own stable hostname; use temporary Quick
Tunnel URLs only for short tests because they change after restart.

The tray menu stays deliberately small:

- Start/Stop/Restart MCP.
- Open Settings.
- Quit.

Settings contains the busy stuff: project folder, ChatGPT web connector, owned
fixed domain, port, launch-at-login, start-on-open, update checks, language
override, connector URL, health links, logs, releases, and the copyright footer.
GitHub is a direct button, not a text setting.

First prompt to try in ChatGPT:

```text
Use JK. Select my project, read the README and package scripts,
run the safest available check, then summarize the result with exact evidence.
```

E2E screenshot prompt:

```text
Use JK to run E2E, open the app, capture screenshots, and show them inline.
```

For local web projects, Windows E2E capture launches an installed Microsoft Edge
or Google Chrome with an isolated temporary profile and uses the local Chrome
DevTools Protocol to save deterministic browser viewports under
`.jk/e2e/screenshots` (legacy installations may still use `.chatgpt2codex/e2e/screenshots`). The one-shot E2E flow captures desktop
top/middle/bottom plus mobile (390x844) top/middle/bottom views. It does not
require the target browser window to remain visible on screen.

Troubleshooting:

- If SmartScreen appears, verify the installer came from the official GitHub
  release before running it.
- If the connector URL is empty, open Settings, enable ChatGPT web connector,
  click **Start MCP**, then copy the URL again.
- If port 7676 is busy, use **Restart MCP** from the tray menu. The launcher
  cleans up stale runtime processes before restart.
- For local web screenshots, confirm Microsoft Edge or Google Chrome is installed.
  Desktop-app window capture still has separate platform limitations.
- If ChatGPT asks for approval, paste the Owner Token from the Windows app.

The tray UI follows the Windows display language by default and can be changed
in Settings. Supported UI languages: English, Korean, Japanese, Simplified
Chinese, Traditional Chinese, Spanish, French, German, Brazilian Portuguese,
Italian, Dutch, Polish, Russian, Turkish, Vietnamese, Indonesian, Thai, Arabic,
Hindi, and Ukrainian.

For first-time machine setup from a source checkout:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -RepoUrl https://github.com/Anjingyeong/jk-mcp.git -Launch
```

For source-free users, ship the Windows zip from `npm run windows:package`.
They only need to unzip it and double-click `JK.exe`.

JK © 2026 Anjingyeong. See `ACKNOWLEDGEMENTS.md` for historical attribution.
