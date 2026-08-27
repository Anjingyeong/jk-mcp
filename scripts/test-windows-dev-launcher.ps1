$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Launcher = Join-Path $Root "start-chatgpt.ps1"

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
    $messages = ($errors | ForEach-Object { $_.Message }) -join "`n"
    throw "start-chatgpt.ps1 has PowerShell parse errors:`n$messages"
}

$functions = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)

foreach ($name in @(
    "Resolve-RuntimeMode",
    "Get-StartupStatusLines",
    "Test-SourceBuildRequired"
)) {
    $fn = $functions | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if (-not $fn) {
        throw "Launcher helper not found: $name"
    }
    Invoke-Expression $fn.Extent.Text
}

$launcherParameters = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
if ($launcherParameters -contains "DeploymentMode") {
    throw "Launcher still exposes the retired provider-specific deployment mode."
}
foreach ($name in @(
    "Get-AwsDeploymentInfo",
    "Resolve-DeploymentMode",
    "Test-LocalPublicationConflict",
    "Start-AwsManagementMonitor"
)) {
    if ($functions | Where-Object { $_.Name -eq $name } | Select-Object -First 1) {
        throw "Launcher still contains retired provider-specific helper: $name"
    }
}

$sourceMode = Resolve-RuntimeMode $Root
if ($sourceMode -ne "development") {
    throw "Source checkout must resolve to development mode. resolved=$sourceMode"
}

$portableRuntime = Join-Path $Root "build\windows\JK"
$portableMode = Resolve-RuntimeMode $portableRuntime
if ($portableMode -ne "portable") {
    throw "Generated build/windows/JK must use its bundled dist as portable mode. resolved=$portableMode"
}

$waitingStatus = @(Get-StartupStatusLines $true $true $false)
foreach ($line in @("JK runtime is running", "MCP endpoint available", "Waiting for ChatGPT connection")) {
    if ($waitingStatus -notcontains $line) {
        throw "Disconnected startup status is missing: $line"
    }
}
if ($waitingStatus -contains "JK is ready") {
    throw "Disconnected startup status incorrectly claims JK is ready."
}
$connectedStatus = @(Get-StartupStatusLines $true $true $true)
if ($connectedStatus -notcontains "JK is ready") {
    throw "Connected startup status did not claim JK is ready."
}

$windowsLauncher = Join-Path $Root "windows\ChatGPTToCodexLauncher.cs"
$windowsLauncherText = Get-Content -Raw -LiteralPath $windowsLauncher
foreach ($statusMarker in @("JK runtime is running", "MCP endpoint available", "Waiting for ChatGPT connection", "JK is ready")) {
    if ($windowsLauncherText -notmatch [regex]::Escape($statusMarker)) {
        throw "Windows UI status parser is missing: $statusMarker"
    }
}
if ($windowsLauncherText -match 'statusLabel\.Text\s*=\s*LFormat\("stableConnectorReady"') {
    throw "Windows UI still marks a stable connector URL as ready before OAuth connection is proven."
}
foreach ($approvalMarker in @(
    'PublicControlCenterUrl().TrimEnd(''/'') + "/approvals"',
    'OpenUrl(ApprovalsPageUrl())'
)) {
    if ($windowsLauncherText -notmatch [regex]::Escape($approvalMarker)) {
        throw "Windows approvals navigation is missing cloud-first routing marker: $approvalMarker"
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("chatgpt2codex-launcher-test-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "src"), (Join-Path $tempRoot "dist") | Out-Null
    Set-Content -LiteralPath (Join-Path $tempRoot "package.json") -Value "{}"
    Set-Content -LiteralPath (Join-Path $tempRoot "package-lock.json") -Value "{}"
    Set-Content -LiteralPath (Join-Path $tempRoot "tsconfig.json") -Value "{}"
    Set-Content -LiteralPath (Join-Path $tempRoot "src\a.ts") -Value "export const a = 1;"
    Set-Content -LiteralPath (Join-Path $tempRoot "dist\cli.js") -Value "// built"

    $now = [datetime]::UtcNow
    [System.IO.File]::SetLastWriteTimeUtc((Join-Path $tempRoot "dist\cli.js"), $now)
    [System.IO.File]::SetLastWriteTimeUtc((Join-Path $tempRoot "src\a.ts"), $now.AddSeconds(-10))
    [System.IO.File]::SetLastWriteTimeUtc((Join-Path $tempRoot "package.json"), $now.AddSeconds(-10))
    [System.IO.File]::SetLastWriteTimeUtc((Join-Path $tempRoot "package-lock.json"), $now.AddSeconds(-10))
    [System.IO.File]::SetLastWriteTimeUtc((Join-Path $tempRoot "tsconfig.json"), $now.AddSeconds(-10))

    if (Test-SourceBuildRequired $tempRoot) {
        throw "Fresh dist/cli.js was incorrectly marked stale."
    }

    [System.IO.File]::SetLastWriteTimeUtc((Join-Path $tempRoot "src\a.ts"), $now.AddSeconds(10))
    if (-not (Test-SourceBuildRequired $tempRoot)) {
        throw "A newer source file did not mark dist/cli.js stale."
    }

    Remove-Item -LiteralPath (Join-Path $tempRoot "dist\cli.js") -Force
    if (-not (Test-SourceBuildRequired $tempRoot)) {
        throw "Missing dist/cli.js did not require a build."
    }
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$packagedLauncher = Join-Path $Root "build\windows\JK\start-chatgpt.ps1"
if (Test-Path -LiteralPath $packagedLauncher) {
    $sourceHash = (Get-FileHash -LiteralPath $Launcher -Algorithm SHA256).Hash
    $packagedHash = (Get-FileHash -LiteralPath $packagedLauncher -Algorithm SHA256).Hash
    if ($sourceHash -ne $packagedHash) {
        throw "Existing Windows development package launcher is stale. Re-sync start-chatgpt.ps1."
    }
}

Write-Host "Windows development launcher tests passed."
