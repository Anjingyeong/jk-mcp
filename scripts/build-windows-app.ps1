[CmdletBinding()]
param(
  [string]$OutputDir = '',
  [string]$RuntimeSource = '',
  [string]$RuntimeSourceSha = ''
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$Path) {
  $getFileHash = Get-Command Get-FileHash -ErrorAction SilentlyContinue
  if ($getFileHash) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '') }
    finally { $stream.Dispose() }
  } finally { $sha256.Dispose() }
}
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$BuildRoot = Join-Path $Root 'build\windows'
if ([string]::IsNullOrWhiteSpace($OutputDir)) { $OutputDir = Join-Path $BuildRoot 'JK' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir).TrimEnd('\')

function Assert-PlainPath([string]$Path) {
  $current = $Path
  while ($current) {
    $item = $null
    try { $item = Get-Item -LiteralPath $current -Force } catch [System.Management.Automation.ItemNotFoundException] { <# A missing path has no link to follow. #> }
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse point is not permitted: $current" }
    $current = Split-Path -Parent $current
  }
}
function Assert-PlainTree([string]$Path) {
  Assert-PlainPath $Path
  if (Test-Path -LiteralPath $Path -PathType Container) {
    foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is not permitted: $($child.FullName)" }
      if ($child.PSIsContainer) { Assert-PlainTree $child.FullName }
    }
  }
}
function Assert-OutputIdle {
  if (-not $OutputDir.StartsWith($BuildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Output must be strictly below $BuildRoot" }
  # Reject Windows aliases (ADS, trailing dots/spaces), not just lexical prefix escapes.
  foreach ($part in $OutputDir.Substring(3).Split('\')) {
    if ($part -match '[:*?"<>|]' -or $part -match '[. ]$') { throw "Invalid output path component: $part" }
  }
  Assert-PlainTree $OutputDir
  if ((Test-Path -LiteralPath $OutputDir) -and -not (Test-Path -LiteralPath $OutputDir -PathType Container)) { throw 'Output must be a directory' }
  $pattern = '(?i)(?:^|[\s"''])' + [regex]::Escape($OutputDir).Replace('\\', '[\\/]') + '[\\/]'
  foreach ($process in Get-CimInstance Win32_Process) {
    if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($OutputDir + '\', [StringComparison]::OrdinalIgnoreCase)) -or
        ($process.ProcessId -ne $PID -and $process.CommandLine -and $process.CommandLine -match $pattern)) {
      throw "Output target is running (PID $($process.ProcessId)); stop it before packaging."
    }
  }
}
function Invoke-Checked([string]$Tool, [string[]]$Arguments) {
  & $Tool @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Tool" }
}
function Get-Fingerprint([string]$Base, [object[]]$Files) {
  if ($Files.Count -eq 0) { throw 'Empty fingerprint file list' }
  $entries = foreach ($relative in $Files) {
    if ($relative -isnot [string] -or [IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)|:') { throw 'Invalid manifest file path' }
    $path = [IO.Path]::GetFullPath((Join-Path $Base $relative))
    if (-not $path.StartsWith($Base.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest file escapes its root' }
    Assert-PlainPath $path
    $relative.Replace('\', '/') + ':' + (Get-Sha256 $path).ToLowerInvariant()
  }
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
}
function Assert-Manifest([string]$Base) {
  $manifest = Get-Content -LiteralPath (Join-Path $Base 'dist\runtime-schema-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.version -ne 1 -or $manifest.sourceFingerprint -notmatch '^[a-f0-9]{64}$' -or $manifest.buildFingerprint -notmatch '^[a-f0-9]{64}$') { throw 'Invalid runtime schema manifest' }
  if ((Get-Fingerprint $Root $manifest.sourceFiles) -ne $manifest.sourceFingerprint) { throw 'Source fingerprint mismatch with packaging checkout' }
  if ((Get-Fingerprint (Join-Path $Base 'dist') $manifest.buildFiles) -ne $manifest.buildFingerprint) { throw 'Build fingerprint mismatch' }
  return $manifest
}
function Assert-Payload([string]$Base) {
  foreach ($file in @('JK.exe', 'JK.ico', 'bin\node.exe', 'bin\cloudflared.exe', 'bin\rg.exe', 'dist\cli.js', 'dist\runtime-schema-manifest.json', 'package.json', 'package-lock.json', 'start-jk.ps1', 'start-jk.cmd')) {
    $path = Join-Path $Base $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) { throw "Required runtime file missing or empty: $file" }
  }
}

# All boundary checks precede directory creation, dependency installation and compilation.
Assert-OutputIdle
if ($RuntimeSource) {
  if ($RuntimeSourceSha -notmatch '^[a-fA-F0-9]{40}$') { throw 'RuntimeSource requires a full 40-character RuntimeSourceSha' }
  $RuntimeSource = [IO.Path]::GetFullPath($RuntimeSource).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $RuntimeSource -PathType Container)) { throw 'RuntimeSource must be an existing runtime directory' }
  if ($OutputDir.Equals($RuntimeSource, [StringComparison]::OrdinalIgnoreCase) -or
      $OutputDir.StartsWith($RuntimeSource + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $RuntimeSource.StartsWith($OutputDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'RuntimeSource and output must not overlap' }
  Assert-PlainPath $RuntimeSource
} elseif ($RuntimeSourceSha) { throw 'RuntimeSourceSha requires RuntimeSource' }
$PackagingSourceSha = (& git -C $Root rev-parse --verify HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $PackagingSourceSha -notmatch '^[a-f0-9]{40}$') { throw 'A Git packaging checkout is required' }
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$PayloadSource = if ($RuntimeSource) { $RuntimeSource } else { $Root }
$Stage = $null
$Backup = $null
$Published = $false
$mutexHash = [Security.Cryptography.SHA256]::Create()
try { $mutexKey = [BitConverter]::ToString($mutexHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($OutputDir.ToLowerInvariant()))).Replace('-', '') } finally { $mutexHash.Dispose() }
$mutex = [Threading.Mutex]::new($false, ('Local\JK-package-' + $mutexKey))
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { throw 'Another builder owns this output target' }
  if ($RuntimeSource) {
    Assert-Payload $PayloadSource
    $manifest = Assert-Manifest $PayloadSource
    $resolvedSha = (& git -C $Root rev-parse --verify ($RuntimeSourceSha + '^{commit}')).Trim()
    if ($LASTEXITCODE -ne 0 -or $resolvedSha -ne $RuntimeSourceSha.ToLowerInvariant()) { throw 'RuntimeSourceSha is not a commit in this checkout' }
    # Fingerprinted sources must also belong to the asserted commit, not merely the current working tree.
    Invoke-Checked 'git' (@('-C', $Root, 'diff', '--quiet', $RuntimeSourceSha, '--') + @($manifest.sourceFiles))
  } else {
    $RuntimeSourceSha = $PackagingSourceSha
    Push-Location $Root
    try {
      if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\typescript\bin\tsc'))) { Invoke-Checked $Npm @('ci', '--ignore-scripts') }
      Invoke-Checked $Npm @('run', 'build')
    } finally { Pop-Location }
    $manifest = Assert-Manifest $Root
  }
  $parent = Split-Path -Parent $OutputDir
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $Stage = Join-Path $parent ('.jk-stage-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($Stage) | Out-Null
  $payload = @('dist', 'browser', 'assets', 'licenses', 'notices', 'package.json', 'package-lock.json', 'README.md', 'start-jk.ps1', 'start-jk.cmd')
  $payload += @(Get-ChildItem -LiteralPath $PayloadSource -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|COPYING|THIRD[-_]PARTY)([._-].*)?$' } | ForEach-Object { $_.Name })
  if ($RuntimeSource) {
    $payload += @('JK.exe', 'JK.ico', 'bin/node.exe', 'bin/cloudflared.exe', 'bin/rg.exe', 'bin/licenses', 'bin/notices')
    $payload += @(Get-ChildItem -LiteralPath (Join-Path $PayloadSource 'bin') -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|COPYING|THIRD[-_]PARTY)([._-].*)?$' } | ForEach-Object { 'bin/' + $_.Name })
  }
  # Hash every copied byte, including files beyond the schema's selected build entries.
  $copiedFiles = @()
  foreach ($item in $payload) {
    $source = Join-Path $PayloadSource $item
    if (Test-Path -LiteralPath $source) {
      Assert-PlainTree $source
      $copiedFiles += @(Get-ChildItem -LiteralPath $source -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($PayloadSource.Length + 1).Replace('\', '/') })
      if (Test-Path -LiteralPath $source -PathType Leaf) { $copiedFiles += $item }
      $destination = Join-Path $Stage $item
      [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
      Copy-Item -LiteralPath $source -Destination $destination -Recurse
    }
  }
  $copiedFiles = @($copiedFiles | Sort-Object -Unique)
  $payloadFingerprint = Get-Fingerprint $PayloadSource $copiedFiles
  if (-not $RuntimeSource) {
    [IO.Directory]::CreateDirectory((Join-Path $Stage 'bin')) | Out-Null
    foreach ($tool in @('node.exe', 'cloudflared.exe', 'rg.exe')) {
      $toolPath = (Get-Command $tool -ErrorAction Stop).Source
      Copy-Item -LiteralPath $toolPath -Destination (Join-Path $Stage "bin\$tool")
    }
    Copy-Item -LiteralPath (Join-Path $Root 'assets\JK.ico') -Destination (Join-Path $Stage 'JK.ico')
    & (Join-Path $Root 'windows\Build-JKExe.ps1') -OutputDir $Stage
  }
  Push-Location $Stage
  try { Invoke-Checked $Npm @('ci', '--omit=dev', '--ignore-scripts') } finally { Pop-Location }
  Assert-PlainTree $Stage
  Assert-Payload $Stage
  $outputManifest = Assert-Manifest $Stage
  if ($outputManifest.buildFingerprint -ne $manifest.buildFingerprint -or
      (Get-Fingerprint $Stage $copiedFiles) -ne $payloadFingerprint -or
      (Get-Fingerprint $PayloadSource $copiedFiles) -ne $payloadFingerprint) { throw 'Runtime payload changed during packaging' }
  # npm's installed lock records actual payload, including transitive dev-only packages.
  $installedLock = Join-Path $Stage 'node_modules\.package-lock.json'
  if (Test-Path -LiteralPath $installedLock) {
    $installed = Get-Content -LiteralPath $installedLock -Raw | ConvertFrom-Json
    foreach ($entry in $installed.packages.PSObject.Properties) {
      if ($entry.Value.PSObject.Properties['dev'] -and $entry.Value.dev) { throw "Development dependency was installed: $($entry.Name)" }
    }
  }
  $package = Get-Content -LiteralPath (Join-Path $Stage 'package.json') -Raw | ConvertFrom-Json
  $release = [ordered]@{ schemaVersion = 1; name = $package.name; version = $package.version; runtimeSourceSha = $RuntimeSourceSha.ToLowerInvariant(); sourceFingerprint = $manifest.sourceFingerprint; buildFingerprint = $manifest.buildFingerprint; packagingSourceSha = $PackagingSourceSha }
  [IO.File]::WriteAllText((Join-Path $Stage 'release.json'), (($release | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
  Assert-OutputIdle
  if (Test-Path -LiteralPath $OutputDir) {
    $Backup = Join-Path $parent ('.jk-backup-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::Move($OutputDir, $Backup)
  }
  try { [IO.Directory]::Move($Stage, $OutputDir); $Published = $true } catch {
    if ($Backup) { [IO.Directory]::Move($Backup, $OutputDir); $Backup = $null }
    throw
  }
} finally {
  if ($Stage -and (Test-Path -LiteralPath $Stage)) { Remove-Item -LiteralPath $Stage -Recurse -Force }
  if ($Published -and $Backup) { Remove-Item -LiteralPath $Backup -Recurse -Force }
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
Write-Host "Windows package ready: $OutputDir"
