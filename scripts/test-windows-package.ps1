[CmdletBinding()]
param([string]$ScriptSourceRoot = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
if (-not $ScriptSourceRoot) { $ScriptSourceRoot = $Repo }
$Sandbox = Join-Path ([IO.Path]::GetTempPath()) ('jk-package-test-' + [guid]::NewGuid().ToString('N'))
$Failures = @()
$OriginalPath = $env:PATH
$OriginalCache = $env:npm_config_cache
$OriginalUserConfig = $env:npm_config_userconfig
$OriginalGlobalConfig = $env:npm_config_globalconfig
$OriginalOffline = $env:npm_config_offline
$Npm = (Get-Command npm.cmd).Source
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Put([string]$Path, [string]$Text) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function Case([string]$Name, [scriptblock]$Body) {
  try { & $Body; Write-Host "PASS $Name" } catch { $script:Failures += "$Name : $($_.Exception.Message)"; Write-Host "FAIL $Name : $($_.Exception.Message)" }
}
function Run-Builder([string]$Target, [switch]$Runtime) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$Fixture\scripts\build-windows-app.ps1", '-OutputDir', $Target)
  if ($Runtime) { $arguments += @('-RuntimeSource', $RuntimeDir, '-RuntimeSourceSha', $Sha) }
  # Exercise a normal shell wrapper whose command line also contains OutputDir.
  $command = '& powershell.exe ' + (($arguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ' ') + '; exit $LASTEXITCODE'
  return Run-PowerShell @('-NoProfile', '-Command', $command)
}
function Run-PowerShell([string[]]$arguments) {
  $start = [Diagnostics.ProcessStartInfo]::new('powershell.exe')
  $start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    $process.Start() | Out-Null
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); $process.WaitForExit(); throw 'Builder timed out' }
    Write-Host ($stdout.Result + $stderr.Result)
    return $process.ExitCode
  } finally { $process.Dispose() }
}
try {
  $Fixture = Join-Path $Sandbox 'repo'
  $RuntimeDir = Join-Path $Sandbox 'runtime'
  $FakeBin = Join-Path $Sandbox 'fake-bin'
  $CallLog = Join-Path $Sandbox 'npm-calls.txt'
  Put "$Fixture\scripts\placeholder" ''
  Copy-Item "$ScriptSourceRoot\scripts\build-windows-app.ps1" "$Fixture\scripts\build-windows-app.ps1"
  Put "$Fixture\windows\placeholder" ''
  Copy-Item "$ScriptSourceRoot\windows\Build-JKExe.ps1" "$Fixture\windows\Build-JKExe.ps1"
  Put "$Fixture\windows\JKLauncher.cs" 'public class FixtureLauncher { public static void Main() {} }'
  Put "$FakeBin\npm.cmd" "@echo off`r`necho %cd% %*>>`"$CallLog`"`r`nif `"%1`"==`"ci`" exit /b 47`r`nexit /b 0`r`n"
  $env:PATH = "$FakeBin;$OriginalPath"
  $env:npm_config_cache = "$Sandbox\npm-cache"
  $env:npm_config_userconfig = "$Sandbox\npm-user.ini"
  $env:npm_config_globalconfig = "$Sandbox\npm-global.ini"
  $env:npm_config_offline = 'true'
  Put $env:npm_config_userconfig ''
  Put $env:npm_config_globalconfig ''
  Put "$Fixture\src\input.txt" 'fixture source'
  Put "$Fixture\dist\cli.js" 'console.log("fixture-entry");'
  Put "$Fixture\assets\notice.txt" 'fixture asset'
  Copy-Item "$Repo\assets\JK.ico" "$Fixture\assets\JK.ico"
  Copy-Item "$Repo\assets\jk-icon.png" "$Fixture\assets\jk-icon.png"
  Put "$Fixture\package.json" '{"name":"jk","version":"1.2.3"}'
  Put "$Fixture\package-lock.json" '{"name":"jk","version":"1.2.3","lockfileVersion":3,"packages":{"":{"name":"jk","version":"1.2.3"}}}'
  foreach ($name in @('README.md', 'start-jk.ps1', 'start-jk.cmd', 'LICENSE', 'NOTICE')) { Put "$Fixture\$name" "fixture $name" }
  & git -C $Fixture init --quiet
  & git -C $Fixture add .
  & git -C $Fixture -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=NUL commit --quiet -m fixture
  Assert ($LASTEXITCODE -eq 0) 'Fixture git commit failed'
  $Sha = (& git -C $Fixture rev-parse HEAD).Trim()
  foreach ($unsafe in @("$Fixture\build\windows", "$Fixture\build\windows-sibling\JK")) {
    Case "reject unsafe output $([IO.Path]::GetFileName($unsafe)) before external work" {
      # Given: an unsafe output and an observable external command boundary.
      Remove-Item $CallLog -Force -ErrorAction Ignore
      # When
      $code = Run-Builder $unsafe
      # Then
      Assert ($code -ne 0 -and -not (Test-Path $CallLog)) 'Unsafe output reached npm instead of failing before work'
    }
  }
  Case 'preserve prior target when source dependency install fails' {
    # Given
    $target = "$Fixture\build\windows\preserved"
    Put "$target\sentinel" 'prior payload'
    # When
    $code = Run-Builder $target
    # Then
    Assert ($code -ne 0 -and (Test-Path "$target\sentinel")) 'Failed build destroyed prior target'
    Assert ((Get-Content "$target\sentinel" -Raw) -eq 'prior payload') 'Prior target bytes changed'
  }
  Case 'reject junction escape before external work' {
    # Given
    [IO.Directory]::CreateDirectory("$Sandbox\outside") | Out-Null
    $junction = "$Fixture\build\windows\escape"
    New-Item -ItemType Junction -Path $junction -Target "$Sandbox\outside" | Out-Null
    try {
      Remove-Item $CallLog -Force -ErrorAction Ignore
      # When
      $code = Run-Builder "$junction\JK"
      # Then
      Assert ($code -ne 0 -and -not (Test-Path $CallLog)) 'Junction escape reached npm'
    } finally { [IO.Directory]::Delete($junction) }
  }
  Case 'reject running output before npm or launcher compilation' {
    # Given: an external node executing inside the canonical output, ready on stdout.
    $target = "$Fixture\build\windows\JK"
    Put "$target\dist\hold.js" 'console.log("ready"); process.stdin.resume();'
    $start = [Diagnostics.ProcessStartInfo]::new((Get-Command node.exe).Source, ('"' + "$target\dist\hold.js" + '"'))
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardInput = $true
    $running = [Diagnostics.Process]::new()
    $running.StartInfo = $start
    try {
      $running.Start() | Out-Null
      $ready = $running.StandardOutput.ReadLineAsync()
      Assert ($ready.Wait(5000) -and $ready.Result -eq 'ready') 'Fixture process did not become ready'
      Remove-Item $CallLog -Force -ErrorAction Ignore
      # When
      $code = Run-Builder $target
      $launcherCode = Run-PowerShell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$Fixture\windows\Build-JKExe.ps1")
      # Then
      Assert ($code -ne 0 -and -not (Test-Path $CallLog)) 'Running runtime reached npm'
      Assert ($launcherCode -ne 0 -and -not (Test-Path "$Fixture\JK.exe")) 'Launcher compiled over a running target'
    } finally {
      if (-not $running.HasExited) { $running.StandardInput.Close(); if (-not $running.WaitForExit(5000)) { $running.Kill(); $running.WaitForExit() } }
      $running.Dispose()
    }
  }
  Case 'launcher default compiles only canonical output' {
    # Given: minimal C# source compiled by the actual installed compiler.
    # When
    $code = Run-PowerShell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$Fixture\windows\Build-JKExe.ps1")
    # Then
    Assert ($code -eq 0 -and (Test-Path "$Fixture\build\windows\JK\JK.exe")) 'Canonical launcher was not compiled'
    Assert (-not (Test-Path "$Fixture\JK.exe")) 'Root launcher was emitted'
  }
  Case 'repackage unchanged runtime with real production-only npm ci' {
    # Given: local tarball dependencies exercise real npm without registry or lifecycle execution.
    $env:PATH = $OriginalPath
    $packages = @{}
    foreach ($name in @('fixture-prod', 'fixture-dev')) {
      $dir = "$Sandbox\$name"
      Put "$dir\package.json" "{`"name`":`"$name`",`"version`":`"1.0.0`",`"scripts`":{`"install`":`"exit 91`"}}"
      Put "$dir\LICENSE" 'fixture dependency license'
      Push-Location $dir
      try { & $Npm pack --ignore-scripts --offline --quiet; Assert ($LASTEXITCODE -eq 0) 'npm pack failed' } finally { Pop-Location }
      $archive = "$dir\$name-1.0.0.tgz"
      $hash = [Security.Cryptography.SHA512]::Create()
      try { $integrity = 'sha512-' + [Convert]::ToBase64String($hash.ComputeHash([IO.File]::ReadAllBytes($archive))) } finally { $hash.Dispose() }
      $packages[$name] = @{ version = '1.0.0'; resolved = 'file:' + $archive.Replace('\', '/'); integrity = $integrity }
    }
    $package = @{ name = 'jk'; version = '1.2.3'; dependencies = @{ 'fixture-prod' = $packages['fixture-prod'].resolved }; devDependencies = @{ 'fixture-dev' = $packages['fixture-dev'].resolved } }
    $lockPackages = @{ '' = $package; 'node_modules/fixture-prod' = $packages['fixture-prod']; 'node_modules/fixture-dev' = $packages['fixture-dev'] }
    $lockPackages['node_modules/fixture-dev'].dev = $true
    Put "$RuntimeDir\package.json" ($package | ConvertTo-Json -Depth 8)
    Put "$RuntimeDir\package-lock.json" (@{ name = 'jk'; version = '1.2.3'; lockfileVersion = 3; packages = $lockPackages } | ConvertTo-Json -Depth 8)
    Copy-Item "$Fixture\dist" "$RuntimeDir\dist" -Recurse
    Copy-Item "$Fixture\assets" "$RuntimeDir\assets" -Recurse
    foreach ($name in @('README.md', 'start-jk.ps1', 'start-jk.cmd', 'LICENSE', 'NOTICE')) { Copy-Item "$Fixture\$name" "$RuntimeDir\$name" }
    Copy-Item "$Repo\assets\JK.ico" "$RuntimeDir\JK.ico"
    Put "$RuntimeDir\JK.exe" 'MZ fixture launcher'
    Put "$RuntimeDir\bin\cloudflared.exe" 'MZ fixture cloudflared'
    Put "$RuntimeDir\bin\rg.exe" 'MZ fixture rg'
    Copy-Item (Get-Command node.exe).Source "$RuntimeDir\bin\node.exe"
    Put "$RuntimeDir\.env" 'secret-not-for-distribution'
    Put "$RuntimeDir\bin\executor-token.txt" 'must not copy'
    Put "$RuntimeDir\bin\NOTICE.txt" 'binary notice'
    Put "$RuntimeDir\node_modules\fixture-dev\secret.txt" 'must not copy'
    $sourceEntry = 'src/input.txt:' + (Get-FileHash "$Fixture\src\input.txt" -Algorithm SHA256).Hash.ToLowerInvariant()
    $buildEntry = 'cli.js:' + (Get-FileHash "$RuntimeDir\dist\cli.js" -Algorithm SHA256).Hash.ToLowerInvariant()
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
      $sourceFingerprint = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($sourceEntry)))).Replace('-', '').ToLowerInvariant()
      $buildFingerprint = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($buildEntry)))).Replace('-', '').ToLowerInvariant()
    } finally { $hash.Dispose() }
    Put "$RuntimeDir\dist\runtime-schema-manifest.json" (@{ version = 1; sourceFiles = @('src/input.txt'); buildFiles = @('cli.js'); sourceFingerprint = $sourceFingerprint; buildFingerprint = $buildFingerprint } | ConvertTo-Json)
    $target = "$Fixture\build\windows\production"
    Put "$target\obsolete.txt" 'previous release'
    # When
    $code = Run-Builder $target -Runtime
    # Then
    Assert ($code -eq 0) 'Runtime repackaging failed'
    Assert (Test-Path "$target\node_modules\fixture-prod\LICENSE") 'Production dependency/license missing'
    foreach ($forbidden in @('node_modules/fixture-dev', '.env', 'src', '.git', 'bin/executor-token.txt', 'obsolete.txt')) { Assert (-not (Test-Path "$target\$forbidden")) "Forbidden payload: $forbidden" }
    foreach ($file in @('dist/cli.js', 'JK.exe', 'bin/node.exe', 'bin/rg.exe', 'bin/cloudflared.exe', 'bin/NOTICE.txt', 'LICENSE', 'NOTICE', 'package-lock.json')) {
      Assert ((Get-FileHash "$target\$file").Hash -eq (Get-FileHash "$RuntimeDir\$file").Hash) "Changed runtime bytes: $file"
    }
    $release = Get-Content "$target\release.json" -Raw | ConvertFrom-Json
    Assert ($release.schemaVersion -eq 1 -and $release.name -eq 'jk' -and $release.version -eq '1.2.3') 'Invalid release identity'
    Assert ($release.runtimeSourceSha -eq $Sha -and $release.packagingSourceSha -eq $Sha) 'Incorrect release SHAs'
    Assert ($release.sourceFingerprint -eq $sourceFingerprint -and $release.buildFingerprint -eq $buildFingerprint) 'Incorrect release fingerprints'
    & "$target\bin\node.exe" "$target\dist\cli.js"
    Assert ($LASTEXITCODE -eq 0) 'Packaged entry did not execute'
  }
  Case 'preserve prior target when staged production install fails' {
    # Given: a valid runtime and npm boundary failing specifically in the staging cwd.
    $env:PATH = "$FakeBin;$OriginalPath"
    $target = "$Fixture\build\windows\failed-ci"
    Put "$target\sentinel" 'prior payload'
    Remove-Item $CallLog -Force -ErrorAction Ignore
    try {
      # When
      $code = Run-Builder $target -Runtime
      # Then
      Assert ($code -ne 0 -and (Test-Path "$target\sentinel")) 'Failed production ci destroyed prior target'
      $calls = Get-Content $CallLog -Raw
      Assert ($calls -match '\.jk-stage-[a-f0-9]+ ci --omit=dev --ignore-scripts') 'Failure did not occur at staged production ci'
    } finally { $env:PATH = $OriginalPath }
  }
  Case 'source mode builds from root and stages an actual launcher' {
    # Given: fake only the TypeScript build; real npm ci and C# compilation in the fixture.
    Copy-Item "$RuntimeDir\dist\runtime-schema-manifest.json" "$Fixture\dist\runtime-schema-manifest.json"
    Put "$Fixture\node_modules\typescript\bin\tsc" 'fixture compiler boundary'
    foreach ($tool in @('cloudflared.exe', 'rg.exe')) { Copy-Item "$RuntimeDir\bin\$tool" "$FakeBin\$tool" }
    Put "$FakeBin\npm.cmd" "@echo off`r`necho %cd% %*>>`"$CallLog`"`r`nif `"%1`"==`"run`" exit /b 0`r`ncall `"$Npm`" %*`r`nexit /b %errorlevel%`r`n"
    Remove-Item $CallLog -Force -ErrorAction Ignore
    $lockHash = (Get-FileHash "$Fixture\package-lock.json").Hash
    $env:PATH = "$FakeBin;$OriginalPath"
    try {
      # When
      $code = Run-Builder "$Fixture\build\windows\source-build"
      # Then
      Assert ($code -eq 0) 'Source-mode fixture build failed'
      Assert ((Get-Content $CallLog -Raw).Contains("$Fixture run build")) 'Source build used ambient cwd'
      Assert ((Get-FileHash "$Fixture\package-lock.json").Hash -eq $lockHash) 'Source lockfile changed'
      Assert (Test-Path "$Fixture\build\windows\source-build\JK.exe") 'Staged launcher missing'
    } finally { $env:PATH = $OriginalPath }
  }
  Case 'reject tampered build without changing existing output' {
    # Given
    Put "$RuntimeDir\dist\cli.js" 'tampered'
    $target = "$Fixture\build\windows\tampered"
    Put "$target\sentinel" 'prior payload'
    # When
    $code = Run-Builder $target -Runtime
    # Then
    Assert ($code -ne 0 -and (Test-Path "$target\sentinel")) 'Tampered runtime published or prior target lost'
  }
  Case 'clean only owned staging on success and failure' {
    # Given/When: completed build scenarios above. Then: no temporary publish directories.
    $leftovers = @(Get-ChildItem "$Fixture\build\windows" -Force | Where-Object { $_.Name -match '^\.jk-(stage|backup)-' })
    Assert ($leftovers.Count -eq 0) 'Staging or backup leaked'
  }
} finally {
  $env:PATH = $OriginalPath
  $env:npm_config_cache = $OriginalCache
  $env:npm_config_userconfig = $OriginalUserConfig
  $env:npm_config_globalconfig = $OriginalGlobalConfig
  $env:npm_config_offline = $OriginalOffline
  if (Test-Path $Sandbox) { Remove-Item $Sandbox -Recurse -Force }
  Write-Host "Fixture cleanup completed: $Sandbox"
}
if ($Failures.Count) { throw ($Failures -join "`n") }
Write-Host 'All Windows packaging tests passed.'
