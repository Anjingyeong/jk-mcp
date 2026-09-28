import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_HTML } from "../control-center/ui.js";

const execFileAsync = promisify(execFile);

describe("Windows executor app lifecycle", () => {
  it("keeps JK.exe/start-jk as the single lifecycle owner", async () => {
    const launcher = await readFile(new URL("../../start-jk.ps1", import.meta.url), "utf8");
    const reloader = await readFile(new URL("../../scripts/reload-jk-runtime.ps1", import.meta.url), "utf8");
    const offlineBuilder = await readFile(new URL("../../scripts/build-windows-app-offline.ps1", import.meta.url), "utf8");
    const windowsApp = await readFile(new URL("../../windows/JKLauncher.cs", import.meta.url), "utf8");

    expect(windowsApp).toContain("var brandLogo = new PictureBox();");
    expect(windowsApp).toContain("brandLogo.Image = BuildSidebarBrandImage();");
    expect(windowsApp).toContain("System.Drawing.Color.FromArgb(pixel.A, 255, 255, 255)");
    expect(windowsApp).toContain('brandSubtitle.Text = "Runtime Console";');
    expect(windowsApp).toContain("private static void StyleActionButton(Button button, bool primary)");
    expect(windowsApp).toContain("private static readonly System.Drawing.Color JkSidebar");

    expect(launcher).toContain("Migrate-LegacyWindowsExecutor");
    expect(launcher).toContain("executor failed 3 times within 20 seconds; supervision paused");
    expect(launcher).toContain("$executorQuickFailureCount");
    expect(launcher).toContain("$ExecutorOnly");
    expect(launcher).toContain("Start-LoggedProcess $Node $serverArgs $srvOut $srvErr");
    expect(launcher).not.toContain("$serverOut");
    expect(launcher).not.toContain("$serverErr");
    expect(launcher).toContain("external public hostname mode; expecting tunnel/proxy -> http://127.0.0.1:$Port");
    expect(launcher).not.toContain('"--hostname", $PublicHostname');
    expect(launcher).toContain("hybrid executor-only mode; OCI is the authoritative MCP/dashboard/approval control plane.");
    const migrationCall = launcher.indexOf("Migrate-LegacyWindowsExecutor", launcher.indexOf('$cli = Join-Path $Root "dist\\cli.js"'));
    const executorOnlyBranch = launcher.indexOf("if ($ExecutorOnly)", migrationCall);
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
    expect(reloader).toContain('"JK-fixed", "JK-release-canonical", "JK-release-test"');
    expect(reloader).toContain('"JK-*-windows-setup.exe"');
    expect(reloader).toContain('Join-Path $BuildRoot "JK-Setup.exe"');
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
    expect(offlineBuilder).toContain(String.raw`"windows\JKLauncher.cs"`);
    expect(offlineBuilder).not.toContain("throw Offline node_modules is missing");
    expect(launcher).toContain("$isSameExecutor");
    expect(launcher).toContain('Join-Path $startup "JK Executor.cmd"');
    expect(launcher).toContain('"executor-supervisor.js"');
    expect(launcher).toContain('"executor-worker.js"');
    expect(launcher).toContain('Join-Path $env:LOCALAPPDATA "JK\\executor-token.txt"');
    expect(launcher).toContain("function Resolve-ExecutorWorkspace");
    expect(launcher).toContain("Executor workspace does not exist: $RequestedWorkspace");
    expect(launcher).not.toContain("falling back to $Workspace");
    expect(windowsApp).toContain("MigrateLegacyExecutorStartupIntent");
    expect(windowsApp).toContain("launchAtStartup = true;");
    expect(windowsApp).toContain("startMcpOnOpen = true;");
    expect(windowsApp).toContain("disableTunnelForLaunch");
    expect(windowsApp).toContain("IsPublicTunnelEnabledForLaunch()");
    expect(windowsApp).toContain("tunnelCheck.Checked || !string.IsNullOrWhiteSpace(configuredPublicHost)");
    expect(windowsApp).toContain("NormalizePublicHost(hostBox.Text)");
    expect(windowsApp).toContain("var previousPublicHost = configuredPublicHost;");
    expect(windowsApp).toContain("mcpUrl = null;");
    expect(windowsApp).toContain('mcpUrl = "https://" + configuredPublicHost + "/mcp";');
    expect(windowsApp).toContain("var detectedMcpUrl = match.Value.Trim();");
    expect(windowsApp).toContain("if (!string.IsNullOrEmpty(connector) && !string.IsNullOrWhiteSpace(configuredPublicHost))");
    expect(windowsApp.indexOf('if (IsPublicTunnelEnabledForLaunch() && !string.IsNullOrEmpty(configuredPublicHost)) return "https://" + configuredPublicHost + "/mcp";'))
      .toBeLessThan(windowsApp.indexOf("if (!string.IsNullOrEmpty(mcpUrl)) return mcpUrl;"));
    expect(windowsApp).toContain('private const string SingleInstanceMutexName = @"Local\\JK.ChatGPTToCodexLauncher";');
    expect(windowsApp).toContain('private const string ActivationEventName = @"Local\\JK.ChatGPTToCodexLauncher.Activate";');
    expect(windowsApp).toContain('new System.Threading.Mutex(true, SingleInstanceMutexName');
    expect(windowsApp).toContain('activationEvent.Set();');
    expect(windowsApp).toContain('System.Threading.ThreadPool.RegisterWaitForSingleObject(');
    expect(windowsApp).toContain('form.BeginInvoke(new Action(form.ShowFromTray));');
    expect(windowsApp).toContain('internal void ShowFromTray()');
    expect(windowsApp).toContain('Environment.GetEnvironmentVariable("JK_REMOTE_CONTROL_CENTER_URL")');
    expect(windowsApp).toContain("private static bool IsExecutorOnlyMode()");
    expect(windowsApp).toContain('return IsExecutorOnlyMode() ? PublicControlCenterUrl() : LocalControlCenterUrl();');
    expect(windowsApp).toContain('return IsExecutorOnlyMode() ? PublicApprovalsPageUrl() : LocalApprovalsPageUrl();');
    expect(windowsApp).not.toContain('return "https://mcp.example.com/mcp";');
    expect(windowsApp).not.toContain('hub.IndexOf("example.com"');
    expect(windowsApp).toContain('return "http://127.0.0.1:" + port + "/";');
    expect(windowsApp).toContain('openDashboardButton.Text = "Control Center";');
    expect(windowsApp).toContain("DisplayConnectorUrl()");
    expect(windowsApp).toContain("return ConnectorUrl();");
    expect(windowsApp).toContain('internal static class JKLauncher');
    expect(windowsApp).toContain("Opened remote Control Center in the default browser.");
    expect(windowsApp).toContain('var runsNav = NewNavigationButton("Runs", 126);');
    expect(windowsApp).toContain('var approvalsNav = NewNavigationButton("Approvals", 170);');
    expect(windowsApp).toContain('approvalsNav.Click += delegate { OpenUrl(ApprovalsPageUrl()); };');
    expect(windowsApp).toContain("private void ShowRunsPage()");
    expect(windowsApp).toContain('ControlApiGet<JkExecutionResponse>("/control/execution")');
    expect(windowsApp).toContain('ControlApiGet<JkLogsResponse>("/control/logs?limit=24")');
    expect(windowsApp).toContain("runPollTimer.Interval = 1500;");
    expect(windowsApp).toContain("작업 / lane DAG");
    expect(windowsApp).toContain("private void DrawRunDagEdges(System.Drawing.Graphics graphics)");
    expect(windowsApp).toContain("graphics.DrawBezier(pen,");
    expect(windowsApp).toContain("LineCap.ArrowAnchor");
    expect(windowsApp).toContain("private static string RunSemanticStatus");
    expect(windowsApp).toContain('case "in-flight": return "running";');
    expect(windowsApp).toContain('case "completed": return "accepted";');
    expect(windowsApp).toContain("최근 이벤트");
    expect(windowsApp).toContain("blockedDependencies");
    expect(windowsApp).toContain("ThreadPool.QueueUserWorkItem");
    expect(windowsApp).toContain('ExecutorSetting("JK_HUB_URL")');
    expect(windowsApp).toContain('ExecutorSetting("JK_EXECUTOR_TOKEN_FILE")');
    expect(windowsApp).toContain('"/api/executors/" + Uri.EscapeDataString(executorId) + "/run-view"');
    expect(windowsApp).toContain('request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;');
    expect(windowsApp).toContain("var count = payload == null ? 0 : payload.approvalCount;");
    expect(windowsApp).toContain('trayIcon.BalloonTipText = "중앙 Control Center · 승인 대기 " + count + "건"');
    expect(windowsApp).toContain("const int panel1Min = 280;");
    expect(windowsApp).not.toContain("split.Panel1MinSize = 280;");
    expect(windowsApp).toContain("● Hub live · 1.5s");
    expect(windowsApp).toContain("control.Visible = false;");
    expect(windowsApp).toContain("if (!contentHost.Controls.Contains(page)) contentHost.Controls.Add(page);");
    expect(windowsApp).toContain("page.Visible = true;");
    const dashboardRefresh = windowsApp.indexOf("private void RefreshDashboardRoleSummary()");
    const dashboardThread = windowsApp.indexOf("ThreadPool.QueueUserWorkItem", dashboardRefresh);
    const dashboardRoleApi = windowsApp.indexOf("RoleApiAvailable()", dashboardRefresh);
    expect(dashboardThread).toBeGreaterThan(dashboardRefresh);
    expect(dashboardThread).toBeLessThan(dashboardRoleApi);
    const updateCheck = windowsApp.indexOf("private void CheckUpdates(bool manual)");
    const updateThread = windowsApp.indexOf("ThreadPool.QueueUserWorkItem", updateCheck);
    const updateDownload = windowsApp.indexOf("client.DownloadString(api)", updateCheck);
    expect(updateThread).toBeGreaterThan(updateCheck);
    expect(updateThread).toBeLessThan(updateDownload);
  });

  it("pairs Windows by configuring the JK app instead of installing a second supervisor", () => {
    expect(CONTROL_CENTER_HTML).toContain("JK Windows worker configured in executor-only mode. Restart JK once.");
    expect(CONTROL_CENTER_HTML).toContain("JK_EXECUTOR_ONLY");
    expect(CONTROL_CENTER_HTML).toContain("worker 재시작과 장애 복구는 JK 앱이 직접 관리합니다");
    expect(CONTROL_CENTER_HTML).not.toContain("Windows supervisor bootstrap을 불러오지 못했습니다.");
    expect(CONTROL_CENTER_HTML).not.toContain("Start-Process -WindowStyle Hidden node -ArgumentList @($s)");
  });

  it("keeps start-jk parseable by Windows PowerShell", async () => {
    if (process.platform !== "win32") return;
    const launcherPath = fileURLToPath(new URL("../../start-jk.ps1", import.meta.url));
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
