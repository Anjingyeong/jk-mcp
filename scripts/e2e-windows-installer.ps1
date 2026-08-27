[CmdletBinding()]
param(
  [string]$Installer = "",
  [switch]$Rebuild,
  [switch]$SkipTunnel,
  [switch]$RequirePublicTunnelHealth,
  [int]$InstallerTimeoutSec = 180,
  [int]$RuntimeTimeoutSec = 120
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Web
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ChatGpt2CodexE2EMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
'@

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$BuildRoot = Join-Path $Root "build\windows"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\JK"
if (-not $Installer -or $Installer.Trim().Length -eq 0) {
  $Installer = Join-Path $BuildRoot "JK-Setup.exe"
}
$Installer = [System.IO.Path]::GetFullPath($Installer)

$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$RunRoot = Join-Path $BuildRoot "e2e\$RunId"
$Sandbox = Join-Path $RunRoot "sandbox"
$HomeDir = Join-Path $Sandbox "home"
$LocalAppData = Join-Path $HomeDir "AppData\Local"
$RoamingAppData = Join-Path $HomeDir "AppData\Roaming"
$Workspace = Join-Path $Sandbox "workspace"
$Project = Join-Path $Workspace "e2e-project"
$ReportPath = Join-Path $RunRoot "report.json"
New-Item -ItemType Directory -Path $RunRoot, $HomeDir, $LocalAppData, $RoamingAppData, $Workspace, $Project -Force | Out-Null

$script:Results = New-Object System.Collections.Generic.List[object]
$script:HttpHandler = [System.Net.Http.HttpClientHandler]::new()
$script:HttpHandler.AllowAutoRedirect = $false
$script:Http = [System.Net.Http.HttpClient]::new($script:HttpHandler)
$script:Processes = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$script:ServerJob = $null

function Add-Result([string]$Name, [string]$Status, [double]$Seconds, [string]$Detail) {
  $script:Results.Add([pscustomobject]@{
    name = $Name
    status = $Status
    seconds = [Math]::Round($Seconds, 3)
    detail = $Detail
  }) | Out-Null
}

function Invoke-Step([string]$Name, [scriptblock]$Body) {
  Write-Host "[e2e] $Name"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $detail = & $Body
    $sw.Stop()
    Add-Result $Name "passed" $sw.Elapsed.TotalSeconds ([string]$detail)
    Write-Host "[e2e] ok: $Name ($([Math]::Round($sw.Elapsed.TotalSeconds, 1))s)"
  } catch {
    $sw.Stop()
    Add-Result $Name "failed" $sw.Elapsed.TotalSeconds $_.Exception.Message
    Save-Report "failed"
    throw
  }
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Test-BinaryContainsUtf16String([byte[]]$Bytes, [string]$Value) {
  $pattern = [System.Text.Encoding]::Unicode.GetBytes($Value)
  if ($pattern.Length -eq 0) { return $true }
  for ($i = 0; $i -le $Bytes.Length - $pattern.Length; $i++) {
    $matched = $true
    for ($j = 0; $j -lt $pattern.Length; $j++) {
      if ($Bytes[$i + $j] -ne $pattern[$j]) {
        $matched = $false
        break
      }
    }
    if ($matched) { return $true }
  }
  return $false
}

function Quote-WindowsArg([string]$Arg) {
  if ($null -eq $Arg) { return '""' }
  if ($Arg -notmatch '[\s"]') { return $Arg }
  return '"' + ($Arg -replace '"', '\"') + '"'
}

function Join-ArgumentList([string[]]$ArgumentList) {
  return ($ArgumentList | ForEach-Object { Quote-WindowsArg $_ }) -join " "
}

function Get-E2EEnv() {
  $drive = [System.IO.Path]::GetPathRoot($HomeDir).TrimEnd("\")
  $homePath = $HomeDir.Substring($drive.Length)
  return @{
    USERPROFILE = $HomeDir
    HOME = $HomeDir
    HOMEDRIVE = $drive
    HOMEPATH = $homePath
    LOCALAPPDATA = $LocalAppData
    APPDATA = $RoamingAppData
    CHATGPT2CODEX_AUTO_CAPTURE = "0"
    PATH = (Join-Path $InstallDir "bin") + ";" + $env:PATH
  }
}

function New-ProcessStartInfo([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [hashtable]$Environment) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FilePath
  $psi.Arguments = Join-ArgumentList $ArgumentList
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  foreach ($entry in $Environment.GetEnumerator()) {
    $psi.EnvironmentVariables[$entry.Key] = [string]$entry.Value
  }
  return $psi
}

function Invoke-ProcessCapture(
  [string]$FilePath,
  [string[]]$ArgumentList,
  [string]$WorkingDirectory,
  [hashtable]$Environment,
  [int]$TimeoutSec = 60
) {
  $psi = New-ProcessStartInfo $FilePath $ArgumentList $WorkingDirectory $Environment
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "Timed out: $FilePath $($ArgumentList -join ' ')"
  }
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  return [pscustomobject]@{
    ExitCode = $proc.ExitCode
    StdOut = $stdout
    StdErr = $stderr
    Text = ($stdout + "`n" + $stderr)
  }
}

function Start-LoggedProcess(
  [string]$FilePath,
  [string[]]$ArgumentList,
  [string]$WorkingDirectory,
  [hashtable]$Environment,
  [string]$Name
) {
  $stdout = Join-Path $RunRoot "$Name.out.log"
  $stderr = Join-Path $RunRoot "$Name.err.log"
  $psi = New-ProcessStartInfo $FilePath $ArgumentList $WorkingDirectory $Environment
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $script:Processes.Add($proc) | Out-Null
  Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
    if ($EventArgs.Data) { Add-Content -LiteralPath $Event.MessageData -Value $EventArgs.Data }
  } -MessageData $stdout | Out-Null
  Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
    if ($EventArgs.Data) { Add-Content -LiteralPath $Event.MessageData -Value $EventArgs.Data }
  } -MessageData $stderr | Out-Null
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
  return [pscustomobject]@{ Process = $proc; StdOut = $stdout; StdErr = $stderr; Name = $Name }
}

