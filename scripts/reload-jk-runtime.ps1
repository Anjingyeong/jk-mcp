[CmdletBinding()]
param(
  [string]$Root = "",
  [switch]$UseStage,
  [switch]$ExecutorOnly = $(if ($env:JK_EXECUTOR_ONLY -eq "1" -or [Environment]::GetEnvironmentVariable("JK_EXECUTOR_ONLY", "User") -eq "1") { $true } else { $false }),
  [switch]$Worker
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if (-not $Root -or $Root.Trim().Length -eq 0) {
  $Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}
$Root = [System.IO.Path]::GetFullPath($Root)
$Live = Join-Path $Root "build\windows\JK"
$Next = Join-Path $Root "build\windows\JK-next"
$Stage = Join-Path $Root "build\windows\JK-stage"
$Prev = Join-Path $Root "build\windows\JK-prev"
$Candidate = if ($UseStage) { $Stage } else { $Next }
$LogDir = Join-Path $env:LOCALAPPDATA "JK\logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$Log = Join-Path $LogDir ("runtime-swap-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$BuildRoot = Join-Path $Root "build\windows"

function Write-Log([string]$Message) {
  Add-Content -LiteralPath $Log -Value ((Get-Date -Format o) + " " + $Message)
}

function Normalize-ProcessCommandLine([string]$Value) {
  if (-not $Value) { return "" }
  return $Value.Replace("\\", "\")
}

function Test-RuntimePackage([string]$RuntimeRoot) {
  return (Test-Path -LiteralPath (Join-Path $RuntimeRoot "JK.exe")) -and
    (Test-Path -LiteralPath (Join-Path $RuntimeRoot "start-chatgpt.ps1")) -and
    (Test-Path -LiteralPath (Join-Path $RuntimeRoot "dist\cli.js"))
}

function Prepare-RuntimeCandidate {
  if (Test-RuntimePackage $Candidate) {
    Write-Log ("candidate-ready existing=" + $Candidate)
    return
  }
  if ($UseStage) {
    throw "Legacy JK-stage candidate is missing or incomplete: $Candidate"
  }
  if (Test-Path -LiteralPath $Candidate) {
    Remove-Item -LiteralPath $Candidate -Recurse -Force
  }

  $offlineBuilder = Join-Path $Root "scripts\build-windows-app-offline.ps1"
  $nodeModules = Join-Path $Root "node_modules"
  if (-not (Test-Path -LiteralPath $offlineBuilder)) {
    throw "Offline Windows runtime builder is missing: $offlineBuilder"
  }
  if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
    throw "Cannot prepare JK runtime candidate offline because node_modules is missing: $nodeModules"
  }

  Write-Log ("candidate-build start=" + $Candidate)
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $offlineBuilder -OutputDir $Candidate
  if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath $Candidate) {
      Remove-Item -LiteralPath $Candidate -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw "Offline JK runtime candidate build failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-RuntimePackage $Candidate)) {
    if (Test-Path -LiteralPath $Candidate) {
      Remove-Item -LiteralPath $Candidate -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw "Prepared JK runtime candidate is incomplete: $Candidate"
  }
  Write-Log ("candidate-build ready=" + $Candidate)
}

function Remove-SuccessfulSwapArtifacts {
  foreach ($path in @($Next, $Stage, $Prev)) {
    if ($path -ne $Live -and (Test-Path -LiteralPath $path)) {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $BuildRoot) {
    Get-ChildItem -LiteralPath $BuildRoot -Directory -Filter "JK-broken-*" -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Log "cleanup-success canonical-runtime=JK transient-runtime-folders=removed"
}

function Wait-Listen([int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    try {
      $listener = Get-NetTCPConnection -LocalPort 7979 -State Listen -ErrorAction Stop
      if ($listener) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

function Wait-Executor([int]$Seconds, [int]$StableSeconds = 0) {
  $executorId = if ($env:JK_EXECUTOR_ID) { $env:JK_EXECUTOR_ID } else { "windows-main" }
  $stable = 0
  for ($i = 0; $i -lt $Seconds; $i++) {
    $worker = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $cmd = Normalize-ProcessCommandLine ([string]$_.CommandLine)
      $cmd -like "*$Live\dist\cli.js*" -and
        $cmd -like "* executor *" -and
        $cmd -like "*--executor-id $executorId*"
    } | Select-Object -First 1
    $launcher = Get-CimInstance Win32_Process -Filter "Name='JK.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.ExecutablePath -and ([System.IO.Path]::GetFullPath([string]$_.ExecutablePath) -eq [System.IO.Path]::GetFullPath((Join-Path $Live "JK.exe")))
    } | Select-Object -First 1
    if ($worker -and $launcher) {
      $stable += 1
      if ($stable -ge [Math]::Max(1, $StableSeconds)) { return $true }
    } else {
      $stable = 0
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Test-LocalListener {
  try {
    $listener = Get-NetTCPConnection -LocalPort 7979 -State Listen -ErrorAction Stop
    return [bool]$listener
  } catch {
    return $false
  }
}

function Stop-JkTree {
  $runtimeRoots = @($Live, $Next, $Stage, $Prev)
  $targets = Get-CimInstance Win32_Process | Where-Object {
    $process = $_
    $commandLine = Normalize-ProcessCommandLine ([string]$process.CommandLine)
    $runtimeRoots | Where-Object {
      ($commandLine -and $commandLine -like "*$_*") -or
      ($process.ExecutablePath -and $process.ExecutablePath -like "$_*")
    } | Select-Object -First 1
  }
  foreach ($target in ($targets | Sort-Object ProcessId -Descending)) {
    try {
      Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
      Write-Log ("stopped pid=" + $target.ProcessId + " name=" + $target.Name)
    } catch {
      Write-Log ("stop-warning pid=" + $target.ProcessId + " " + $_.Exception.Message)
    }
  }
  foreach ($target in $targets) {
    try {
      Wait-Process -Id $target.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    } catch {
      Write-Log ("wait-warning pid=" + $target.ProcessId + " " + $_.Exception.Message)
    }
  }
}

function Start-Live {
  $exe = Join-Path $Live "JK.exe"
  if (-not (Test-Path -LiteralPath $exe)) { throw "JK.exe missing after swap: $exe" }
  # Create the replacement launcher through WMI/CIM instead of as a direct
  # child of the swap worker. A runtime upgrade is commonly initiated by the
  # old executor itself; direct child processes can die with that executor's
  # process/job lifetime after the swap command returns.
  $quotedExe = '"' + $exe + '"'
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $quotedExe
    CurrentDirectory = $Live
  } -ErrorAction Stop
  if ([int]$created.ReturnValue -ne 0 -or [int]$created.ProcessId -le 0) {
    throw "detached JK.exe launch failed (return=$($created.ReturnValue) pid=$($created.ProcessId))"
  }
  Write-Log ("started live JK.exe detached pid=" + $created.ProcessId)
}

if (-not $Worker) {
  Prepare-RuntimeCandidate
  $self = $MyInvocation.MyCommand.Path
  $args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $self,
    "-Root", $Root,
    "-Worker"
  )
  if ($UseStage) { $args += "-UseStage" }
  if ($ExecutorOnly) { $args += "-ExecutorOnly" }
  Start-Process -FilePath "powershell.exe" -ArgumentList $args -WindowStyle Hidden | Out-Null
  Write-Output "JK_RUNTIME_SWAP_QUEUED root=$Root candidate=$Candidate"
  exit 0
}

if (-not (Test-RuntimePackage $Candidate)) {
  throw "JK runtime candidate package is missing or incomplete after preparation: $Candidate"
}

Start-Sleep -Seconds 2
Write-Log "swap-start"
if ($ExecutorOnly) { $env:JK_EXECUTOR_ONLY = "1" }
Stop-JkTree
Start-Sleep -Milliseconds 700

try {
  if (Test-Path -LiteralPath $Prev) {
    Remove-Item -LiteralPath $Prev -Recurse -Force
  }
  if (Test-RuntimePackage $Live) {
    Move-Item -LiteralPath $Live -Destination $Prev
  } elseif (Test-Path -LiteralPath $Live) {
    Remove-Item -LiteralPath $Live -Recurse -Force
  } elseif (($Candidate -ne $Stage) -and (Test-RuntimePackage $Stage)) {
    # Bootstrap recovery: if the machine is currently running the temporary
    # JK-stage package and no canonical JK exists yet, preserve that known
    # runnable package as JK-prev before promoting JK-next.
    Move-Item -LiteralPath $Stage -Destination $Prev
  }
  Move-Item -LiteralPath $Candidate -Destination $Live
  Start-Live
  if ($ExecutorOnly) {
    if (-not (Wait-Executor 45 20)) {
      throw "new JK runtime did not keep the outbound executor and launcher alive for 20 consecutive seconds"
    }
    if (Test-LocalListener) {
      throw "executor-only runtime unexpectedly exposed 127.0.0.1:7979"
    }
  } else {
    if (-not (Wait-Listen 20)) {
      throw "new JK runtime did not listen on 127.0.0.1:7979 within 20 seconds"
    }
    $verifySchema = Join-Path $Root "scripts\verify-live-runtime-schema.mjs"
    if (-not (Test-Path -LiteralPath $verifySchema)) {
      throw "runtime schema verifier is missing: $verifySchema"
    }
    & node $verifySchema "http://127.0.0.1:7979" $Live
    if ($LASTEXITCODE -ne 0) {
      throw "new JK runtime failed registered tools/list schema verification"
    }
  }
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $existingRun = (Get-ItemProperty -Path $runKey -Name "JK" -ErrorAction SilentlyContinue).JK
  if ($null -ne $existingRun) {
    $canonicalExe = Join-Path $Live "JK.exe"
    Set-ItemProperty -Path $runKey -Name "JK" -Value ('"' + $canonicalExe + '"')
    Write-Log ("normalized startup target=" + $canonicalExe)
  }
  if ($ExecutorOnly) {
    Write-Log "swap-success mode=executor-only local-port=disabled executor=stable"
  } else {
    Write-Log "swap-success mode=local port=7979 schema=verified"
  }
  Remove-SuccessfulSwapArtifacts
  exit 0
} catch {
  Write-Log ("swap-failed " + $_.Exception.Message)
  try {
    Stop-JkTree
    if (Test-RuntimePackage $Prev) {
      if (Test-Path -LiteralPath $Live) {
        Remove-Item -LiteralPath $Live -Recurse -Force
      }
      Move-Item -LiteralPath $Prev -Destination $Live
      Start-Live
      if ($ExecutorOnly) { [void](Wait-Executor 30 5) } else { [void](Wait-Listen 20) }
      Write-Log "rollback-complete"
    } else {
      Write-Log "rollback-unavailable previous runtime package is incomplete; live candidate retained and log preserved for diagnosis"
    }
  } catch {
    Write-Log ("rollback-failed " + $_.Exception.Message)
  }
  foreach ($path in @($Next, $Stage)) {
    if ($path -ne $Live -and (Test-Path -LiteralPath $path)) {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  throw
}
