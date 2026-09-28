[CmdletBinding()]
param(
  [switch]$Baseline,
  [string]$Evidence = 'C:\JK\.omo\jk-distribution-cleanup-20260907'
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Work = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('Temp\jk-setup-test-' + [Guid]::NewGuid().ToString('N'))
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Path $Work, $Evidence -Force | Out-Null
$Failures = New-Object 'System.Collections.Generic.List[string]'
$OwnedProcesses = New-Object 'System.Collections.Generic.List[object]'
$Junctions = New-Object 'System.Collections.Generic.List[string]'
function Check([string]$Name, [scriptblock]$Body) {
  try { & $Body; Write-Output "PASS $Name" }
  catch { $Failures.Add($Name); Write-Output "FAIL ${Name}: $($_.Exception.GetBaseException().Message)" }
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Call([string]$Name, [object[]]$Arguments) {
  $method = $script:Setup.GetMethod($Name, [Reflection.BindingFlags]'Static,NonPublic,Public')
  if (-not $method) { throw "Required installer boundary missing: $Name" }
  $parameters = $method.GetParameters()
  Assert ($parameters.Length -eq $Arguments.Length) "Wrong argument count for $Name"
  $converted = New-Object object[] $Arguments.Length
  for ($i = 0; $i -lt $Arguments.Length; $i++) {
    $converted[$i] = [Management.Automation.LanguagePrimitives]::ConvertTo($Arguments[$i], $parameters[$i].ParameterType)
  }
  return $method.Invoke($null, $converted)
}
function Reject([scriptblock]$Body) {
  $rejected = $false
  try { & $Body | Out-Null } catch {
    if ($_.Exception -isnot [Management.Automation.MethodInvocationException]) { throw }
    $rejected = $true
  }
  Assert $rejected 'Unsafe input was accepted'
}
function File-Fingerprint([string]$Path) {
  if ([IO.File]::Exists($Path)) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
  return '<absent>'
}
function Integration-Snapshot {
  $snapshot = [ordered]@{}
  foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Startup'))) {
    foreach ($name in @('JK.lnk', 'ChatGPT To Codex.lnk')) {
      $path = Join-Path $folder $name
      $snapshot[$path] = File-Fingerprint $path
    }
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
  try {
    foreach ($name in @('JK', 'ChatGPT To Codex')) {
      $value = if ($null -ne $key) { $key.GetValue($name, '<absent>', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { '<absent>' }
      $snapshot['Run:' + $name] = $value
    }
  } finally { if ($null -ne $key) { $key.Dispose() } }
  # Read-only fingerprints; never log configuration or credential contents.
  foreach ($base in @([Environment]::GetFolderPath('LocalApplicationData'), [Environment]::GetFolderPath('ApplicationData'))) {
    foreach ($name in @('JK', 'chatgpt2codex')) {
      $directory = Join-Path $base $name
      if (Test-Path -LiteralPath $directory) {
        foreach ($file in Get-ChildItem -LiteralPath $directory -File -Force) { $snapshot[$file.FullName] = File-Fingerprint $file.FullName }
      }
    }
  }
  return ($snapshot | ConvertTo-Json -Compress -Depth 5)
}
function Start-Owned([string]$File, [string]$Arguments) {
  $owned = New-Object SetupTestProcess($File, $Arguments)
  $OwnedProcesses.Add($owned)
  return $owned
}
function Run-Installer([string]$Installer, [string]$Target, [int]$ExpectedExit = 0) {
  $owned = Start-Owned $Installer ('/InstallDir "' + $Target + '" /NoShortcuts /NoLaunch /Quiet')
  Assert ($owned.WaitForExit(60000) -eq $ExpectedExit) "Unexpected installer exit for $Target"
  Assert (@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($Target)) -Filter '.jk-setup-*' -Force).Count -eq 0) 'Staging/backup leaked'
}
function Build-Installer([string]$Script, [string]$Package, [string]$Output, [int]$ExpectedExit = 0) {
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $Script + '" -OutputExe "' + $Output + '"'
  if ($Package) { $arguments += ' -SkipPackageBuild -PackageDir "' + $Package + '"' }
  $owned = Start-Owned 'powershell.exe' $arguments
  $exitCode = $owned.WaitForExit(60000)
  Assert ($exitCode -eq $ExpectedExit) "Unexpected installer build exit $exitCode (expected $ExpectedExit): $($owned.Output)"
  if ($ExpectedExit -ne 0) { Write-Output "EXPECTED BUILD FAILURE ($exitCode): $($owned.Output)" }
}
function Replace-Payload([string]$Installer, [string]$Output, [hashtable]$Entries) {
  $bytes = [IO.File]::ReadAllBytes($Installer)
  $marker = [Text.Encoding]::ASCII.GetBytes('JK_SETUP_PAYLOAD_V1')
  $length = [BitConverter]::ToInt64($bytes, $bytes.Length - 8)
  $stubLength = $bytes.Length - 8 - $marker.Length - $length
  $memory = New-Object IO.MemoryStream
  $zip = New-Object IO.Compression.ZipArchive($memory, [IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    foreach ($name in $Entries.Keys) {
      $entry = $zip.CreateEntry($name)
      $outputStream = $entry.Open()
      try { $content = [Text.Encoding]::UTF8.GetBytes($Entries[$name]); $outputStream.Write($content, 0, $content.Length) }
      finally { $outputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
  $stream = [IO.File]::Create($Output)
  try {
    $stream.Write($bytes, 0, [int]$stubLength)
    $payloadBytes = $memory.ToArray()
    $stream.Write($payloadBytes, 0, $payloadBytes.Length)
    $stream.Write($marker, 0, $marker.Length)
    $lengthBytes = [BitConverter]::GetBytes([Int64]$payloadBytes.Length)
    $stream.Write($lengthBytes, 0, $lengthBytes.Length)
  } finally { $stream.Dispose(); $memory.Dispose() }
}
try {
  $library = Join-Path $Work 'setup.dll'
  & $Csc /nologo /target:library /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Management.dll /reference:Microsoft.CSharp.dll "/out:$library" (Join-Path $Root 'windows\JKSetup.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Setup compilation failed' }
  $script:Setup = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($library)).GetType('SetupForm')
  Check 'containment rejects root and sibling' {
    Reject { Call 'EnsureChildPath' @($Work, $Work) }
    Reject { Call 'EnsureChildPath' @(($Work + '-sibling'), $Work) }
  }
  Check 'isolated install options validate before mutation' {
    $target = Join-Path $Work 'isolated'
    $resolved = Call 'ResolveInstallDirectory' @(,[string[]]@('/InstallDir', $target, '/NoShortcuts', '/NoLaunch', '/Quiet'))
    Assert ($resolved -eq $target) 'InstallDir override was not honored'
    Assert (-not (Test-Path -LiteralPath $target)) 'Validation created destination'
  }
  Check 'process matching excludes external executable even when arguments mention target' {
    Assert (-not (Call 'ShouldStopProcess' @('C:\unrelated\JK.exe', $Work))) 'External executable selected'
    Assert (-not (Call 'ShouldStopProcess' @(($Work + '-sibling\JK.exe'), $Work))) 'Sibling executable selected'
    Assert ([bool](Call 'ShouldStopProcess' @((Join-Path $Work 'JK.exe'), $Work))) 'Selected executable ignored'
  }
  Check 'NoShortcuts disables complete integration boundary' {
    Assert (-not (Call 'ShouldCreateShortcuts' @(,[string[]]@('/NoShortcuts')))) 'Integration was not disabled'
    Assert ([bool](Call 'ShouldCreateShortcuts' @(,[string[]]@()))) 'Default integration changed'
  }
  Check 'failed publication restores prior installation' {
    $target = Join-Path $Work 'prior'
    New-Item -ItemType Directory -Path $target | Out-Null
    [IO.File]::WriteAllText((Join-Path $target 'prior.txt'), 'prior-bytes')
    Reject { Call 'PublishInstallation' @((Join-Path $Work 'missing-stage'), $target, (Join-Path $Work 'backup')) }
    Assert ([IO.File]::ReadAllText((Join-Path $target 'prior.txt')) -eq 'prior-bytes') 'Prior installation lost'
    # A missing boundary is not a passing rollback test.
    Assert ($null -ne $script:Setup.GetMethod('PublishInstallation', [Reflection.BindingFlags]'Static,NonPublic')) 'Transactional publisher is missing'
    Assert (-not (Test-Path -LiteralPath (Join-Path $Work 'backup'))) 'Rollback left a backup behind'
  }
  if (-not $Baseline -and $Failures.Count -eq 0) {
    Add-Type -Path (Join-Path $PSScriptRoot 'test-support\installer-test-support.cs')
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $beforeIntegration = Integration-Snapshot
    $liveProcesses = @(Get-CimInstance Win32_Process -Filter "Name='JK.exe' OR Name='chatgpt2codex.exe'" | ForEach-Object { [Diagnostics.Process]::GetProcessById([int]$_.ProcessId) })
    $buildTempsBefore = @(Get-ChildItem -LiteralPath (Join-Path $Root 'build\windows') -Filter '.jk-installer-*' -Force | ForEach-Object Name)
    $package = Join-Path $Work 'package'
    New-Item -ItemType Directory -Path $package | Out-Null
    $fixtureSource = Join-Path $Work 'Fixture.cs'
    @'
using System;
using System.IO;
using System.Threading;
internal static class Fixture {
  private static void Main(string[] args) {
    if (args.Length < 2) { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "was-launched"), "yes"); return; }
    using (var ready = EventWaitHandle.OpenExisting(args[0]))
    using (var release = EventWaitHandle.OpenExisting(args[1])) {
      ready.Set();
      if (!release.WaitOne(120000)) Environment.ExitCode = 9;
    }
  }
}
'@ | Set-Content -LiteralPath $fixtureSource -Encoding UTF8
    & $Csc /nologo /target:winexe "/out:$(Join-Path $package 'JK.exe')" $fixtureSource
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic fixture compilation failed' }
    $icon = [IO.File]::Create((Join-Path $package 'JK.ico'))
    try { [Drawing.SystemIcons]::Application.Save($icon) } finally { $icon.Dispose() }
    [IO.File]::WriteAllText((Join-Path $package 'package.json'), '{"name":"jk-installer-fixture","version":"1.2.3-test"}')
    [IO.File]::WriteAllText((Join-Path $package 'release.json'), ('{"schemaVersion":1,"runtimeSourceSha":"' + ('a' * 40) + '","packagingSourceSha":"' + ('b' * 40) + '"}'))
    [IO.File]::WriteAllText((Join-Path $package 'payload.txt'), 'new-payload')
    New-Item -ItemType Directory -Path (Join-Path $package 'assets\nested') | Out-Null
    [IO.File]::WriteAllText((Join-Path $package 'assets\nested\probe.txt'), 'windows-backslash-entry')
    $installer = Join-Path $Work 'JK-Setup.exe'
    $builder = Join-Path $Root 'scripts\build-windows-installer.ps1'
    Check 'real builder emits versioned installer from prepared tiny package' {
      Build-Installer $builder $package $installer
      $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer)
      Assert ($version.FileVersion -eq '1.2.3.0') 'PE file version mismatch'
      Assert ($version.ProductVersion -eq ('1.2.3-test+runtime.' + ('a' * 40) + '.packaging.' + ('b' * 40))) 'Informational source version mismatch'
      $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($installer))
      $metadata = @($assembly.GetCustomAttributesData() | Where-Object { $_.AttributeType.Name -eq 'AssemblyMetadataAttribute' })
      Assert ($metadata.Count -eq 3) 'Release metadata missing'
    }
    if (-not [IO.File]::Exists($installer)) { throw 'Cannot safely exercise installer without successful build' }
    Check 'unsafe paths and unrelated nonempty destination reject before mutation' {
      $local = [Environment]::GetFolderPath('LocalApplicationData')
      foreach ($path in @('', 'C:\', $local, ($local + '-sibling\JK'), 'relative\JK', (Join-Path $Work 'stream:bad'))) {
        Reject { Call 'ValidateInstallDirectory' @($path) }
      }
      Reject { Call 'ResolveInstallDirectory' @(,[string[]]@('/InstallDir')) }
      Reject { Call 'ResolveInstallDirectory' @(,[string[]]@('/InstallDir', '')) }
      $unrelated = Join-Path $Work 'unrelated'
      New-Item -ItemType Directory -Path $unrelated | Out-Null
      [IO.File]::WriteAllText((Join-Path $unrelated 'keep.txt'), 'untouched')
      Run-Installer $installer $unrelated 1
      Assert ([IO.File]::ReadAllText((Join-Path $unrelated 'keep.txt')) -eq 'untouched') 'Unrelated files were altered'
      Assert (@(Get-ChildItem -LiteralPath $unrelated -Force).Count -eq 1) 'Unrelated directory acquired files'
    }
    Check 'junction ancestor and nested junction reject without following them' {
      $external = Join-Path $Work 'junction-destination'
      $junction = Join-Path $Work 'junction'
      New-Item -ItemType Directory -Path $external | Out-Null
      New-Item -ItemType Junction -Path $junction -Target $external | Out-Null
      $Junctions.Add($junction)
      Reject { Call 'ValidateInstallDirectory' @((Join-Path $junction 'JK')) }
      Run-Installer $installer (Join-Path $junction 'JK') 1
      $container = Join-Path $Work 'nested-reparse'
      New-Item -ItemType Directory -Path $container | Out-Null
      $nested = Join-Path $container 'link'
      New-Item -ItemType Junction -Path $nested -Target $external | Out-Null
      $Junctions.Add($nested)
      Reject { Call 'ValidateInstallDirectory' @($container) }
      Assert (@(Get-ChildItem -LiteralPath $external -Force).Count -eq 0) 'Junction target changed'
    }
    $target = Join-Path $Work 'isolated install'
    Check 'actual isolated installer preserves shortcuts startup and external configuration' {
      Run-Installer $installer $target
      foreach ($file in @('JK.exe', 'JK.ico', 'package.json', 'release.json', 'payload.txt', 'assets\nested\probe.txt')) {
        Assert ((File-Fingerprint (Join-Path $target $file)) -eq (File-Fingerprint (Join-Path $package $file))) "Installed payload mismatch: $file"
      }
      Assert ([IO.File]::ReadAllText((Join-Path $target '.jk-install-root')) -eq 'JK_SETUP_INSTALL_V1') 'Ownership marker missing'
      Assert (-not (Test-Path -LiteralPath (Join-Path $target 'was-launched'))) 'NoLaunch was ignored'
      Assert ((Integration-Snapshot) -eq $beforeIntegration) 'Real profile integration/configuration changed'
    }
    Check 'parent full-validator surface handles native Windows ZIP separators' {
      $reportPath = Join-Path $Work 'full-validator-synthetic.json'
      # Invoke directly: the validator already owns/waits for the actual installer.
      # A second PowerShell wrapper hid progress and timed out before inner cleanup.
      & (Join-Path $PSScriptRoot 'test-support\validate-full-installer.ps1') -Installer $installer -Report $reportPath -InstallerTimeoutMilliseconds 30000
      $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
      Assert ($report.status -eq 'passed' -and $report.verifiedPayloadFiles -eq 6 -and $report.temporaryResourcesRemoved) 'Full validation report mismatch'
    }
    Check 'failed extraction or payload validation preserves prior bytes and process' {
      $readyName = 'Local\JKSetupReady-' + [Guid]::NewGuid().ToString('N')
      $releaseName = 'Local\JKSetupRelease-' + [Guid]::NewGuid().ToString('N')
      $ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $readyName)
      $release = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $releaseName)
      $running = $null
      try {
        $running = Start-Owned (Join-Path $target 'JK.exe') "$readyName $releaseName"
        Assert ($ready.WaitOne(10000)) 'Synthetic prior process did not signal readiness'
        $beforeExe = File-Fingerprint (Join-Path $target 'JK.exe')
        foreach ($case in @('missing-exe', 'zip-traversal', 'invalid-exe', 'truncated-pe')) {
          $bad = Join-Path $Work ($case + '.exe')
          $entries = switch ($case) {
            'missing-exe' { @{ 'payload.txt' = 'bad' } }
            'zip-traversal' { @{ '../escape.txt' = 'bad'; 'JK.exe' = 'MZbad' } }
            'invalid-exe' { @{ 'JK.exe' = 'not-an-executable' } }
            'truncated-pe' { @{ 'JK.exe' = 'MZ-truncated' } }
          }
          Replace-Payload $installer $bad $entries
          Run-Installer $bad $target 1
          Assert ((File-Fingerprint (Join-Path $target 'JK.exe')) -eq $beforeExe) 'Prior executable changed after failed payload'
          Assert ([IO.File]::ReadAllText((Join-Path $target 'payload.txt')) -eq 'new-payload') 'Prior payload changed'
          Assert (-not $running.Process.HasExited) 'Failed payload stopped prior process before validation'
          Assert (-not (Test-Path -LiteralPath (Join-Path $Work 'escape.txt'))) 'ZIP escaped owned staging'
        }
      } finally {
        $release.Set() | Out-Null
        if ($null -ne $running) { $running.WaitForExit(10000) | Out-Null }
        $ready.Dispose(); $release.Dispose()
      }
    }
    Check 'actual reinstall stops only selected executable tree, not same-name sibling or argument reference' {
      $sibling = $target + '-sibling'
      New-Item -ItemType Directory -Path $sibling | Out-Null
      Copy-Item -LiteralPath (Join-Path $package 'JK.exe') -Destination (Join-Path $sibling 'JK.exe')
      $releaseName = 'Local\JKSetupRelease-' + [Guid]::NewGuid().ToString('N')
      $release = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $releaseName)
      $events = New-Object 'System.Collections.Generic.List[object]'
      try {
        $fixtures = @()
        foreach ($directory in @($target, $sibling, $package)) {
          $readyName = 'Local\JKSetupReady-' + [Guid]::NewGuid().ToString('N')
          $ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $readyName)
          $events.Add($ready)
          $fixture = Start-Owned (Join-Path $directory 'JK.exe') ("$readyName $releaseName " + '"' + $target + '"')
          Assert ($ready.WaitOne(10000)) 'Synthetic process did not signal readiness'
          $fixtures += $fixture
        }
        Run-Installer $installer $target
        $fixtures[0].WaitForExit(10000) | Out-Null
        Assert (-not $fixtures[1].Process.HasExited) 'Same-name sibling was killed'
        Assert (-not $fixtures[2].Process.HasExited) 'External executable mentioning target was killed'
        foreach ($live in $liveProcesses) { Assert (-not $live.HasExited) 'Preexisting JK process exited during isolation test' }
      } finally {
        $release.Set() | Out-Null
        foreach ($fixture in $fixtures) { $fixture.WaitForExit(10000) | Out-Null }
        foreach ($event in $events) { $event.Dispose() }
        $release.Dispose()
      }
    }
    Check 'builder preserves prior artifact on invalid metadata and locked publication' {
      $before = File-Fingerprint $installer
      $releasePath = Join-Path $package 'release.json'
      $releaseText = [IO.File]::ReadAllText($releasePath)
      try {
        [IO.File]::WriteAllText($releasePath, '{"schemaVersion":2}')
        Build-Installer $builder $package $installer 1
        Assert ((File-Fingerprint $installer) -eq $before) 'Failed build replaced prior artifact'
      } finally { [IO.File]::WriteAllText($releasePath, $releaseText) }
      $lock = [IO.File]::Open($installer, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      try {
        Build-Installer $builder $package $installer 1
        Assert ((File-Fingerprint $installer) -eq $before) 'Failed publication changed prior artifact'
      } finally { $lock.Dispose() }
      Assert (@(Get-ChildItem -LiteralPath $Work -Filter 'JK-Setup.exe.*.tmp').Count -eq 0) 'Pending installer leaked'
      Build-Installer $builder $package $installer
      try {
        Remove-Item -LiteralPath $releasePath
        $withoutRelease = Join-Path $Work 'without-release.exe'
        Build-Installer $builder $package $withoutRelease
        Assert ([Diagnostics.FileVersionInfo]::GetVersionInfo($withoutRelease).ProductVersion -eq '1.2.3-test') 'Optional release metadata handling failed'
      } finally { [IO.File]::WriteAllText($releasePath, $releaseText) }
      $buildTempsAfter = @(Get-ChildItem -LiteralPath (Join-Path $Root 'build\windows') -Filter '.jk-installer-*' -Force | ForEach-Object Name)
      Assert (($buildTempsAfter -join ',') -eq ($buildTempsBefore -join ',')) 'Installer builder temporary directory leaked'
    }
    Check 'default build uses temporary package below build/windows and emits one artifact' {
      $fixtureRoot = Join-Path $Work 'builder fixture'
      $fixtureScripts = Join-Path $fixtureRoot 'scripts'
      $fixtureWindows = Join-Path $fixtureRoot 'windows'
      New-Item -ItemType Directory -Path $fixtureScripts, $fixtureWindows | Out-Null
      Copy-Item -LiteralPath $builder -Destination $fixtureScripts
      Copy-Item -LiteralPath (Join-Path $Root 'windows\JKSetup.cs') -Destination $fixtureWindows
      $escapedPackage = $package.Replace("'", "''")
      @"
param([string]`$OutputDir)
`$ErrorActionPreference = 'Stop'
`$build = [IO.Path]::GetFullPath((Join-Path `$PSScriptRoot '..\build\windows'))
if (-not `$OutputDir.StartsWith(`$build + '\.jk-installer-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe package build path' }
[IO.File]::WriteAllText((Join-Path `$build 'observed-package-path.txt'), `$OutputDir)
New-Item -ItemType Directory -Path `$OutputDir | Out-Null
Copy-Item -Path '$escapedPackage\*' -Destination `$OutputDir -Recurse
"@ | Set-Content -LiteralPath (Join-Path $fixtureScripts 'build-windows-app.ps1') -Encoding UTF8
      $defaultOutput = Join-Path $fixtureRoot 'build\windows\JK-Setup.exe'
      # Omit OutputExe as well as PackageDir: exercise actual defaults.
      $process = Start-Owned 'powershell.exe' ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $fixtureScripts 'build-windows-installer.ps1') + '"')
      Assert ($process.WaitForExit(60000) -eq 0) 'Default builder failed'
      Assert ([IO.File]::Exists($defaultOutput)) 'Default artifact missing'
      $observed = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'build\windows\observed-package-path.txt'))
      Assert (-not (Test-Path -LiteralPath $observed)) 'Temporary package retained'
      Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixtureRoot 'build\windows') -Filter '*.exe').Count -eq 1) 'Multiple installer artifacts emitted'
      Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixtureRoot 'build\windows') -Directory -Force).Count -eq 0) 'Default build leaked package/staging directory'
    }
    Check 'final real-profile preservation and preexisting process liveness' {
      Assert ((Integration-Snapshot) -eq $beforeIntegration) 'Shortcuts, autorun, or external configuration changed'
      foreach ($live in $liveProcesses) { Assert (-not $live.HasExited) 'Preexisting JK process exited' }
      Write-Output "Preserved preexisting JK processes: $($liveProcesses.Count); profile snapshot unchanged"
    }
  }
} finally {
  foreach ($process in $OwnedProcesses) { $process.Dispose() }
  # Remove junction objects without recursive deletion of their destinations.
  foreach ($junction in $Junctions) { [IO.Directory]::Delete($junction) }
  Remove-Item -LiteralPath $Work -Recurse -Force
  Write-Output "CLEANUP owned test directory removed: $(-not (Test-Path -LiteralPath $Work))"
}
if ($Failures.Count -gt 0) { throw "$($Failures.Count) setup checks failed: $($Failures -join ', ')" }