function Read-ProcessLogs([object]$Job) {
  $parts = @()
  foreach ($path in @($Job.StdOut, $Job.StdErr)) {
    if (Test-Path -LiteralPath $path) {
      $parts += Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
    }
  }
  return ($parts -join "`n")
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -gt 0) {
    & taskkill.exe /pid $ProcessId /t /f 2>$null | Out-Null
  }
}

function Stop-AllE2EProcesses() {
  foreach ($proc in $script:Processes) {
    try {
      if ($proc -and -not $proc.HasExited) { Stop-ProcessTree $proc.Id }
    } catch { }
  }
}

function Get-DescendantProcesses([int]$ParentProcessId) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $descendants = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($ParentProcessId)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $current })) {
      $descendants.Add($child) | Out-Null
      $queue.Enqueue([int]$child.ProcessId)
    }
  }
  return $descendants.ToArray()
}

function Get-FreePort() {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
  $listener.Start()
  try {
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Invoke-Http(
  [string]$Method,
  [string]$Uri,
  [hashtable]$Headers = @{},
  $Body = $null,
  [string]$ContentType = "application/json"
) {
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
  foreach ($entry in $Headers.GetEnumerator()) {
    if ($entry.Key -ieq "content-type") { continue }
    $request.Headers.TryAddWithoutValidation($entry.Key, [string]$entry.Value) | Out-Null
  }
  if ($null -ne $Body) {
    if ($Body -is [byte[]]) {
      $request.Content = [System.Net.Http.ByteArrayContent]::new($Body)
    } else {
      $request.Content = [System.Net.Http.StringContent]::new([string]$Body, [System.Text.Encoding]::UTF8, $ContentType)
    }
    if ($ContentType) {
      $request.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($ContentType)
    }
  }
  $response = $script:Http.SendAsync($request).GetAwaiter().GetResult()
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $headersOut = @{}
  foreach ($h in $response.Headers) { $headersOut[$h.Key.ToLowerInvariant()] = ($h.Value -join ",") }
  foreach ($h in $response.Content.Headers) { $headersOut[$h.Key.ToLowerInvariant()] = ($h.Value -join ",") }
  return [pscustomobject]@{
    Status = [int]$response.StatusCode
    Text = $text
    Headers = $headersOut
  }
}

function Invoke-Json(
  [string]$Method,
  [string]$Uri,
  [object]$Body = $null,
  [hashtable]$Headers = @{}
) {
  $json = $null
  if ($null -ne $Body) { $json = $Body | ConvertTo-Json -Depth 30 -Compress }
  $res = Invoke-Http $Method $Uri $Headers $json "application/json"
  $parsed = $null
  if ($res.Text -and $res.Text.Trim().Length -gt 0) {
    $parsed = $res.Text | ConvertFrom-Json
  }
  return [pscustomobject]@{ Status = $res.Status; Body = $parsed; Text = $res.Text; Headers = $res.Headers }
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSec) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  do {
    try {
      $res = Invoke-Http "GET" $Url
      if ($res.Status -ge 200 -and $res.Status -lt 300) { return $res }
    } catch { }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "HTTP endpoint did not become healthy: $Url"
}

function Get-AutomationWindowForProcess([int]$ProcessId, [int]$TimeoutSec) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $ProcessId
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  do {
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($window) { return $window }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for GUI window for process $ProcessId"
}

function Get-AutomationElementByName([System.Windows.Automation.AutomationElement]$Root, [string]$Name, [int]$TimeoutSec) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $Name
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  do {
    $element = $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($element) { return $element }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for UI element named [$Name]"
}

function Get-AutomationElementByAnyName([System.Windows.Automation.AutomationElement]$Root, [string[]]$Names, [int]$TimeoutSec) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  do {
    foreach ($name in $Names) {
      $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $name
      )
      $element = $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
      if ($element) { return $element }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for UI element named one of [$($Names -join ', ')]"
}

function Write-E2ELauncherSettings() {
  $settingsDir = Join-Path $LocalAppData "JK"
  New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $settingsDir "settings.ini") -Encoding UTF8 -Value @(
    "Language=ZW4="
  )
}

function Click-AutomationElement([System.Windows.Automation.AutomationElement]$Element) {
  try {
    $invoke = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    return
  } catch {
    # Fall back to a physical click for controls that do not expose InvokePattern.
  }

  $bounds = $Element.Current.BoundingRectangle
  [ChatGpt2CodexE2EMouse]::SetCursorPos(
    [int]($bounds.X + ($bounds.Width / 2)),
    [int]($bounds.Y + ($bounds.Height / 2))
  ) | Out-Null
  [ChatGpt2CodexE2EMouse]::mouse_event([ChatGpt2CodexE2EMouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [ChatGpt2CodexE2EMouse]::mouse_event([ChatGpt2CodexE2EMouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Test-ExternalDns() {
  try {
    return ([System.Net.Dns]::GetHostAddresses("example.com").Length -gt 0)
  } catch {
    return $false
  }
}

function Resolve-HostWithCloudflareDoh([string]$HostName) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curl) { throw "curl.exe is required for Cloudflare DoH public tunnel verification" }
  $queryUrl = "https://cloudflare-dns.com/dns-query?name=$([System.Uri]::EscapeDataString($HostName))&type=A"
  $jsonText = & curl.exe --silent --show-error --resolve "cloudflare-dns.com:443:1.1.1.1" -H "accept: application/dns-json" --max-time 20 $queryUrl
  if ($LASTEXITCODE -ne 0) { throw "Cloudflare DoH lookup failed for $HostName" }
  $json = ($jsonText -join "`n") | ConvertFrom-Json
  $ips = @($json.Answer | Where-Object { $_.type -eq 1 -and $_.data } | ForEach-Object { [string]$_.data })
  if ($ips.Count -eq 0) { throw "Cloudflare DoH returned no A records for $HostName" }
  return $ips
}

function Test-PublicHealthWithCurlResolve([string]$Url) {
  $uri = [System.Uri]::new($Url)
  $ips = Resolve-HostWithCloudflareDoh $uri.Host
  $last = "no curl attempt"
  foreach ($ip in $ips) {
    $resolve = "$($uri.Host):443:$ip"
    $output = & curl.exe --silent --show-error --resolve $resolve --max-time 20 --write-out "`nHTTP_STATUS:%{http_code}" $Url
    $text = ($output -join "`n")
    $statusMatch = [regex]::Match($text, "HTTP_STATUS:(\d+)")
    $status = if ($statusMatch.Success) { [int]$statusMatch.Groups[1].Value } else { 0 }
    $body = $text -replace "\r?\nHTTP_STATUS:\d+\s*$", ""
    $last = "ip=$ip status=$status body=$($body.Substring(0, [Math]::Min(160, $body.Length)))"
    if ($LASTEXITCODE -eq 0 -and $status -eq 200 -and $body -match '"ok"\s*:\s*true') {
      return $last
    }
  }
  throw "public health via curl --resolve failed; last $last"
}

function Wait-PublicHealth([string]$Url, [int]$TimeoutSec) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  $last = "no response yet"
  $useNormalDns = Test-ExternalDns
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($useNormalDns) {
      try {
        $public = Invoke-Http "GET" $Url
        $last = "status=$($public.Status) body=$($public.Text.Substring(0, [Math]::Min(160, $public.Text.Length)))"
        if ($public.Status -eq 200 -and $public.Text -match '"ok"\s*:\s*true') { return $last }
      } catch {
        $last = "normal-dns error=$($_.Exception.Message)"
      }
    } else {
      try {
        return Test-PublicHealthWithCurlResolve $Url
      } catch {
        $last = $_.Exception.Message
      }
    }
    Start-Sleep -Seconds 5
  }
  throw "Quick Tunnel public /healthz did not return 200 within $TimeoutSec seconds; last $last"
}

function ConvertTo-FormBody([hashtable]$Fields) {
  $pairs = foreach ($entry in $Fields.GetEnumerator()) {
    [System.Uri]::EscapeDataString([string]$entry.Key) + "=" + [System.Uri]::EscapeDataString([string]$entry.Value)
  }
  return ($pairs -join "&")
}

function New-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function New-RandomBase64Url([int]$ByteCount) {
  $bytes = New-Object byte[] $ByteCount
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return New-Base64Url $bytes
}

function New-CodeChallenge([string]$Verifier) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return New-Base64Url ($sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($Verifier)))
  } finally {
    $sha.Dispose()
  }
}

