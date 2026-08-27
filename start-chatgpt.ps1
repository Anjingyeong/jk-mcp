param(
    [string]$Workspace = $env:WORKSPACE,
    [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 7979 }),
    [string]$PublicHostname = $env:PUBLIC_HOSTNAME,
    [string]$ActiveProjectRoot = $env:CHATGPT2CODEX_ACTIVE_PROJECT_ROOT,
    [string]$ActiveProjectPreset = $(if ($env:CHATGPT2CODEX_ACTIVE_PROJECT_PRESET) { $env:CHATGPT2CODEX_ACTIVE_PROJECT_PRESET } else { "full-write" }),
    [string]$ExecutorHubUrl = $(if ($env:JK_HUB_URL) { $env:JK_HUB_URL } else { "" }),
    [string]$ExecutorId = $(if ($env:JK_EXECUTOR_ID) { $env:JK_EXECUTOR_ID } else { "windows-main" }),
    [string]$ExecutorWorkspace = $env:JK_EXECUTOR_WORKSPACE,
    [string]$ExecutorTokenFile = $(if ($env:JK_EXECUTOR_TOKEN_FILE) {
        $env:JK_EXECUTOR_TOKEN_FILE
    } elseif ($env:LOCALAPPDATA) {
        $existingTokenFile = Join-Path $env:LOCALAPPDATA "JK\executor-token.txt"
        if (Test-Path -LiteralPath $existingTokenFile) { $existingTokenFile } else { "" }
    } else {
        ""
    }),
    [switch]$ExposeWeb,
    [switch]$RotateOwnerToken,
    [switch]$ExecutorOnly = $(if ($env:JK_EXECUTOR_ONLY -eq "1") { $true } else { $false }),
    [switch]$DisableExecutor
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PATH = "$Root\bin;$env:ProgramFiles\nodejs;$env:USERPROFILE\.local\bin;$env:PATH"

function Resolve-RuntimeMode([string]$RuntimeRoot) {
    $sourceDir = Join-Path $RuntimeRoot "src"
    $tsconfig = Join-Path $RuntimeRoot "tsconfig.json"
    if ((Test-Path -LiteralPath $sourceDir) -and (Test-Path -LiteralPath $tsconfig)) {
        return "development"
    }
    return "portable"
}

function Get-StartupStatusLines([bool]$RuntimeRunning, [bool]$EndpointAvailable, [bool]$Connected) {
    $lines = @()
    $lines += if ($RuntimeRunning) { "JK runtime is running" } else { "Waiting for JK runtime" }
    $lines += if ($EndpointAvailable) { "MCP endpoint available" } else { "Waiting for MCP endpoint" }
    if ($RuntimeRunning -and $EndpointAvailable -and $Connected) {
        $lines += "JK is ready"
    } else {
        $lines += "Waiting for ChatGPT connection"
    }
    return $lines
}

$runtimeMode = Resolve-RuntimeMode $Root
$env:JK_RUNTIME_MODE = $runtimeMode
$env:JK_RUNTIME_ROOT = [System.IO.Path]::GetFullPath($Root)
Write-Host "[chatgpt2codex] runtime mode: $runtimeMode"
Write-Host "[chatgpt2codex] runtime root: $($env:JK_RUNTIME_ROOT)"

$machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
$userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
$pathParts = @("$Root\\bin")
$programFilesRoot = if ($env:ProgramFiles) { $env:ProgramFiles } elseif ($env:ProgramW6432) { $env:ProgramW6432 } elseif ($env:SystemDrive) { "$($env:SystemDrive)\\Program Files" } else { "C:\\Program Files" }
$pathParts += (Join-Path $programFilesRoot "nodejs")
if ($env:LOCALAPPDATA) { $pathParts += (Join-Path $env:LOCALAPPDATA "Microsoft\\WinGet\\Packages\\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe") }
if ($env:USERPROFILE) { $pathParts += (Join-Path $env:USERPROFILE ".local\\bin") }
foreach ($candidate in @($machinePath, $userPath, $env:PATH)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) { $pathParts += $candidate }
}
$env:PATH = ($pathParts -join ";")

