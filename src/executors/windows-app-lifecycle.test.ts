import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_HTML } from "../control-center/ui.js";

const execFileAsync = promisify(execFile);

describe("Windows executor app lifecycle", () => {
  it("keeps JK.exe/start-chatgpt as the single lifecycle owner", async () => {
    const launcher = await readFile(new URL("../../start-chatgpt.ps1", import.meta.url), "utf8");
    const reloader = await readFile(new URL("../../scripts/reload-jk-runtime.ps1", import.meta.url), "utf8");
    const offlineBuilder = await readFile(new URL("../../scripts/build-windows-app-offline.ps1", import.meta.url), "utf8");
    const windowsApp = await readFile(new URL("../../windows/ChatGPTToCodexLauncher.cs", import.meta.url), "utf8");

    expect(launcher).toContain("Migrate-LegacyWindowsExecutor");
    expect(launcher).toContain("executor failed 3 times within 20 seconds; supervision paused");
    expect(launcher).toContain("$executorQuickFailureCount");
    expect(launcher).toContain("$ExecutorOnly");
    expect(launcher).toContain("hybrid executor-only mode; the configured remote hub is the authoritative MCP/dashboard/approval control plane.");
    const migrationCall = launcher.indexOf("Migrate-LegacyWindowsExecutor", launcher.indexOf('$cli = Join-Path $Root "dist\\cli.js"'));
    const executorOnlyBranch = launcher.indexOf("if ($ExecutorOnly)");
    expect(migrationCall).toBeGreaterThan(-1);
    expect(migrationCall).toBeLessThan(executorOnlyBranch);
    expect(reloader).toContain("Wait-Executor");
    expect(reloader).toContain("Wait-Executor 45 20");
    expect(reloader).toContain("Normalize-ProcessCommandLine");
    expect(reloader).toContain("Test-RuntimePackage");
    expect(reloader).toContain("Prepare-RuntimeCandidate");
    expect(reloader).toContain("build-windows-app-offline.ps1");
    expect(reloader).toContain("Remove-SuccessfulSwapArtifacts");
    expect(reloader).toContain("cleanup-success canonical-runtime=JK transient-runtime-folders=removed");
    const prepareCall = reloader.indexOf("  Prepare-RuntimeCandidate", reloader.indexOf("if (-not $Worker)"));
    const detachedWorker = reloader.indexOf('Start-Process -FilePath "powershell.exe"');
    expect(prepareCall).toBeGreaterThan(-1);
    expect(detachedWorker).toBeGreaterThan(prepareCall);
    expect(reloader).toContain("rollback-unavailable");
    expect(reloader).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
    expect(reloader).toContain("started live JK.exe detached pid=");
    expect(reloader).toContain("20 consecutive seconds");
    expect(reloader).toContain('GetEnvironmentVariable("JK_EXECUTOR_ONLY", "User")');
    expect(reloader).toContain('$env:JK_EXECUTOR_ONLY = "1"');
    expect(reloader).toContain("executor-only runtime unexpectedly exposed 127.0.0.1:7979");
    expect(reloader).toContain("swap-success mode=executor-only local-port=disabled executor=stable");
    expect(offlineBuilder).toContain('Join-Path $Root "node_modules"');
    expect(offlineBuilder).toContain('Write-Host "[chatgpt2codex] using existing offline dependencies..."');
    expect(offlineBuilder).not.toContain("throw Offline node_modules is missing");
    expect(launcher).toContain("$isSameExecutor");
    expect(launcher).toContain("using externally managed public tunnel");
    expect(launcher).toContain("if ($cfProc -and $cfProc.HasExited)");
    expect(launcher).not.toContain("--hostname");
    expect(launcher).toContain('Join-Path $startup "JK Executor.cmd"');
    expect(launcher).toContain('"executor-supervisor.js"');
    expect(launcher).toContain('"executor-worker.js"');
    expect(launcher).toContain('Join-Path $env:LOCALAPPDATA "JK\\executor-token.txt"');
    expect(launcher).toContain("Test-Path -LiteralPath $ExecutorWorkspace -PathType Container");
    expect(launcher).toContain("executor workspace not found: $ExecutorWorkspace; falling back to $Workspace");
    expect(windowsApp).toContain("MigrateLegacyExecutorStartupIntent");
    expect(windowsApp).toContain("launchAtStartup = true;");
    expect(windowsApp).toContain("startMcpOnOpen = true;");
    expect(windowsApp).toContain("disableTunnelForLaunch");
    expect(windowsApp).toContain("IsPublicTunnelEnabledForLaunch()");
    expect(windowsApp).toContain("publicTunnelEnabled || !string.IsNullOrWhiteSpace(configuredPublicHost)");
    expect(windowsApp).toContain('new System.Threading.Mutex(true, @"Local\\JK.ChatGPTToCodexLauncher"');
    expect(windowsApp).toContain('githubRepoUrl = "https://github.com/Anjingyeong/jk-mcp"');
    expect(windowsApp).toContain('Environment.GetEnvironmentVariable("JK_HUB_URL")');
    expect(windowsApp).toContain('normalized.EndsWith("/mcp", StringComparison.OrdinalIgnoreCase)');
    expect(windowsApp).toContain('return "http://127.0.0.1:" + port + "/";');
    expect(windowsApp).toContain('openDashboardButton.Text = "Cloud Dashboard";');
    expect(windowsApp).toContain("DisplayConnectorUrl()");
    expect(windowsApp).toContain("Opened remote Control Center in the default browser.");
  });

  it("pairs Windows by configuring the JK app instead of installing a second supervisor", () => {
    expect(CONTROL_CENTER_HTML).toContain("JK Windows worker configured in executor-only mode. Restart JK once.");
    expect(CONTROL_CENTER_HTML).toContain("JK_EXECUTOR_ONLY");
    expect(CONTROL_CENTER_HTML).toContain("worker 재시작과 장애 복구는 JK 앱이 직접 관리합니다");
    expect(CONTROL_CENTER_HTML).not.toContain("Windows supervisor bootstrap을 불러오지 못했습니다.");
    expect(CONTROL_CENTER_HTML).not.toContain("Start-Process -WindowStyle Hidden node -ArgumentList @($s)");
  });

  it("keeps start-chatgpt parseable by Windows PowerShell", async () => {
    if (process.platform !== "win32") return;
    const launcherPath = fileURLToPath(new URL("../../start-chatgpt.ps1", import.meta.url));
    const reloaderPath = fileURLToPath(new URL("../../scripts/reload-jk-runtime.ps1", import.meta.url));
    const offlineBuilderPath = fileURLToPath(new URL("../../scripts/build-windows-app-offline.ps1", import.meta.url));
    const parserCommand = [
      "$tokens=$null",
      "$errors=$null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${launcherPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null`,
      "if($errors.Count -gt 0){$errors | ForEach-Object { Write-Error $_.Message }; exit 1}",
    ].join("; ");
    await expect(execFileAsync("powershell.exe", ["-NoProfile", "-Command", parserCommand])).resolves.toBeDefined();
    const reloadParserCommand = [
      "$tokens=$null",
      "$errors=$null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${reloaderPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null`,
      "if($errors.Count -gt 0){$errors | ForEach-Object { Write-Error $_.Message }; exit 1}",
    ].join("; ");
    await expect(execFileAsync("powershell.exe", ["-NoProfile", "-Command", reloadParserCommand])).resolves.toBeDefined();
    const offlineBuilderParserCommand = [
      "$tokens=$null",
      "$errors=$null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${offlineBuilderPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null`,
      "if($errors.Count -gt 0){$errors | ForEach-Object { Write-Error $_.Message }; exit 1}",
    ].join("; ");
    await expect(execFileAsync("powershell.exe", ["-NoProfile", "-Command", offlineBuilderParserCommand])).resolves.toBeDefined();
  });
});