function ConvertFrom-McpHttpBody([string]$Text) {
  $trimmed = $Text.Trim()
  if ($trimmed.StartsWith("{")) { return $trimmed | ConvertFrom-Json }
  $data = @()
  foreach ($line in ($Text -split '\r?\n')) {
    if ($line.StartsWith("data:")) { $data += $line.Substring(5).Trim() }
  }
  if ($data.Count -eq 0) { throw "MCP response did not contain JSON data: $Text" }
  return ($data -join "`n") | ConvertFrom-Json
}

function Invoke-Mcp(
  [string]$BaseUrl,
  [string]$AccessToken,
  [object]$Request,
  [string]$SessionId = $null
) {
  $headers = @{
    authorization = "Bearer $AccessToken"
    accept = "application/json, text/event-stream"
  }
  if ($SessionId) { $headers["mcp-session-id"] = $SessionId }
  $body = $Request | ConvertTo-Json -Depth 30 -Compress
  $res = Invoke-Http "POST" "$BaseUrl/mcp" $headers $body "application/json"
  $parsed = ConvertFrom-McpHttpBody $res.Text
  return [pscustomobject]@{ Status = $res.Status; Body = $parsed; Headers = $res.Headers; Text = $res.Text }
}

function Get-OAuthAccessToken([string]$BaseUrl, [string]$OwnerToken) {
  $redirect = "https://chatgpt.com/chatgpt2codex-e2e/callback"
  $resource = "$BaseUrl/mcp"
  $register = Invoke-Json "POST" "$BaseUrl/register" @{
    client_name = "chatgpt2codex-e2e"
    redirect_uris = @($redirect)
    token_endpoint_auth_method = "none"
    grant_types = @("authorization_code", "refresh_token")
    response_types = @("code")
  }
  Assert-True ($register.Status -eq 201 -or $register.Status -eq 200) "OAuth dynamic client registration failed: $($register.Text)"
  $clientId = [string]$register.Body.client_id
  Assert-True ($clientId.Length -gt 0) "OAuth registration did not return client_id"

  $verifier = New-RandomBase64Url 32
  $challenge = New-CodeChallenge $verifier
  $state = New-RandomBase64Url 16
  $authQuery = ConvertTo-FormBody @{
    response_type = "code"
    client_id = $clientId
    redirect_uri = $redirect
    code_challenge = $challenge
    code_challenge_method = "S256"
    scope = "chatgpt2codex"
    state = $state
    resource = $resource
  }
  $authGet = Invoke-Http "GET" "$BaseUrl/authorize?$authQuery"
  Assert-True ($authGet.Status -eq 200) "OAuth authorize form failed: $($authGet.Status)"
  $csrf = [regex]::Match($authGet.Text, 'name="csrf_token" value="([^"]+)"').Groups[1].Value
  Assert-True ($csrf.Length -gt 0) "OAuth authorize form did not include csrf_token"

  $authPostBody = ConvertTo-FormBody @{
    response_type = "code"
    client_id = $clientId
    redirect_uri = $redirect
    code_challenge = $challenge
    code_challenge_method = "S256"
    scope = "chatgpt2codex"
    state = $state
    resource = $resource
    csrf_token = $csrf
    owner_token = $OwnerToken
  }
  $authPost = Invoke-Http "POST" "$BaseUrl/authorize" @{} $authPostBody "application/x-www-form-urlencoded"
  Assert-True ($authPost.Status -eq 302) "OAuth owner authorization did not redirect: $($authPost.Status) $($authPost.Text)"
  $location = [string]$authPost.Headers["location"]
  Assert-True ($location.Length -gt 0) "OAuth authorize redirect did not include Location"
  $redirectUri = [System.Uri]::new($location)
  $query = [System.Web.HttpUtility]::ParseQueryString($redirectUri.Query)
  $code = [string]$query["code"]
  Assert-True ($code.Length -gt 0) "OAuth authorize redirect did not include code"
  Assert-True ([string]$query["state"] -eq $state) "OAuth state roundtrip failed"

  $tokenBody = ConvertTo-FormBody @{
    grant_type = "authorization_code"
    code = $code
    code_verifier = $verifier
    redirect_uri = $redirect
    client_id = $clientId
    resource = $resource
  }
  $token = Invoke-Http "POST" "$BaseUrl/token" @{} $tokenBody "application/x-www-form-urlencoded"
  Assert-True ($token.Status -eq 200) "OAuth token exchange failed: $($token.Status) $($token.Text)"
  $tokenJson = $token.Text | ConvertFrom-Json
  Assert-True ([string]$tokenJson.access_token -ne "") "OAuth token response did not include access_token"
  return [string]$tokenJson.access_token
}

