[CmdletBinding()]
param([string]$OutputDir = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = [IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$buildRoot = Join-Path $root 'build\windows'
if ([string]::IsNullOrWhiteSpace($OutputDir)) { $OutputDir = Join-Path $buildRoot 'JK' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir).TrimEnd('\')
$source = Join-Path $scriptDir 'JKLauncher.cs'
$out = Join-Path $OutputDir 'JK.exe'
$iconIco = Join-Path $root 'assets\JK.ico'
if (-not $OutputDir.StartsWith($buildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Launcher output must be strictly below build/windows' }
foreach ($part in $OutputDir.Substring(3).Split('\')) {
    if ($part -match '[:*?"<>|]' -or $part -match '[. ]$') { throw 'Invalid launcher output path' }
}
function Assert-LauncherIdle {
    $current = $out
    while ($current) {
        $item = $null
        try { $item = Get-Item -LiteralPath $current -Force } catch [System.Management.Automation.ItemNotFoundException] { <# A missing path has no link to follow. #> }
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse point is not permitted: $current" }
        $current = Split-Path -Parent $current
    }
    $pattern = '(?i)(?:^|[\s"''])' + [regex]::Escape($OutputDir).Replace('\\', '[\\/]') + '[\\/]'
    foreach ($process in Get-CimInstance Win32_Process) {
        if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($OutputDir + '\', [StringComparison]::OrdinalIgnoreCase)) -or
            ($process.ProcessId -ne $PID -and $process.CommandLine -and $process.CommandLine -match $pattern)) {
            throw "Launcher output target is running (PID $($process.ProcessId))"
        }
    }
}
Assert-LauncherIdle

if (-not (Test-Path $source)) {
    throw "Launcher source not found: $source"
}

if (-not (Test-Path -LiteralPath $iconIco)) {
    throw "Canonical JK Windows icon not found: $iconIco"
}

$cscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw "csc.exe was not found. .NET Framework is required to build JK.exe."
}

[IO.Directory]::CreateDirectory($OutputDir) | Out-Null
$stagedExe = Join-Path $OutputDir ('.jk-launcher-' + [guid]::NewGuid().ToString('N') + '.exe')
$compilerArgs = @(
    "/nologo",
    "/target:winexe",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    "/out:$stagedExe",
    "/win32icon:$iconIco"
)
$compilerArgs += $source

try {
    & $csc @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw "C# launcher compilation failed with exit code $LASTEXITCODE." }
    Assert-LauncherIdle
    if (Test-Path -LiteralPath $out) { [IO.File]::Replace($stagedExe, $out, $null) }
    else { [IO.File]::Move($stagedExe, $out) }
} finally {
    if (Test-Path -LiteralPath $stagedExe) { Remove-Item -LiteralPath $stagedExe -Force }
}
Write-Host "[JK] built $out"
