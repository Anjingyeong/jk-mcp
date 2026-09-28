[CmdletBinding()]
param(
  [string]$Installer = 'C:\JK\chatgpt2codex\build\windows\JK-Setup.exe',
  [string]$Report = (Join-Path ([IO.Path]::GetTempPath()) ('full-installer-validation-' + [Guid]::NewGuid().ToString('N') + '.json')),
  [ValidateRange(1, 300000)][int]$InstallerTimeoutMilliseconds = 300000
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$progressLog = $Report + '.progress.log'
function Trace-Operation([string]$Operation) {
  $line = '{0:o} +{1}ms {2}' -f [DateTime]::UtcNow, $clock.ElapsedMilliseconds, $Operation
  [IO.File]::AppendAllText($progressLog, $line + [Environment]::NewLine)
  Write-Output $line
}
Trace-Operation 'loading process support'
if (-not ('SetupTestProcess' -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot 'installer-test-support.cs')
}
Trace-Operation 'loading compression assemblies'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Installer = [IO.Path]::GetFullPath($Installer)
$local = [Environment]::GetFolderPath('LocalApplicationData')
$owned = Join-Path $local ('Temp\jk-full-installer-validation-' + [Guid]::NewGuid().ToString('N'))
$target = Join-Path $owned 'JK'
$process = $null
$result = [ordered]@{ installer = $Installer; installDir = $target; status = 'failed'; temporaryResourcesRemoved = $false }
function Hash-Stream([IO.Stream]$Stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($Stream)).Replace('-', '') }
  finally { $sha.Dispose() }
}
function Profile-Snapshot {
  $snapshot = [ordered]@{}
  foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Startup'))) {
    foreach ($name in @('JK.lnk', 'ChatGPT To Codex.lnk')) {
      $path = Join-Path $folder $name
      $snapshot[$path] = if ([IO.File]::Exists($path)) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } else { '<absent>' }
    }
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
  try {
    foreach ($name in @('JK', 'ChatGPT To Codex')) {
      $snapshot['Run:' + $name] = if ($null -ne $key) { $key.GetValue($name, '<absent>', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { '<absent>' }
    }
  } finally { if ($null -ne $key) { $key.Dispose() } }
  return ($snapshot | ConvertTo-Json -Compress)
}
try {
  if (-not [IO.File]::Exists($Installer)) { throw "Installer missing: $Installer" }
  Trace-Operation 'hashing installer'
  $result.installerSha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash
  $result.fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($Installer).FileVersion
  $result.informationalVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($Installer).ProductVersion
  Trace-Operation 'snapshotting profile integration'
  $before = Profile-Snapshot
  New-Item -ItemType Directory -Path $owned | Out-Null
  Trace-Operation 'starting isolated installer'
  $process = New-Object SetupTestProcess($Installer, ('/InstallDir "' + $target + '" /NoShortcuts /NoLaunch /Quiet'))
  Trace-Operation ('waiting for installer PID ' + $process.Process.Id)
  $exitCode = $process.WaitForExit($InstallerTimeoutMilliseconds)
  Trace-Operation ('installer exited ' + $exitCode)
  if ($exitCode -ne 0) { throw "Installer failed with exit code $exitCode" }
  if ((Profile-Snapshot) -ne $before) { throw 'Shortcut/startup profile integration changed' }
  $result.profileIntegrationUnchanged = $true
  if ([IO.File]::ReadAllText((Join-Path $target '.jk-install-root')) -ne 'JK_SETUP_INSTALL_V1') { throw 'Install ownership marker missing' }

  # Verify every installed payload file against the actual embedded ZIP, not a CLI dump.
  Trace-Operation 'copying embedded payload ZIP'
  $zipPath = Join-Path $owned 'payload.zip'
  $input = [IO.File]::OpenRead($Installer)
  $reader = New-Object IO.BinaryReader($input)
  try {
    $marker = [Text.Encoding]::ASCII.GetBytes('JK_SETUP_PAYLOAD_V1')
    $input.Position = $input.Length - $marker.Length - 8
    if ([Text.Encoding]::ASCII.GetString($reader.ReadBytes($marker.Length)) -ne 'JK_SETUP_PAYLOAD_V1') { throw 'Invalid installer payload footer' }
    $length = $reader.ReadInt64()
    if ($length -le 0 -or $length -gt $input.Length - $marker.Length - 8) { throw 'Invalid payload length' }
    $input.Position = $input.Length - $marker.Length - 8 - $length
    $zipStream = [IO.File]::Create($zipPath)
    try {
      $buffer = New-Object byte[] (1024 * 1024)
      while ($length -gt 0) {
        $count = $input.Read($buffer, 0, [int][Math]::Min($buffer.Length, $length))
        if ($count -eq 0) { throw 'Unexpected payload end' }
        $zipStream.Write($buffer, 0, $count)
        $length -= $count
      }
    } finally { $zipStream.Dispose() }
  } finally { $reader.Dispose() }
  Trace-Operation 'opening embedded ZIP'
  $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
  $fileCount = 0
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.Name.Length -eq 0) { continue }
      $path = [IO.Path]::GetFullPath((Join-Path $target $entry.FullName.Replace('/', '\')))
      if (-not $path.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload path escapes installation' }
      if (-not [IO.File]::Exists($path)) { throw "Installed payload file missing: $($entry.FullName)" }
      Trace-Operation ('hashing payload entry ' + $entry.FullName)
      $source = $entry.Open()
      $installed = [IO.File]::OpenRead($path)
      try { if ((Hash-Stream $source) -ne (Hash-Stream $installed)) { throw "Installed payload hash mismatch: $($entry.FullName)" } }
      finally { $source.Dispose(); $installed.Dispose() }
      $fileCount++
    }
  } finally { $archive.Dispose() }
  Trace-Operation 'checking installed file count'
  $extraFiles = @(Get-ChildItem -LiteralPath $target -File -Force -Recurse).Count - $fileCount
  if ($extraFiles -ne 1) { throw 'Unexpected installed files beyond the ownership marker' }
  Trace-Operation 'querying runtime processes'
  $running = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) })
  Trace-Operation 'runtime process query complete'
  if ($running.Count -ne 0) { throw '/NoLaunch did not leave the installed runtime stopped' }
  $result.verifiedPayloadFiles = $fileCount
  $result.runtimeNotLaunched = $true
  $result.status = 'passed'
} catch {
  $result.error = $_.Exception.GetBaseException().Message
  throw
} finally {
  Trace-Operation 'disposing installer process'
  if ($null -ne $process) { $process.Dispose() }
  Trace-Operation 'removing owned validation directory'
  if (Test-Path -LiteralPath $owned) { Remove-Item -LiteralPath $owned -Recurse -Force }
  $result.temporaryResourcesRemoved = -not (Test-Path -LiteralPath $owned)
  Trace-Operation 'writing validation report'
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Report -Encoding UTF8
  Write-Output "Validation status: $($result.status); owned temporary resources removed: $($result.temporaryResourcesRemoved)"
  Write-Output "Report: $Report"
}