function Save-Report([string]$Status) {
  $report = [ordered]@{
    status = $Status
    runId = $RunId
    root = $Root
    installer = $Installer
    installDir = $InstallDir
    runRoot = $RunRoot
    sandbox = $Sandbox
    results = $script:Results
    completedAt = (Get-Date).ToString("o")
  }
  $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
}

try {
  Invoke-Step "prepare isolated workspace" {
    Set-Content -LiteralPath (Join-Path $Project "package.json") -Value '{"name":"e2e-project","version":"1.0.0","scripts":{"echo":"node -e \"console.log(''e2e-command-ok'')\""}}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $Project "README.md") -Value "e2e project" -Encoding UTF8
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
      & git -C $Project init -q
      & git -C $Project config user.email "e2e@example.invalid"
      & git -C $Project config user.name "chatgpt2codex e2e"
    }
    "workspace=$Workspace"
  }

  if ($Rebuild) {
    Invoke-Step "rebuild installer" {
      & npm.cmd run windows:package
      if ($LASTEXITCODE -ne 0) { throw "npm run windows:package failed with $LASTEXITCODE" }
      "rebuilt"
    }
  }

  Invoke-Step "run one-shot installer" {
    Assert-True (Test-Path -LiteralPath $Installer) "Installer not found: $Installer"
    foreach ($existing in @(Get-Process -Name "chatgpt2codex" -ErrorAction SilentlyContinue)) {
      Stop-ProcessTree $existing.Id
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $Installer -ArgumentList "/NoLaunch" -PassThru
    if (-not $proc.WaitForExit($InstallerTimeoutSec * 1000)) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      throw "Installer did not exit within $InstallerTimeoutSec seconds"
    }
    $sw.Stop()
    Assert-True ($proc.ExitCode -eq 0) "Installer failed with exit code $($proc.ExitCode)"
    Assert-True ($sw.Elapsed.TotalSeconds -lt $InstallerTimeoutSec) "Installer exceeded timeout"
    "elapsed=$([Math]::Round($sw.Elapsed.TotalSeconds, 2))s"
  }

  Invoke-Step "verify installed payload and shortcuts" {
    $exePath = Join-Path $InstallDir "JK.exe"
    $iconPath = Join-Path $InstallDir "JK.ico"
    $startMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\JK.lnk"
    $desktopShortcut = Join-Path ([Environment]::GetFolderPath("DesktopDirectory")) "JK.lnk"
    $paths = @(
      $exePath,
      $iconPath,
      (Join-Path $InstallDir "start-chatgpt.ps1"),
      (Join-Path $InstallDir "start-chatgpt.cmd"),
      (Join-Path $InstallDir "dist\cli.js"),
      (Join-Path $InstallDir "bin\node.exe"),
      (Join-Path $InstallDir "bin\cloudflared.exe"),
      (Join-Path $InstallDir "bin\rg.exe"),
      $startMenuShortcut,
      $desktopShortcut
    )
    foreach ($path in $paths) { Assert-True (Test-Path -LiteralPath $path) "Missing installed artifact: $path" }
    $exeBytes = [System.IO.File]::ReadAllBytes($exePath)
    $expectedTrayLabels = @(
      "JK: ",
      "checking...",
      "Start MCP",
      "Restart MCP",
      "Settings...",
      "JK Settings",
      "Language",
      "Project folder",
      "Browse...",
      "Launch JK when Windows starts",
      "Start MCP automatically when the app opens",
      "Check for updates automatically",
      "Expose to ChatGPT web with a temporary public tunnel",
      "Stable domain (advanced)",
      "Local port",
      "GitHub repository URL",
      "Open Local Health",
      "Open Public Health",
      "Copy Connector URL",
      "Copy Owner Token",
      "Auto-generate Token",
      "Show Logs",
      "Open GitHub Repository",
      "Check for Updates...",
      "About ezBuilder",
      "Save",
      "Cancel",
      "Quit"
    )
    foreach ($label in $expectedTrayLabels) {
      Assert-True (Test-BinaryContainsUtf16String $exeBytes $label) "Installed Windows launcher is missing tray/menu label: $label"
    }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcutPath in @($startMenuShortcut, $desktopShortcut)) {
      $shortcut = $shell.CreateShortcut($shortcutPath)
      Assert-True ([string]::Equals($shortcut.TargetPath, $exePath, [StringComparison]::OrdinalIgnoreCase)) "Shortcut target mismatch: $shortcutPath -> $($shortcut.TargetPath)"
      Assert-True ($shortcut.IconLocation -like "$iconPath,*") "Shortcut icon mismatch: $shortcutPath -> $($shortcut.IconLocation)"
    }
    "verified=$($paths.Count)"
  }

  $envMap = Get-E2EEnv
  $node = Join-Path $InstallDir "bin\node.exe"
  $cli = Join-Path $InstallDir "dist\cli.js"

  Invoke-Step "initialize isolated owner token" {
    $init = Invoke-ProcessCapture $node @($cli, "init", "--workspace", $Workspace, "--rotate-owner-token") $InstallDir $envMap 60
    Assert-True ($init.ExitCode -eq 0) "init failed: $($init.Text)"
    $matches = [regex]::Matches($init.Text, "(?m)^\s{2}([A-Za-z0-9_-]{40,})\s*$")
    Assert-True ($matches.Count -ge 1) "Could not parse owner token from init output"
    $script:OwnerToken = $matches[0].Groups[1].Value
    "owner token parsed"
  }

  Invoke-Step "doctor verifies packaged runtime" {
    $doctor = Invoke-ProcessCapture $node @($cli, "doctor") $Workspace $envMap 60
    Assert-True ($doctor.ExitCode -eq 0) "doctor failed: $($doctor.Text)"
    Assert-True ($doctor.Text -match "owner token configured") "doctor did not see owner token"
    Assert-True ($doctor.Text -match "ripgrep: ripgrep") "doctor did not use bundled/system ripgrep"
    $toolMatch = [regex]::Match($doctor.Text, "registered tools: (\d+)")
    Assert-True ($toolMatch.Success -and [int]$toolMatch.Groups[1].Value -ge 30) "doctor reported too few tools"
    "tools=$($toolMatch.Groups[1].Value)"
  }

  $port = Get-FreePort
  $baseUrl = "http://127.0.0.1:$port"
  Invoke-Step "start installed HTTP runtime" {
    $script:ServerJob = Start-LoggedProcess $node @(
      $cli, "serve", "--http", "--port", "$port", "--public-url", $baseUrl, "--workspace", $Workspace,
      "--active-project-root", $Project, "--active-project-preset", "full-write"
    ) $InstallDir $envMap "runtime-http"
    Wait-HttpOk "$baseUrl/healthz" $RuntimeTimeoutSec | Out-Null
    "port=$port pid=$($script:ServerJob.Process.Id)"
  }

  Invoke-Step "verify health privacy and action schema" {
    $health = Invoke-Json "GET" "$baseUrl/healthz"
    Assert-True ($health.Status -eq 200 -and $health.Body.ok -eq $true) "healthz failed"
    $privacy = Invoke-Http "GET" "$baseUrl/privacy"
    Assert-True ($privacy.Status -eq 200 -and $privacy.Text.Contains("chatgpt2codex privacy notice")) "privacy failed"
    $actions = Invoke-Json "GET" "$baseUrl/actions/health"
    Assert-True ($actions.Status -eq 200 -and [int]$actions.Body.actions -ge 20) "actions health failed"
    $openapi = Invoke-Json "GET" "$baseUrl/actions/openapi.json"
    Assert-True ($openapi.Status -eq 200 -and $openapi.Body.openapi -eq "3.1.0") "openapi failed"
    Assert-True ($null -ne $openapi.Body.paths."/actions/file-create") "openapi missing file-create"
    "actions=$($actions.Body.actions)"
  }

  Invoke-Step "verify owner action bridge can edit files and run shell" {
    $unauth = Invoke-Json "POST" "$baseUrl/actions/agent-guide" @{}
    Assert-True ($unauth.Status -eq 401) "unauthenticated action did not return 401"
    $auth = @{ authorization = "Bearer $script:OwnerToken" }
    $projectsRes = Invoke-Json "POST" "$baseUrl/actions/workspace-list-projects" @{ limit = 20 } $auth
    Assert-True ($projectsRes.Status -eq 200 -and $projectsRes.Body.ok -eq $true) "workspace-list-projects failed: $($projectsRes.Text)"
    $projects = @($projectsRes.Body.structuredContent.projects)
    $projectObj = $projects | Where-Object { $_.name -eq "e2e-project" } | Select-Object -First 1
    Assert-True ($null -ne $projectObj) "e2e project was not listed"
    $script:ProjectId = [string]$projectObj.projectId

    $select = Invoke-Json "POST" "$baseUrl/actions/project-select" @{
      projectId = $script:ProjectId
      reason = "windows installer e2e"
      preset = "full-write"
      confirmSwitch = $true
    } $auth
    Assert-True ($select.Status -eq 200 -and $select.Body.ok -eq $true) "project-select failed: $($select.Text)"

    $create = Invoke-Json "POST" "$baseUrl/actions/file-create" @{
      projectId = $script:ProjectId
      path = "e2e-created.txt"
      content = "created by installer e2e`n"
    } $auth
    Assert-True ($create.Status -eq 200 -and $create.Body.ok -eq $true) "file-create failed: $($create.Text)"
    Assert-True ((Get-Content -LiteralPath (Join-Path $Project "e2e-created.txt") -Raw) -eq "created by installer e2e`n") "file-create did not write expected content"

    $shell = Invoke-Json "POST" "$baseUrl/actions/local-shell-run" @{
      projectId = $script:ProjectId
      command = "echo e2e-shell-ok"
      timeoutSec = 10
      intent = @{ reason = "installer e2e"; writesWorkspace = $false; needsNetwork = $false; destructive = $false }
    } $auth
    Assert-True ($shell.Status -eq 200 -and $shell.Body.ok -eq $true) "local-shell-run failed: $($shell.Text)"
    Assert-True ([string]$shell.Body.structuredContent.stdoutSummary -match "e2e-shell-ok") "local-shell output mismatch"
    "project=$script:ProjectId"
  }

  Invoke-Step "verify OAuth protected MCP endpoint" {
    $noAuth = Invoke-Http "POST" "$baseUrl/mcp" @{ accept = "application/json, text/event-stream" } '{"jsonrpc":"2.0","id":0,"method":"tools/list","params":{}}' "application/json"
    Assert-True ($noAuth.Status -eq 401) "MCP endpoint did not require OAuth"
    $accessToken = Get-OAuthAccessToken $baseUrl $script:OwnerToken
    $initReq = @{
      jsonrpc = "2.0"
      id = 1
      method = "initialize"
      params = @{
        protocolVersion = "2024-11-05"
        capabilities = @{}
        clientInfo = @{ name = "chatgpt2codex-e2e"; version = "1.0.0" }
      }
    }
    $initRes = Invoke-Mcp $baseUrl $accessToken $initReq
    Assert-True ($initRes.Status -eq 200) "MCP initialize failed: $($initRes.Text)"
    $sessionId = [string]$initRes.Headers["mcp-session-id"]
    Assert-True ($sessionId.Length -gt 0) "MCP initialize did not return mcp-session-id"
    $toolsRes = Invoke-Mcp $baseUrl $accessToken @{
      jsonrpc = "2.0"
      id = 2
      method = "tools/list"
      params = @{}
    } $sessionId
    Assert-True ($toolsRes.Status -eq 200) "MCP tools/list failed: $($toolsRes.Text)"
    $tools = @($toolsRes.Body.result.tools)
    $fileCreateTools = @($tools | Where-Object { $_.name -eq "file_create" })
    Assert-True ($fileCreateTools.Count -eq 1) "MCP tools/list missing file_create"
    "mcpTools=$($tools.Count)"
  }

  if ($script:ServerJob -and -not $script:ServerJob.Process.HasExited) {
    Stop-ProcessTree $script:ServerJob.Process.Id
  }

  Invoke-Step "verify installed GUI launcher starts runtime" {
    $guiPort = Get-FreePort
    $expectedMcpUrl = "http://127.0.0.1:$guiPort/mcp"
    $guiExe = Join-Path $InstallDir "JK.exe"
    Write-E2ELauncherSettings
    $gui = Start-LoggedProcess $guiExe @("-NoTunnel", "-Port", "$guiPort", "-Workspace", $Workspace) $InstallDir $envMap "gui-launcher"
    Wait-HttpOk "http://127.0.0.1:$guiPort/healthz" $RuntimeTimeoutSec | Out-Null
    Start-Sleep -Seconds 1
    Assert-True (-not $gui.Process.HasExited) "GUI launcher exited after health check"
    $children = @(Get-DescendantProcesses $gui.Process.Id)
    $childText = (($children | ForEach-Object { "$($_.Name) $($_.CommandLine)" }) -join "`n")
    Assert-True ($childText -match "powershell.exe" -and $childText -match "start-chatgpt.ps1") "GUI launcher did not spawn start-chatgpt.ps1"
    $guiLog = Get-ChildItem -LiteralPath (Join-Path $LocalAppData "JK\logs") -Filter "launcher-*.log" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    Assert-True ($null -ne $guiLog) "GUI launcher did not create a launcher log"
    $guiLogText = Get-Content -LiteralPath $guiLog.FullName -Raw
    Assert-True ($guiLogText -match [regex]::Escape($expectedMcpUrl) -and $guiLogText -match "starting local HTTP/OAuth MCP server") "GUI launcher log did not show installed runtime startup"
    $window = Get-AutomationWindowForProcess $gui.Process.Id 20
    Get-AutomationElementByName $window $expectedMcpUrl 40 | Out-Null
    $copyButton = Get-AutomationElementByAnyName $window @("Copy Connector URL") 20
    Assert-True $copyButton.Current.IsEnabled "Copy Connector URL button did not enable"
    Click-AutomationElement $copyButton
    Start-Sleep -Seconds 1
    Assert-True (-not $gui.Process.HasExited) "GUI launcher exited after Copy Connector URL click"
    $clipboardText = Get-Clipboard -Raw
    Assert-True ($clipboardText -match [regex]::Escape($expectedMcpUrl)) "Copy Connector URL did not write expected URL. Clipboard=[$clipboardText]"
    $autoGenerateTokenButton = Get-AutomationElementByAnyName $window @("Auto-generate Token") 20
    Assert-True $autoGenerateTokenButton.Current.IsEnabled "Auto-generate Token button did not enable"
    Click-AutomationElement $autoGenerateTokenButton
    Wait-HttpOk "http://127.0.0.1:$guiPort/healthz" $RuntimeTimeoutSec | Out-Null
    Start-Sleep -Seconds 2
    Assert-True (-not $gui.Process.HasExited) "GUI launcher exited after Auto-generate Token click"
    $copyOwnerTokenButton = Get-AutomationElementByAnyName $window @("Copy Owner Token") 40
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    while (-not $copyOwnerTokenButton.Current.IsEnabled -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 500
      $copyOwnerTokenButton = Get-AutomationElementByAnyName $window @("Copy Owner Token") 5
    }
    Assert-True $copyOwnerTokenButton.Current.IsEnabled "Copy Owner Token button did not enable after auto-generation"
    $autoCopiedOwnerClipboard = Get-Clipboard -Raw
    Assert-True ($autoCopiedOwnerClipboard -match "^[A-Za-z0-9_-]{40,}$") "Auto-generated owner token was not copied. Clipboard=[$autoCopiedOwnerClipboard]"
    Click-AutomationElement $copyOwnerTokenButton
    Start-Sleep -Seconds 1
    Assert-True (-not $gui.Process.HasExited) "GUI launcher exited after Copy Owner Token click"
    $ownerClipboard = Get-Clipboard -Raw
    Assert-True ($ownerClipboard -match "^[A-Za-z0-9_-]{40,}$") "Copy Owner Token did not write a token. Clipboard=[$ownerClipboard]"
    $latestLog = Get-ChildItem -LiteralPath (Join-Path $LocalAppData "JK\logs") -Filter "launcher-*.log" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($latestLog) {
      $latestText = Get-Content -LiteralPath $latestLog.FullName -Raw
      Assert-True (-not $latestText.Contains($ownerClipboard)) "Launcher log leaked owner token: $($latestLog.FullName)"
    }
    $windowPattern = $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    $windowPattern.Close()
    Start-Sleep -Seconds 2
    Assert-True (-not $gui.Process.HasExited) "GUI launcher exited when the window was closed instead of hiding to tray"
    Wait-HttpOk "http://127.0.0.1:$guiPort/healthz" $RuntimeTimeoutSec | Out-Null
    Stop-ProcessTree $gui.Process.Id
    "port=$guiPort copy=ok ownerTokenCopy=ok trayHide=ok"
  }

  if (-not $SkipTunnel) {
    Invoke-Step "verify Cloudflare quick tunnel startup path" {
      $tunnelPort = Get-FreePort
      $scriptPath = Join-Path $InstallDir "start-chatgpt.ps1"
      $job = Start-LoggedProcess "powershell.exe" @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath,
        "-Port", "$tunnelPort", "-Workspace", $Workspace
      ) $InstallDir $envMap "quick-tunnel"
      $deadline = [DateTime]::UtcNow.AddSeconds($RuntimeTimeoutSec)
      $url = $null
      do {
        if ($job.Process.HasExited) { throw "quick tunnel process exited early:`n$(Read-ProcessLogs $job)" }
        $logs = Read-ProcessLogs $job
        $match = [regex]::Match($logs, "https://[a-zA-Z0-9.-]+\.trycloudflare\.com")
        if ($match.Success) { $url = $match.Value }
        if ($url -and $logs -match "chatgpt2codex is ready") { break }
        Start-Sleep -Seconds 1
      } while ([DateTime]::UtcNow -lt $deadline)
      Assert-True ([string]$url -ne "") "Quick Tunnel URL did not appear"
      Assert-True ((Read-ProcessLogs $job) -match "chatgpt2codex is ready") "Quick Tunnel path did not reach ready"
      $publicDetail = Wait-PublicHealth "$url/healthz" $RuntimeTimeoutSec
      Stop-ProcessTree $job.Process.Id
      "url=$url publicHealth=$publicDetail"
    }
  }

  Invoke-Step "verify no macOS automation traces remain" {
    Push-Location $Root
    try {
      $scanPaths = @("README.md", "package.json", "src", "scripts", "windows", "start-chatgpt.ps1", "start-chatgpt.cmd", "linux") |
        Where-Object { Test-Path -LiteralPath $_ }
      $terms = @(
        ("osa" + "script"),
        ("apple " + "events"),
        ("j" + "xa"),
        ("system " + "events"),
        ("clipboard " + "as")
      )
      foreach ($term in $terms) {
        $matches = & rg -n -i --fixed-strings $term @scanPaths
        if ($LASTEXITCODE -eq 0) { throw "Forbidden macOS automation trace found for [$term]:`n$matches" }
        if ($LASTEXITCODE -ne 1) { throw "rg failed with exit code $LASTEXITCODE for [$term]" }
      }
    } finally {
      Pop-Location
    }
    "clean"
  }

  Save-Report "passed"
  Write-Host "[e2e] PASSED"
  Write-Host "[e2e] report: $ReportPath"
} finally {
  Stop-AllE2EProcesses
  $script:Http.Dispose()
  $script:HttpHandler.Dispose()
}
