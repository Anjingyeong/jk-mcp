[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\JK"),
  [switch]$NoShortcut
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$PackageDir = Join-Path $Root "build\windows\JK"

if (-not (Test-Path -LiteralPath (Join-Path $PackageDir "start-chatgpt.cmd"))) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build-windows-app.ps1")
  if ($LASTEXITCODE -ne 0) {
    throw "Windows package build failed."
  }
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $PackageDir "*") -Destination $InstallDir -Recurse -Force

function New-ChatGpt2CodexShortcut([string]$ShortcutPath, [string]$TargetPath, [string]$WorkingDirectory, [string]$IconPath) {
  New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($ShortcutPath)) -Force | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = "Start JK"
  $shortcut.IconLocation = "$IconPath,0"
  $shortcut.Save()
}

if (-not $NoShortcut) {
  $programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  $desktop = [Environment]::GetFolderPath("DesktopDirectory")
  if (-not $desktop) {
    $desktop = Join-Path $env:USERPROFILE "Desktop"
  }
  $target = Join-Path $InstallDir "JK.exe"
  if (-not (Test-Path -LiteralPath $target)) {
    $target = Join-Path $InstallDir "start-chatgpt.cmd"
  }
  $icon = Join-Path $InstallDir "JK.ico"
  if (-not (Test-Path -LiteralPath $icon)) {
    $icon = $target
  }

  New-ChatGpt2CodexShortcut (Join-Path $programs "JK.lnk") $target $InstallDir $icon
  New-ChatGpt2CodexShortcut (Join-Path $desktop "JK.lnk") $target $InstallDir $icon
}

Write-Host "JK installed to:"
Write-Host "  $InstallDir"
if (-not $NoShortcut) {
  Write-Host "Shortcuts:"
  Write-Host "  Start Menu: JK"
  Write-Host "  Desktop: JK"
}