if (-not $Workspace) {
    $Workspace = Join-Path $HOME "workspace"
}
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
$cfOut = Join-Path $tempRoot "cloudflared.out.log"
$cfErr = Join-Path $tempRoot "cloudflared.err.log"
$srvOut = Join-Path $tempRoot "server.out.log"
$srvErr = Join-Path $tempRoot "server.err.log"
$executorOut = Join-Path $tempRoot "executor.out.log"
$executorErr = Join-Path $tempRoot "executor.err.log"

function Need-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command: $Name"
    }
}

function Test-SourceBuildRequired([string]$SourceRoot) {
    $cliPath = Join-Path $SourceRoot "dist\cli.js"
    if (-not (Test-Path -LiteralPath $cliPath)) {
        return $true
    }

    $sourceDir = Join-Path $SourceRoot "src"
    if (-not (Test-Path -LiteralPath $sourceDir)) {
        return $false
    }

    $distStamp = (Get-Item -LiteralPath $cliPath).LastWriteTimeUtc
    $watchFiles = @(
        (Join-Path $SourceRoot "package.json"),
        (Join-Path $SourceRoot "package-lock.json"),
        (Join-Path $SourceRoot "tsconfig.json")
    )
    foreach ($file in $watchFiles) {
        if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).LastWriteTimeUtc -gt $distStamp) {
            return $true
        }
    }

    foreach ($file in Get-ChildItem -LiteralPath $sourceDir -Recurse -File -ErrorAction SilentlyContinue) {
        if ($file.LastWriteTimeUtc -gt $distStamp) {
            return $true
        }
    }
    return $false
}

function Quote-Arg([string]$Value) {
    if ($Value -match '^[A-Za-z0-9_\-.:/\\=]+$') {
        return $Value
    }
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Start-LoggedProcess([string]$File, [string[]]$ArgumentList, [string]$Stdout, [string]$Stderr) {
    Remove-Item -Force -ErrorAction SilentlyContinue $Stdout, $Stderr
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $File
    $psi.Arguments = (($ArgumentList | ForEach-Object { Quote-Arg $_ }) -join " ")
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    $process.Start() | Out-Null
    Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData $Stdout -Action {
        if ($EventArgs.Data) { Add-Content -Path $Event.MessageData -Value $EventArgs.Data }
    } | Out-Null
    Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData $Stderr -Action {
        if ($EventArgs.Data) { Add-Content -Path $Event.MessageData -Value $EventArgs.Data }
    } | Out-Null
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
    return $process
}

function Stop-LegacyExecutorProcessByScript([string]$ExpectedScript) {
    if (-not $ExpectedScript) { return 0 }
    try {
        $expected = [System.IO.Path]::GetFullPath($ExpectedScript).ToLowerInvariant()
        $stopped = 0
        $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
        foreach ($candidate in $processes) {
            $commandLine = [string]$candidate.CommandLine
            if ($commandLine -and $commandLine.ToLowerInvariant().Contains($expected)) {
                Stop-Process -Id ([int]$candidate.ProcessId) -Force -ErrorAction SilentlyContinue
                $stopped++
            }
        }
        return $stopped
    } catch {
        return 0
    }
}

function Migrate-LegacyWindowsExecutor {
    $baseDir = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA "JK"
    } elseif ($ExecutorTokenFile) {
        Split-Path -Parent $ExecutorTokenFile
    } else {
        return
    }

    $migrated = $false
    $startup = [Environment]::GetFolderPath("Startup")
    if ($startup) {
        $legacyLauncher = Join-Path $startup "JK Executor.cmd"
        if (Test-Path -LiteralPath $legacyLauncher) {
            try {
                $legacyText = Get-Content -Raw -LiteralPath $legacyLauncher -ErrorAction Stop
                if ($legacyText -match 'executor-supervisor\.js') {
                    Remove-Item -Force -LiteralPath $legacyLauncher -ErrorAction SilentlyContinue
                    $migrated = $true
                }
            } catch {
            }
        }
    }

    $supervisorScript = Join-Path $baseDir "executor-supervisor.js"
    $workerScript = Join-Path $baseDir "executor-worker.js"
    if ((Stop-LegacyExecutorProcessByScript $supervisorScript) -gt 0) { $migrated = $true }
    Start-Sleep -Milliseconds 200
    if ((Stop-LegacyExecutorProcessByScript $workerScript) -gt 0) { $migrated = $true }

    foreach ($legacyFile in @(
        "executor-supervisor.lock",
        "executor-worker.lock",
        "executor-restart.request",
        "executor-supervisor.js",
        "executor-worker.js"
    )) {
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $baseDir $legacyFile)
    }

    if ($migrated) {
        Write-Host "[chatgpt2codex] migrated legacy standalone Windows executor into JK app lifecycle."
    }
}

