[CmdletBinding()]
param(
  [string]$OutputDir = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $OutputDir -or $OutputDir.Trim().Length -eq 0) {
  $OutputDir = Join-Path $Root "build\windows\JK"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$BuildRoot = [System.IO.Path]::GetFullPath((Join-Path $Root "build\windows"))

function Assert-UnderPath([string]$PathToCheck, [string]$ParentPath) {
  $fullChild = [System.IO.Path]::GetFullPath($PathToCheck).TrimEnd('\')
  $fullParent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd('\')
  if (-not $fullChild.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside build root: $fullChild"
  }
}

function Get-ToolPath([string[]]$Names, [switch]$Optional) {
  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
  }
  if ($Optional) { return $null }
  throw "Missing required command: $($Names -join ' or ')"
}

function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList) {
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $FilePath $($ArgumentList -join ' ')"
  }
}

function Download-File([string]$Url, [string]$Destination) {
  $Curl = Get-ToolPath @("curl.exe", "curl")
  Invoke-Checked $Curl @("-L", "--fail", "--retry", "3", "--connect-timeout", "20", "--max-time", "300", "-o", $Destination, $Url)
}

function Copy-Tree([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Source) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
  }
}

function New-WindowsIcon([string]$SourcePng, [string]$DestinationIco) {
  if (-not (Test-Path -LiteralPath $SourcePng)) {
    throw "Icon source not found: $SourcePng"
  }

  Add-Type -AssemblyName System.Drawing
  $sizes = @(256, 128, 64, 48, 32, 16)
  $frames = New-Object System.Collections.Generic.List[byte[]]
  $source = [System.Drawing.Bitmap]::new($SourcePng)
  try {
    foreach ($size in $sizes) {
      $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $scale = [Math]::Min($size / $source.Width, $size / $source.Height)
        $width = [Math]::Max(1, [int][Math]::Round($source.Width * $scale))
        $height = [Math]::Max(1, [int][Math]::Round($source.Height * $scale))
        $x = [int][Math]::Floor(($size - $width) / 2)
        $y = [int][Math]::Floor(($size - $height) / 2)
        $graphics.DrawImage($source, $x, $y, $width, $height)
      } finally {
        $graphics.Dispose()
      }

      $stream = [System.IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames.Add($stream.ToArray())
      } finally {
        $stream.Dispose()
        $bitmap.Dispose()
      }
    }
  } finally {
    $source.Dispose()
  }

  $file = [System.IO.File]::Open($DestinationIco, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $writer = [System.IO.BinaryWriter]::new($file)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$frames.Count)
    $offset = 6 + (16 * $frames.Count)
    for ($i = 0; $i -lt $frames.Count; $i++) {
      $size = $sizes[$i]
      $bytes = $frames[$i]
      $dimension = if ($size -eq 256) { 0 } else { $size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$bytes.Length)
      $writer.Write([UInt32]$offset)
      $offset += $bytes.Length
    }
    foreach ($bytes in $frames) {
      $writer.Write($bytes)
    }
  } finally {
    $writer.Dispose()
    $file.Dispose()
  }
}

Assert-UnderPath $OutputDir $BuildRoot

$Npm = Get-ToolPath @("npm.cmd")
if (-not (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
  throw "Offline node_modules is missing. Run npm install once before using the offline Windows packager."
}
Write-Host "[chatgpt2codex] using existing offline dependencies..."
Write-Host "[chatgpt2codex] building TypeScript..."
Invoke-Checked $Npm @("run", "build")

if (Test-Path -LiteralPath $OutputDir) {
  Remove-Item -LiteralPath $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $OutputDir "bin") -Force | Out-Null

Copy-Tree (Join-Path $Root "dist") (Join-Path $OutputDir "dist")
Copy-Tree (Join-Path $Root "browser") (Join-Path $OutputDir "browser")
Copy-Tree (Join-Path $Root "assets") (Join-Path $OutputDir "assets")

$IconPath = Join-Path $OutputDir "JK.ico"
New-WindowsIcon (Join-Path $Root "assets\jk-icon.png") $IconPath

foreach ($file in @("package.json", "package-lock.json")) {
  Copy-Item -LiteralPath (Join-Path $Root $file) -Destination (Join-Path $OutputDir $file) -Force
}

Write-Host "[chatgpt2codex] copying offline node_modules..."
Copy-Tree (Join-Path $Root "node_modules") (Join-Path $OutputDir "node_modules")

foreach ($file in @("README.md", "start-chatgpt.ps1", "start-chatgpt.cmd")) {
  Copy-Item -LiteralPath (Join-Path $Root $file) -Destination (Join-Path $OutputDir $file) -Force
}

$Node = Get-ToolPath @("node.exe") -Optional
if ($Node) {
  Copy-Item -LiteralPath $Node -Destination (Join-Path $OutputDir "bin\node.exe") -Force
} else {
  throw "node.exe was not found. Node is required to build and package JK."
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("chatgpt2codex-windows-app-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
try {
$Cloudflared = Get-ToolPath @("cloudflared.exe", "cloudflared") -Optional
if ($Cloudflared) {
  Copy-Item -LiteralPath $Cloudflared -Destination (Join-Path $OutputDir "bin\cloudflared.exe") -Force
} else {
  $Cloudflared = Join-Path $TempDir "cloudflared.exe"
  Write-Host "[chatgpt2codex] downloading Windows cloudflared..."
  Download-File "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" $Cloudflared
  Copy-Item -LiteralPath $Cloudflared -Destination (Join-Path $OutputDir "bin\cloudflared.exe") -Force
}

$Ripgrep = Get-ToolPath @("rg.exe", "rg") -Optional
if ($Ripgrep) {
  Copy-Item -LiteralPath $Ripgrep -Destination (Join-Path $OutputDir "bin\rg.exe") -Force
} else {
  $RgVersion = "15.1.0"
  $RgArchive = Join-Path $TempDir "ripgrep.zip"
  $RgDir = Join-Path $TempDir "ripgrep"
  Write-Host "[chatgpt2codex] downloading Windows ripgrep $RgVersion..."
  Download-File "https://github.com/BurntSushi/ripgrep/releases/download/$RgVersion/ripgrep-$RgVersion-x86_64-pc-windows-msvc.zip" $RgArchive
  Expand-Archive -LiteralPath $RgArchive -DestinationPath $RgDir -Force
  $RgBin = Get-ChildItem -LiteralPath $RgDir -Recurse -Filter "rg.exe" | Select-Object -First 1
  if (-not $RgBin) { throw "Downloaded ripgrep archive did not contain rg.exe." }
  Copy-Item -LiteralPath $RgBin.FullName -Destination (Join-Path $OutputDir "bin\rg.exe") -Force
}
} finally {
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

$CscCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$Csc = $CscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Csc) {
  Write-Warning "csc.exe was not found. start-chatgpt.cmd was packaged, but JK.exe could not be built."
} else {
  $LauncherSource = Join-Path $Root "windows\ChatGPTToCodexLauncher.cs"
  $LauncherExe = Join-Path $OutputDir "JK.exe"
  Invoke-Checked $Csc @(
    "/nologo",
    "/target:winexe",
    "/win32icon:$IconPath",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    "/out:$LauncherExe",
    $LauncherSource
  )
}

Write-Host ""
Write-Host "Windows package ready:"
Write-Host "  $OutputDir"
if (Test-Path -LiteralPath (Join-Path $OutputDir "JK.exe")) {
  Write-Host "Run:"
  Write-Host "  $OutputDir\JK.exe"
} else {
  Write-Host "Run:"
  Write-Host "  $OutputDir\start-chatgpt.cmd"
}
