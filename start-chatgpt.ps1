param(
    [string]$Workspace = $env:WORKSPACE,
    [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 7979 }),
    [string]$PublicHostname = $env:PUBLIC_HOSTNAME,
    [string]$ActiveProjectRoot = $env:CHATGPT2CODEX_ACTIVE_PROJECT_ROOT,
    [string]$ActiveProjectPreset = $(if ($env:CHATGPT2CODEX_ACTIVE_PROJECT_PRESET) { $env:CHATGPT2CODEX_ACTIVE_PROJECT_PRESET } else { "full-write" }),
    [string]$ExecutorHubUrl = $env:JK_HUB_URL,
    [string]$ExecutorId = $(if ($env:JK_EXECUTOR_ID) { $env:JK_EXECUTOR_ID } else { "windows-main" }),
    [string]$ExecutorWorkspace = $env:JK_EXECUTOR_WORKSPACE,
    [string]$ExecutorTokenFile = $env:JK_EXECUTOR_TOKEN_FILE,
    [switch]$ExposeWeb,
    [switch]$RotateOwnerToken,
    [switch]$DisableExecutor
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PATH = "$Root\bin;$env:ProgramFiles\nodejs;$env:USERPROFILE\.local\bin;$env:PATH"

if (-not $Workspace) { $Workspace = Join-Path $HOME "workspace" }
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
$Workspace = [System.IO.Path]::GetFullPath($Workspace)

function Resolve-Tool([string[]]$Names) {
    foreach ($name in $Names) {
        $candidate = Get-Command $name -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.Source) { return $candidate.Source }
    }
    throw "Missing required command: $($Names -join ' or ')"
}

$Node = Resolve-Tool @("node.exe", "node")
$Cli = Join-Path $Root "dist\cli.js"
if (-not (Test-Path -LiteralPath $Cli)) {
    $packageJson = Join-Path $Root "package.json"
    if (-not (Test-Path -LiteralPath $packageJson)) { throw "dist/cli.js was not found under $Root" }
    $Npm = Resolve-Tool @("npm.cmd", "npm")
    Write-Host "[chatgpt2codex] building local runtime..."
    Push-Location $Root
    try {
        & $Npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

$doctor = (& $Node $Cli doctor 2>$null | Out-String)
if ($RotateOwnerToken -or $doctor -notmatch "owner token configured") {
    $initArgs = @($Cli, "init", "--workspace", $Workspace)
    if ($RotateOwnerToken) { $initArgs += "--rotate-owner-token" }
    Write-Host "[chatgpt2codex] initializing local owner token..."
    & $Node @initArgs
    if ($LASTEXITCODE -ne 0) { throw "owner token initialization failed ($LASTEXITCODE)" }
}

$PublicUrl = if ($PublicHostname) { "https://$($PublicHostname.Trim())" } else { "http://127.0.0.1:$Port" }
if ($ExposeWeb -and -not $PublicHostname) {
    Write-Warning "-ExposeWeb no longer provisions a public tunnel. Configure an external reverse proxy/tunnel and pass -PublicHostname instead."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "chatgpt2codex"
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$serverOut = Join-Path $tempRoot "server.out.log"
$serverErr = Join-Path $tempRoot "server.err.log"
$executorOut = Join-Path $tempRoot "executor.out.log"
$executorErr = Join-Path $tempRoot "executor.err.log"
$server = $null
$worker = $null

function Stop-Child($Process) {
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
}

try {
    $serverArgs = @($Cli, "serve", "--http", "--port", "$Port", "--public-url", $PublicUrl, "--workspace", $Workspace)
    if ($ActiveProjectRoot) {
        $serverArgs += @("--active-project-root", $ActiveProjectRoot, "--active-project-preset", $ActiveProjectPreset)
    }
    Write-Host "[chatgpt2codex] starting local HTTP/OAuth MCP server..."
    $server = Start-Process -FilePath $Node -ArgumentList $serverArgs -PassThru -NoNewWindow -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        if ($server.HasExited) { break }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        $detail = if (Test-Path $serverErr) { Get-Content $serverErr -Raw -ErrorAction SilentlyContinue } else { "" }
        throw "local MCP server did not become ready. $detail"
    }

    if (-not $DisableExecutor -and $ExecutorHubUrl -and ($ExecutorTokenFile -or $env:JK_EXECUTOR_TOKEN)) {
        $workerWorkspace = if ($ExecutorWorkspace) { $ExecutorWorkspace } else { $Workspace }
        $workerArgs = @($Cli, "executor", "--hub", $ExecutorHubUrl, "--executor-id", $ExecutorId, "--workspace", $workerWorkspace)
        if ($ExecutorTokenFile) { $workerArgs += @("--token-file", $ExecutorTokenFile) }
        Write-Host "[chatgpt2codex] starting outbound executor $ExecutorId -> $ExecutorHubUrl"
        $worker = Start-Process -FilePath $Node -ArgumentList $workerArgs -PassThru -NoNewWindow -RedirectStandardOutput $executorOut -RedirectStandardError $executorErr
    }

    Write-Host ""
    Write-Host "============================================================"
    Write-Host " JK is ready"
    Write-Host "============================================================"
    Write-Host " MCP URL: $PublicUrl/mcp"
    Write-Host " Dashboard: http://127.0.0.1:$Port/"
    Write-Host ""
    Write-Host " Public exposure is not managed by JK."
    if ($PublicHostname) { Write-Host " PUBLIC_HOSTNAME is metadata for your externally managed reverse proxy/tunnel." }
    Write-Host "============================================================"

    while (-not $server.HasExited) {
        if ($worker -and $worker.HasExited) {
            Write-Warning "outbound executor exited; local MCP server remains available."
            $worker = $null
        }
        Start-Sleep -Seconds 1
    }
    throw "local MCP server exited"
} finally {
    Stop-Child $worker
    Stop-Child $server
}