function Test-PortBusy([int]$PortToCheck) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $PortToCheck)
        $listener.Start()
        return $false
    } catch {
        return $true
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Wait-HttpOk([string]$Url, [int]$Tries, [string]$Label) {
    for ($i = 0; $i -lt $Tries; $i++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $Url
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                return
            }
        } catch {
        }
        Start-Sleep -Seconds 1
    }
    throw "$Label did not become ready: $Url"
}

function Resolve-HostWithCloudflareDoh([string]$HostName) {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) { return @() }

    try {
        $queryUrl = "https://cloudflare-dns.com/dns-query?name=$([System.Uri]::EscapeDataString($HostName))&type=A"
        $jsonText = & curl.exe --silent --show-error --resolve "cloudflare-dns.com:443:1.1.1.1" -H "accept: application/dns-json" --max-time 8 $queryUrl
        if ($LASTEXITCODE -ne 0) { return @() }
        $json = ($jsonText -join "`n") | ConvertFrom-Json
        return @($json.Answer | Where-Object { $_.type -eq 1 -and $_.data } | ForEach-Object { [string]$_.data })
    } catch {
        return @()
    }
}

function Test-HttpOkWithCurlResolve([string]$Url) {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) { return $false }

    try {
        $uri = [System.Uri]::new($Url)
        if ($uri.Scheme -ne "https") { return $false }
        $ips = Resolve-HostWithCloudflareDoh $uri.Host
        foreach ($ip in $ips) {
            $resolve = "$($uri.Host):443:$ip"
            $output = & curl.exe --silent --show-error --resolve $resolve --connect-timeout 5 --max-time 10 --write-out "`nHTTP_STATUS:%{http_code}" $Url
            $text = ($output -join "`n")
            $statusMatch = [regex]::Match($text, "HTTP_STATUS:(\d+)")
            $status = if ($statusMatch.Success) { [int]$statusMatch.Groups[1].Value } else { 0 }
            if ($LASTEXITCODE -eq 0 -and $status -ge 200 -and $status -lt 300) {
                return $true
            }
        }
    } catch {
    }
    return $false
}

function Wait-PublicHttpOk([string]$Url, [int]$Tries, [string]$Label) {
    for ($i = 0; $i -lt $Tries; $i++) {
        $standardError = $null
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $Url
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                return
            }
        } catch {
            $standardError = $_.Exception.Message
        }
        if ($standardError -and ($i % 5 -eq 0) -and
            (Test-HttpOkWithCurlResolve $Url)) {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "$Label did not become ready: $Url"
}

function Get-QuickTunnelUrl {
    $text = ""
    foreach ($path in @($cfOut, $cfErr)) {
        if (Test-Path $path) {
            $text += "`n" + (Get-Content -Raw -ErrorAction SilentlyContinue $path)
        }
    }
    $matches = [regex]::Matches($text, 'https://[A-Za-z0-9.-]+\.trycloudflare\.com')
    if ($matches.Count -gt 0) {
        return $matches[0].Value
    }
    return $null
}

function Wait-QuickTunnelUrl([System.Diagnostics.Process]$Process, [int]$Tries) {
    for ($i = 0; $i -lt $Tries; $i++) {
        $url = Get-QuickTunnelUrl
        if ($url) { return $url }
        if ($Process.HasExited) {
            throw "cloudflared exited early. See $cfOut and $cfErr"
        }
        Start-Sleep -Seconds 1
    }
    throw "Quick Tunnel URL did not appear. See $cfOut and $cfErr"
}

