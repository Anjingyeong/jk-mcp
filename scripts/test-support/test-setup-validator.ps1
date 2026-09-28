[CmdletBinding()]
param([string]$Report = 'C:\JK\.omo\jk-distribution-cleanup-20260907\validator-seam.json')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$work = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('Temp\jk-validator-seam-' + [Guid]::NewGuid().ToString('N'))
$child = $null
Add-Type -Path (Join-Path $PSScriptRoot 'installer-test-support.cs')
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Path (Join-Path $work 'package\assets\nested') -Force | Out-Null
try {
  $package = Join-Path $work 'package'
  $source = Join-Path $work 'Fixture.cs'
  [IO.File]::WriteAllText($source, 'using System; using System.IO; class Fixture { static void Main() { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"unexpected-launch"),"yes"); } }')
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  & $csc /nologo /target:winexe "/out:$(Join-Path $package 'JK.exe')" $source
  if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed' }
  foreach ($name in @('package.json', 'one.txt', 'two.txt', 'three.txt', 'assets\nested\probe.txt')) {
    [IO.File]::WriteAllText((Join-Path $package $name), 'fixture')
  }
  $installer = Join-Path $work 'JK-Setup.exe'
  & $csc /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Management.dll /reference:Microsoft.CSharp.dll "/out:$installer" (Join-Path $root 'windows\JKSetup.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Actual setup compilation failed' }
  $zip = Join-Path $work 'payload.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($package, $zip)
  $stream = [IO.File]::Open($installer, [IO.FileMode]::Append, [IO.FileAccess]::Write)
  $writer = New-Object IO.BinaryWriter($stream)
  try {
    $bytes = [IO.File]::ReadAllBytes($zip)
    $writer.Write($bytes)
    $writer.Write([Text.Encoding]::ASCII.GetBytes('JK_SETUP_PAYLOAD_V1'))
    $writer.Write([Int64]$bytes.Length)
  } finally { $writer.Dispose() }
  # Same-runspace call is the suite integration; retain a separate CLI exercise.
  & (Join-Path $PSScriptRoot 'validate-full-installer.ps1') -Installer $installer -Report $Report -InstallerTimeoutMilliseconds 30000
  $direct = Get-Content -LiteralPath $Report -Raw | ConvertFrom-Json
  if ($direct.status -ne 'passed' -or $direct.verifiedPayloadFiles -ne 6 -or -not $direct.temporaryResourcesRemoved -or -not $direct.profileIntegrationUnchanged -or -not $direct.runtimeNotLaunched) { throw 'Direct validator assertions failed' }
  $Report += '.cli.json'
  $child = New-Object SetupTestProcess('powershell.exe', ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'validate-full-installer.ps1') + '" -Installer "' + $installer + '" -Report "' + $Report + '" -InstallerTimeoutMilliseconds 30000'))
  try { $exitCode = $child.WaitForExit(60000) }
  catch {
    if (Test-Path -LiteralPath ($Report + '.progress.log')) { Get-Content -LiteralPath ($Report + '.progress.log') | Write-Host }
    throw
  }
  Write-Output $child.Output
  if ($exitCode -ne 0) { throw "Validator exited $exitCode" }
  $result = Get-Content -LiteralPath $Report -Raw | ConvertFrom-Json
  if ($result.status -ne 'passed' -or $result.verifiedPayloadFiles -ne 6 -or -not $result.temporaryResourcesRemoved -or -not $result.profileIntegrationUnchanged -or -not $result.runtimeNotLaunched) { throw 'Validator assertions failed' }
  Write-Output 'PASS actual validator seam; all six files, profile/startup, NoLaunch, and cleanup assertions retained'
} finally {
  if ($null -ne $child) { $child.Dispose() }
  Remove-Item -LiteralPath $work -Recurse -Force
  Write-Output "CLEANUP seam directory removed: $(-not (Test-Path -LiteralPath $work))"
}
