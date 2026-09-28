[CmdletBinding()]
param(
  [string]$OutputExe = '',
  [string]$PackageDir = '',
  [switch]$SkipPackageBuild
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$BuildRoot = Join-Path $Root 'build\windows'
if (-not $OutputExe -or $OutputExe.Trim().Length -eq 0) {
  $OutputExe = Join-Path $BuildRoot 'JK-Setup.exe'
}
$OutputExe = [IO.Path]::GetFullPath($OutputExe)

function Test-UnderPath([string]$Child, [string]$Parent) {
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
    $childPath.StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Assert-NoReparseAncestors([string]$Path) {
  for ($current = $Path; $current; $current = [IO.Path]::GetDirectoryName($current)) {
    if ((Test-Path -LiteralPath $current) -and
        ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Reparse paths are not supported: $current"
    }
  }
}
function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList) {
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $FilePath" }
}

# Never rebuild into the canonical package, which may be the running installation.
# Supply a prepared package with -SkipPackageBuild -PackageDir <path>.
if (-not $SkipPackageBuild -and $PackageDir) {
  throw '-PackageDir requires -SkipPackageBuild; default builds use an owned temporary package.'
}
if ($SkipPackageBuild) {
  if (-not $PackageDir) { $PackageDir = Join-Path $BuildRoot 'JK' }
  $PackageDir = [IO.Path]::GetFullPath($PackageDir)
  if (Test-UnderPath $OutputExe $PackageDir) { throw 'Installer output must be outside the input package.' }
}
if (Test-UnderPath $OutputExe (Join-Path $BuildRoot 'JK')) {
  throw 'Installer output must be outside the canonical running package.'
}
Assert-NoReparseAncestors $BuildRoot
Assert-NoReparseAncestors $OutputExe
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
$tempDir = Join-Path $BuildRoot ('.jk-installer-' + [Guid]::NewGuid().ToString('N'))
$pending = $OutputExe + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  if (-not $SkipPackageBuild) {
    $PackageDir = Join-Path $tempDir 'package'
    Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      (Join-Path $PSScriptRoot 'build-windows-app.ps1'), '-OutputDir', $PackageDir)
  }
  Assert-NoReparseAncestors $PackageDir
  foreach ($required in @('JK.exe', 'JK.ico', 'package.json')) {
    if (-not [IO.File]::Exists((Join-Path $PackageDir $required))) { throw "Package is missing $required : $PackageDir" }
  }
  # ZipFile follows directory links; reject these instead of packaging external data.
  $directories = New-Object 'System.Collections.Generic.Queue[string]'
  $directories.Enqueue($PackageDir)
  while ($directories.Count -gt 0) {
    foreach ($entry in Get-ChildItem -LiteralPath $directories.Dequeue() -Force) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Package contains a reparse path: $($entry.FullName)" }
      if ($entry.PSIsContainer) { $directories.Enqueue($entry.FullName) }
    }
  }
  $package = Get-Content -LiteralPath (Join-Path $PackageDir 'package.json') -Raw | ConvertFrom-Json
  $version = [string]$package.version
  if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw "Invalid package version: $version"
  }
  $parts = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  foreach ($part in $parts) { if ($part -gt 65534) { throw 'Package version exceeds PE version range.' } }
  $fileVersion = ($parts -join '.') + '.0'
  $information = $version
  $metadata = ''
  $releasePath = Join-Path $PackageDir 'release.json'
  if (Test-Path -LiteralPath $releasePath) {
    $release = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json
    if ($release.schemaVersion -ne 1) { throw 'Unsupported release.json schemaVersion.' }
    $runtimeSha = [string]$release.runtimeSourceSha
    $packagingSha = [string]$release.packagingSourceSha
    foreach ($sha in @($runtimeSha, $packagingSha)) {
      if ($sha -notmatch '^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$') { throw 'release.json source SHA must be a full hexadecimal hash.' }
    }
    $separator = if ($version.Contains('+')) { '.' } else { '+' }
    $information += "${separator}runtime.$runtimeSha.packaging.$packagingSha"
    $metadata = @"
[assembly: AssemblyMetadata("schemaVersion", "1")]
[assembly: AssemblyMetadata("runtimeSourceSha", "$runtimeSha")]
[assembly: AssemblyMetadata("packagingSourceSha", "$packagingSha")]
"@
  }
  $assemblyInfo = Join-Path $tempDir 'SetupAssemblyInfo.cs'
  @"
using System.Reflection;
[assembly: AssemblyTitle("JK Setup")]
[assembly: AssemblyProduct("JK")]
[assembly: AssemblyDescription("JK per-user installer")]
[assembly: AssemblyVersion("$fileVersion")]
[assembly: AssemblyFileVersion("$fileVersion")]
[assembly: AssemblyInformationalVersion("$information")]
$metadata
"@ | Set-Content -LiteralPath $assemblyInfo -Encoding UTF8

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = Join-Path $tempDir 'payload.zip'
  $stub = Join-Path $tempDir 'setup-stub.exe'
  [IO.Compression.ZipFile]::CreateFromDirectory($PackageDir, $zip, [IO.Compression.CompressionLevel]::Fastest, $false)
  $Csc = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $Csc) { throw 'csc.exe was not found; cannot build the installer executable.' }
  Invoke-Checked $Csc @('/nologo', '/target:winexe', "/win32icon:$(Join-Path $PackageDir 'JK.ico')",
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    '/reference:System.Management.dll', '/reference:Microsoft.CSharp.dll', "/out:$stub",
    (Join-Path $Root 'windows\JKSetup.cs'), $assemblyInfo)

  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($OutputExe)) -Force | Out-Null
  [IO.File]::Copy($stub, $pending)
  $stream = [IO.File]::Open($pending, [IO.FileMode]::Append, [IO.FileAccess]::Write)
  try {
    $payload = [IO.File]::OpenRead($zip)
    try { $payload.CopyTo($stream); $lengthBytes = [BitConverter]::GetBytes([Int64]$payload.Length) }
    finally { $payload.Dispose() }
    $marker = [Text.Encoding]::ASCII.GetBytes('JK_SETUP_PAYLOAD_V1')
    $stream.Write($marker, 0, $marker.Length)
    $stream.Write($lengthBytes, 0, $lengthBytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  # Same-directory publication leaves a preexisting installer untouched on failure.
  if ([IO.File]::Exists($OutputExe)) {
    # Windows PowerShell converts $null to an empty string for this overload.
    [IO.File]::Replace($pending, $OutputExe, [System.Management.Automation.Language.NullString]::Value)
  }
  else { [IO.File]::Move($pending, $OutputExe) }
} finally {
  if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
  Remove-Item -LiteralPath $tempDir -Recurse -Force
}
Write-Host "Windows installer ready: $OutputExe"
Write-Host "Version: $information (unsigned; source metadata is not a signing claim)"
Write-Host 'Isolated validation: /InstallDir <absolute LocalAppData child> /NoShortcuts /NoLaunch /Quiet'