function Start-QuickTunnelWithRetry([int]$Attempts) {
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if ($attempt -gt 1) {
            Write-Host "[chatgpt2codex] retrying public tunnel ($attempt/$Attempts)..."
            Start-Sleep -Seconds ([Math]::Min(10, 2 * $attempt))
        }

        $process = Start-LoggedProcess "cloudflared" @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port") $cfOut $cfErr
        try {
            $url = Wait-QuickTunnelUrl $process 45
            return [pscustomobject]@{ Process = $process; Url = $url }
        } catch {
            $lastError = $_
            Stop-Child $process
        }
    }

    if ($lastError) { throw $lastError }
    throw "Quick Tunnel URL did not appear. See $cfOut and $cfErr"
}

function Stop-Child([System.Diagnostics.Process]$Process) {
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
}

function Test-PathUnder([string]$Value, [string]$Parent) {
    if (-not $Value -or -not $Parent) { return $false }
    try {
        $fullValue = [System.IO.Path]::GetFullPath($Value.Trim('"')).TrimEnd('\')
        $fullParent = [System.IO.Path]::GetFullPath($Parent.Trim('"')).TrimEnd('\')
        return $fullValue.Equals($fullParent, [System.StringComparison]::OrdinalIgnoreCase) -or
            $fullValue.StartsWith($fullParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Stop-StaleRuntimeProcesses([int]$PortToStop) {
    $currentPid = $PID
    $escapedRoot = [regex]::Escape($Root)
    $escapedExecutorId = [regex]::Escape($ExecutorId)
    $stopped = @()

    foreach ($proc in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
        $procPid = [int]$proc.ProcessId
        if ($procPid -eq $currentPid -or $procPid -le 0) { continue }

        $cmd = [string]$proc.CommandLine
        $exe = [string]$proc.ExecutablePath
        if (-not $cmd -and -not $exe) { continue }

        $isRuntimeProcess = (Test-PathUnder $exe $Root) -or ($cmd -match $escapedRoot)
        if (-not $isRuntimeProcess) { continue }

        $isSamePortServer = $cmd -match "dist[\\/]+cli\.js" -and
            $cmd -match "\bserve\b" -and
            $cmd -match "\b--port\s+$PortToStop\b"
        $isSamePortTunnel = $cmd -match "\bcloudflared(\.exe)?\b" -and
            ($cmd -match "127\.0\.0\.1:$PortToStop" -or $cmd -match "localhost:$PortToStop")
        $isLauncherScript = $cmd -match "start-chatgpt\.ps1" -and
            ($cmd -match "\b-Port\s+$PortToStop\b" -or $cmd -match $escapedRoot)
        $isSameExecutor = $cmd -match "dist[\\/]+cli\.js" -and
            $cmd -match "\bexecutor\b" -and
            $cmd -match ('\b--executor-id\s+"?' + $escapedExecutorId + '"?(\s|$)')

        if ($isSamePortServer -or $isSamePortTunnel -or $isLauncherScript -or $isSameExecutor) {
            try {
                Stop-Process -Id $procPid -Force -ErrorAction SilentlyContinue
                $stopped += "$($proc.Name)#$procPid"
            } catch {
            }
        }
    }

    if ($stopped.Count -gt 0) {
        Write-Host "[chatgpt2codex] stopped stale runtime process(es): $($stopped -join ', ')"
        Start-Sleep -Milliseconds 800
    }
}

function Test-McpAuthenticationRequired([string]$Url) {
    try {
        $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri $Url
        return $false
    } catch {
        $response = $_.Exception.Response
        if ($response -and $null -ne $response.StatusCode) {
            return ([int]$response.StatusCode -eq 401)
        }
        return $false
    }
}

Need-Command node
Set-Location $Root

if (Test-SourceBuildRequired $Root) {
    Need-Command npm
    if (Test-Path (Join-Path $Root "dist\cli.js")) {
        Write-Host "[chatgpt2codex] source is newer than dist/cli.js; rebuilding..."
    } else {
        Write-Host "[chatgpt2codex] dist/cli.js missing; building..."
    }
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "TypeScript build failed."
    }
}

$cli = Join-Path $Root "dist\cli.js"
if (-not $DisableExecutor -and $ExecutorHubUrl -and ($ExecutorTokenFile -or $env:JK_EXECUTOR_TOKEN)) {
    Migrate-LegacyWindowsExecutor
}
if ($ExecutorOnly) {
    if ($DisableExecutor) {
        throw "ExecutorOnly cannot be combined with DisableExecutor."
    }
    if (-not $ExecutorHubUrl) {
        throw "ExecutorOnly requires JK_HUB_URL or -ExecutorHubUrl."
    }
    if (-not ($ExecutorTokenFile -or $env:JK_EXECUTOR_TOKEN)) {
        throw "ExecutorOnly requires JK_EXECUTOR_TOKEN or JK_EXECUTOR_TOKEN_FILE."
    }

    Stop-StaleRuntimeProcesses $Port

    $workerWorkspace = if ($ExecutorWorkspace -and (Test-Path -LiteralPath $ExecutorWorkspace -PathType Container)) {
        [System.IO.Path]::GetFullPath($ExecutorWorkspace)
    } else {
        if ($ExecutorWorkspace) {
            Write-Host "[chatgpt2codex] executor workspace not found: $ExecutorWorkspace; falling back to $Workspace"
        }
        $Workspace
    }
    $workerArgs = @($cli, "executor", "--hub", $ExecutorHubUrl, "--executor-id", $ExecutorId, "--workspace", $workerWorkspace)
    if ($ExecutorTokenFile) {
        $workerArgs += @("--token-file", $ExecutorTokenFile)
    }

    $executorProc = $null
    $executorQuickFailureCount = 0
    $executorStartedAt = $null
    try {
        Write-Host "[chatgpt2codex] hybrid executor-only mode; the configured remote hub is the authoritative MCP/dashboard/approval control plane."
        Write-Host "[chatgpt2codex] starting outbound executor $ExecutorId -> $ExecutorHubUrl"
        $executorProc = Start-LoggedProcess "node" $workerArgs $executorOut $executorErr
        $executorStartedAt = Get-Date
        Write-Host "[chatgpt2codex] local MCP/Approvals server is disabled in this mode. Set JK_EXECUTOR_ONLY=0 for explicit local recovery mode."

        while ($true) {
            if ($executorProc -and $executorProc.HasExited) {
                $executorExitCode = $executorProc.ExitCode
                $executorUptimeSeconds = if ($executorStartedAt) { ((Get-Date) - $executorStartedAt).TotalSeconds } else { 0 }
                if ($executorUptimeSeconds -lt 20) { $executorQuickFailureCount += 1 } else { $executorQuickFailureCount = 0 }
                if ($executorQuickFailureCount -ge 3) {
                    throw "executor failed 3 times within 20 seconds. See $executorErr"
                }
                $restartDelaySeconds = @(1, 3, 8)[$executorQuickFailureCount - 1]
                Write-Host "[chatgpt2codex] executor exited with code $executorExitCode; restarting in $restartDelaySeconds second(s)..."
                Start-Sleep -Seconds $restartDelaySeconds
                $executorProc = Start-LoggedProcess "node" $workerArgs $executorOut $executorErr
                $executorStartedAt = Get-Date
            }
            Start-Sleep -Seconds 1
        }
    } finally {
        Stop-Child $executorProc
    }
    return
}

Write-Host "[chatgpt2codex] Local mode owns only its local runtime and local owner token."
Stop-StaleRuntimeProcesses $Port
if (Test-PortBusy $Port) {
    throw "Port $Port is already in use. Set PORT or stop the other process."
}

if ($RotateOwnerToken -or $env:CHATGPT2CODEX_ROTATE_OWNER_TOKEN -eq "1") {
    Write-Host "[chatgpt2codex] generating owner token..."
    $tokenJsonText = node $cli owner-token --generate --workspace $Workspace
    if ($LASTEXITCODE -ne 0) {
        throw "Owner token generation failed."
    }
    $tokenResult = ($tokenJsonText -join "`n") | ConvertFrom-Json
    if (-not $tokenResult.ownerToken) {
        throw "Owner token generation did not return a token."
    }
    Write-Host ""
    Write-Host "chatgpt2codex init: generated a new HTTP owner token (shown once, never logged again):"
    Write-Host ""
    Write-Host "  $($tokenResult.ownerToken)"
    Write-Host ""
    Write-Host "Store this securely. It is required to approve ChatGPT/MCP connections."
}
$doctor = node $cli doctor 2>$null
if (($doctor -join "`n") -notmatch "owner token configured") {
    throw "Owner token is not configured. Open JK settings and generate or set an owner token first."
}

$cfProc = $null
$srvProc = $null
$executorProc = $null
$executorQuickFailureCount = 0
$executorStartedAt = $null
try {
    $managedTunnelRequested = [bool]($cloudflaredToken -or $cloudflaredName)
    $quickTunnelRequested = [bool](($ExposeWeb -or $env:CHATGPT2CODEX_EXPOSE_WEB -eq "1") -and -not $PublicHostname -and -not $managedTunnelRequested)
    $usePublicEndpoint = [bool]($PublicHostname -or $managedTunnelRequested -or $quickTunnelRequested)
    $idleShutdownMinutes = $env:CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES
    if ($managedTunnelRequested) {
        Need-Command cloudflared
        Write-Host "[chatgpt2codex] 1/3 starting public tunnel..."
        if (-not $PublicHostname) {
            throw "PUBLIC_HOSTNAME is required with CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME."
        }
        $publicUrl = "https://$PublicHostname"
        if ($cloudflaredToken) {
            $cfProc = Start-LoggedProcess "cloudflared" @("tunnel", "--no-autoupdate", "run", "--token", $cloudflaredToken) $cfOut $cfErr
        } else {
            $cfProc = Start-LoggedProcess "cloudflared" @("tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:$Port", $cloudflaredName) $cfOut $cfErr
        }
    } elseif ($PublicHostname) {
        $publicUrl = "https://$PublicHostname"
        Write-Host "[chatgpt2codex] 1/2 using externally managed public tunnel: $PublicHostname"
    } elseif ($quickTunnelRequested) {
        Need-Command cloudflared
        Write-Host "[chatgpt2codex] 1/3 starting temporary Quick Tunnel..."
        $quickTunnel = Start-QuickTunnelWithRetry 4
        $cfProc = $quickTunnel.Process
        $publicUrl = $quickTunnel.Url
    } else {
        $publicUrl = "http://127.0.0.1:$Port"
        Write-Host "[chatgpt2codex] 1/2 loopback-only mode; no public tunnel."
    }

    Write-Host "[chatgpt2codex] 2/3 starting local HTTP/OAuth MCP server..."
    $serverArgs = @($cli, "serve", "--http", "--port", "$Port", "--public-url", $publicUrl, "--workspace", $Workspace)
    if ($idleShutdownMinutes) {
        $serverArgs += @("--idle-shutdown-minutes", "$idleShutdownMinutes")
    }
    if ($ActiveProjectRoot) {
        $serverArgs += @("--active-project-root", $ActiveProjectRoot, "--active-project-preset", $ActiveProjectPreset)
    }
    Write-Host "[chatgpt2codex] starting local HTTP/OAuth MCP server..."
    $server = Start-Process -FilePath $Node -ArgumentList $serverArgs -PassThru -NoNewWindow -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

    if (-not $DisableExecutor -and $ExecutorHubUrl -and ($ExecutorTokenFile -or $env:JK_EXECUTOR_TOKEN)) {
        $workerWorkspace = if ($ExecutorWorkspace -and (Test-Path -LiteralPath $ExecutorWorkspace -PathType Container)) {
            [System.IO.Path]::GetFullPath($ExecutorWorkspace)
        } else {
            if ($ExecutorWorkspace) {
                Write-Host "[chatgpt2codex] executor workspace not found: $ExecutorWorkspace; falling back to $Workspace"
            }
            $Workspace
        }
        $workerArgs = @($cli, "executor", "--hub", $ExecutorHubUrl, "--executor-id", $ExecutorId, "--workspace", $workerWorkspace)
        if ($ExecutorTokenFile) {
            $workerArgs += @("--token-file", $ExecutorTokenFile)
        }
        Write-Host "[chatgpt2codex] starting outbound executor $ExecutorId -> $ExecutorHubUrl"
        $executorProc = Start-LoggedProcess "node" $workerArgs $executorOut $executorErr
        $executorStartedAt = Get-Date
    }

    Write-Host ""
    Write-Host "[chatgpt2codex] connector URL:"
    Write-Host "   $publicUrl/mcp"
    Write-Host ""

    $endpointAvailable = $false
    if ($usePublicEndpoint) {
        Write-Host "[chatgpt2codex] 3/3 checking public health..."
        $publicHealthAvailable = $false
        try {
            Wait-PublicHttpOk "$publicUrl/healthz" 60 "public endpoint"
            $publicHealthAvailable = $true
        } catch {
            Write-Host "[chatgpt2codex] public health check is still warming up: $($_.Exception.Message)"
            Write-Host "[chatgpt2codex] keeping the server and tunnel alive; retry health from the app or ChatGPT."
        }
        if ($publicHealthAvailable) {
            $endpointAvailable = Test-McpAuthenticationRequired "$publicUrl/mcp"
            if (-not $endpointAvailable) {
                throw "Public MCP endpoint did not return the required unauthenticated HTTP 401."
            }
        }
    } else {
        $endpointAvailable = Test-McpAuthenticationRequired "http://127.0.0.1:$Port/mcp"
        if (-not $endpointAvailable) {
            throw "Local MCP endpoint did not return the required unauthenticated HTTP 401."
        }
    }

    Write-Host ""
    Write-Host "============================================================"
    Write-Host " JK Local Mode status"
    Write-Host "============================================================"
    foreach ($line in Get-StartupStatusLines $true $endpointAvailable $false) {
        Write-Host " $line"
    }
    Write-Host " MCP URL:"
    Write-Host ""
    Write-Host "   $publicUrl/mcp"
    Write-Host ""
    Write-Host " Notes:"
    Write-Host "   - Keep this window or tray app running."
    Write-Host "   - Default mode is loopback-only and is not reachable from ChatGPT web."
    if ($executorProc) {
        Write-Host "   - Executor $ExecutorId is connected outbound to $ExecutorHubUrl."
    }
    Write-Host "   - Enable ChatGPT web tunnel only while a public URL is needed."
    Write-Host "   - Web mode stays running unless CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES is set."
    if ($quickTunnelRequested) {
        Write-Host "   - This trycloudflare.com URL is temporary and changes when the tunnel restarts."
        Write-Host "   - For a ChatGPT app you keep using, configure PUBLIC_HOSTNAME with a named tunnel."
    } elseif ($PublicHostname -and -not $managedTunnelRequested) {
        Write-Host "   - PUBLIC_HOSTNAME is using an externally managed tunnel/service; JK will not start a second cloudflared process."
    }
    Write-Host "   - If the owner token appeared in a chat/screenshot, rotate it."
    Write-Host "============================================================"

    while (-not $server.HasExited) {
        if ($worker -and $worker.HasExited) {
            Write-Warning "outbound executor exited; local MCP server remains available."
            $worker = $null
        }
        if ($cfProc -and $cfProc.HasExited) { throw "cloudflared exited. See $cfOut and $cfErr" }
        if ($executorProc -and $executorProc.HasExited) {
            $executorExitCode = $executorProc.ExitCode
            $executorUptimeSeconds = if ($executorStartedAt) { ((Get-Date) - $executorStartedAt).TotalSeconds } else { 0 }
            if ($executorUptimeSeconds -lt 20) {
                $executorQuickFailureCount += 1
            } else {
                $executorQuickFailureCount = 0
            }
            if ($executorQuickFailureCount -ge 3) {
                Write-Warning "[chatgpt2codex] executor failed 3 times within 20 seconds; supervision paused to avoid a restart loop. Restart JK after checking $executorErr."
                $executorProc = $null
                $executorStartedAt = $null
            } else {
                $restartDelaySeconds = @(1, 3, 8)[$executorQuickFailureCount - 1]
                Write-Host "[chatgpt2codex] executor exited with code $executorExitCode; restarting under JK app supervision in $restartDelaySeconds second(s)..."
                Start-Sleep -Seconds $restartDelaySeconds
                $executorProc = Start-LoggedProcess "node" $workerArgs $executorOut $executorErr
                $executorStartedAt = Get-Date
            }
        }
        Start-Sleep -Seconds 1
    }
    throw "local MCP server exited"
} finally {
    Stop-Child $executorProc
    Stop-Child $srvProc
    Stop-Child $cfProc
}
