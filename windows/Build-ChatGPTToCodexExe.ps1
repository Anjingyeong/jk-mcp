$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..")
$source = Join-Path $scriptDir "ChatGPTToCodexLauncher.cs"
$out = Join-Path $root "JK.exe"
$iconPng = Join-Path $root "assets\jk-icon.png"
$iconIco = Join-Path $root "assets\JK.ico"

if (-not (Test-Path $source)) {
    throw "Launcher source not found: $source"
}

if (-not (Test-Path -LiteralPath $iconIco)) {
    throw "Windows icon not found: $iconIco. Generate it from assets/jk-icon.png with the portable Windows build first."
}

$cscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw "csc.exe was not found. .NET Framework is required to build JK.exe."
}

$compilerArgs = @(
    "/nologo",
    "/target:winexe",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    "/out:$out",
    "/win32icon:$iconIco"
)
$compilerArgs += $source

& $csc @compilerArgs
if ($LASTEXITCODE -ne 0) {
    throw "C# launcher compilation failed with exit code $LASTEXITCODE."
}

Write-Host "[chatgpt2codex] built $out"
