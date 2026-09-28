import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { DomainError, ErrorCode } from "../types.js";
import { SENSITIVE_APP_DENYLIST } from "./policy.js";

export type WindowsComputerActionKind = "click" | "type" | "key" | "scroll";

export interface WindowsComputerActionInput {
  appName: string;
  kind: WindowsComputerActionKind;
  windowPoint?: { xRel: number; yRel: number };
  text?: string;
  keyCode?: number;
  scrollDelta?: number;
}

export interface WindowsComputerActionResult {
  ok: true;
  frontmostProcess: string;
  point?: { x: number; y: number };
}

export interface WindowsComputerScreenshotResult {
  path: string;
  bytes: number;
  imageBase64: string;
  mimeType: "image/png";
  frontmostProcess: string;
}

const WINDOWS_CONTROL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class JkWindowsControl {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags;
    public uint time; public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags;
    public uint time; public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION U; }

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  public static IntPtr ForegroundWindow() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero) throw new InvalidOperationException("No foreground window");
    return hwnd;
  }

  public static string WindowTitle(IntPtr hwnd) {
    int len = GetWindowTextLength(hwnd);
    StringBuilder sb = new StringBuilder(Math.Max(1, len + 1));
    GetWindowText(hwnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static string ProcessName(IntPtr hwnd) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    if (pid == 0) throw new InvalidOperationException("Foreground process is unavailable");
    return Process.GetProcessById((int)pid).ProcessName;
  }

  public static RECT WindowRect(IntPtr hwnd) {
    RECT rect;
    if (!GetWindowRect(hwnd, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top)
      throw new InvalidOperationException("Foreground window bounds are unavailable");
    return rect;
  }

  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new InvalidOperationException("SendInput failed");
  }

  public static void Move(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
  }

  public static void Click(int x, int y) {
    Move(x, y);
    INPUT down = new INPUT();
    down.type = INPUT_MOUSE;
    down.U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    INPUT up = new INPUT();
    up.type = INPUT_MOUSE;
    up.U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    Send(new INPUT[] { down, up });
  }

  public static void PressKey(ushort virtualKey) {
    INPUT down = new INPUT();
    down.type = INPUT_KEYBOARD;
    down.U.ki.wVk = virtualKey;
    INPUT up = new INPUT();
    up.type = INPUT_KEYBOARD;
    up.U.ki.wVk = virtualKey;
    up.U.ki.dwFlags = KEYEVENTF_KEYUP;
    Send(new INPUT[] { down, up });
  }

  public static void TypeText(string text) {
    foreach (char ch in text ?? String.Empty) {
      INPUT down = new INPUT();
      down.type = INPUT_KEYBOARD;
      down.U.ki.wScan = ch;
      down.U.ki.dwFlags = KEYEVENTF_UNICODE;
      INPUT up = new INPUT();
      up.type = INPUT_KEYBOARD;
      up.U.ki.wScan = ch;
      up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      Send(new INPUT[] { down, up });
    }
  }

  public static void Scroll(int notches) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.U.mi.mouseData = unchecked((uint)(notches * 120));
    input.U.mi.dwFlags = MOUSEEVENTF_WHEEL;
    Send(new INPUT[] { input });
  }
}
'@

function Normalize-App([string] $value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  return [regex]::Replace($value.ToLowerInvariant(), '[^\p{L}\p{N}]', '')
}

$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:JK_COMPUTER_PAYLOAD_B64))
$payload = $payloadJson | ConvertFrom-Json
$hwnd = [JkWindowsControl]::ForegroundWindow()
$processName = [JkWindowsControl]::ProcessName($hwnd)
$windowTitle = [JkWindowsControl]::WindowTitle($hwnd)
$requested = Normalize-App ([string]$payload.appName)
$processNorm = Normalize-App $processName
$titleNorm = Normalize-App $windowTitle

if ([string]::IsNullOrWhiteSpace($requested) -or
    !(($processNorm -eq $requested) -or $processNorm.Contains($requested) -or $requested.Contains($processNorm) -or $titleNorm.Contains($requested))) {
  throw 'Frontmost app does not match the requested control target'
}

foreach ($blocked in @($payload.sensitiveDenylist)) {
  $blockedNorm = Normalize-App ([string]$blocked)
  if ($blockedNorm -and ($processNorm.Contains($blockedNorm) -or $titleNorm.Contains($blockedNorm))) {
    throw 'Frontmost app is blocked by the sensitive-app denylist'
  }
}

$rect = [JkWindowsControl]::WindowRect($hwnd)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$point = $null
if ($null -ne $payload.windowPoint) {
  $xRel = [Math]::Min(1.0, [Math]::Max(0.0, [double]$payload.windowPoint.xRel))
  $yRel = [Math]::Min(1.0, [Math]::Max(0.0, [double]$payload.windowPoint.yRel))
  $x = $rect.Left + [Math]::Floor($xRel * [Math]::Max(0, $width - 1))
  $y = $rect.Top + [Math]::Floor($yRel * [Math]::Max(0, $height - 1))
  $point = @{ x = [int]$x; y = [int]$y }
}

switch ([string]$payload.kind) {
  'screenshot' {
    $outputPath = $env:JK_COMPUTER_OUTPUT_PATH
    if ([string]::IsNullOrWhiteSpace($outputPath)) { throw 'Screenshot output path is missing' }
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
      $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
  'click' {
    if ($null -eq $point) { throw 'click requires windowPoint on Windows V1' }
    [JkWindowsControl]::Click($point.x, $point.y)
  }
  'type' {
    if ($null -eq $point) { throw 'type requires windowPoint on Windows V1' }
    [JkWindowsControl]::Click($point.x, $point.y)
    [JkWindowsControl]::TypeText([string]$payload.text)
  }
  'key' {
    $keyCode = [int]$payload.keyCode
    if ($keyCode -lt 1 -or $keyCode -gt 255) { throw 'keyCode is out of Windows virtual-key range' }
    [JkWindowsControl]::PressKey([ushort]$keyCode)
  }
  'scroll' {
    if ($null -eq $point) { throw 'scroll requires windowPoint on Windows V1' }
    $delta = [int]$payload.scrollDelta
    if ($delta -eq 0 -or [Math]::Abs($delta) -gt 20) { throw 'scrollDelta is out of range' }
    [JkWindowsControl]::Move($point.x, $point.y)
    [JkWindowsControl]::Scroll($delta)
  }
  default { throw 'Unsupported Windows control action' }
}

@{ ok = $true; frontmostProcess = $processName; point = $point } | ConvertTo-Json -Compress
`;

const WINDOWS_CONTROL_SCRIPT_B64 = Buffer.from(WINDOWS_CONTROL_SCRIPT, "utf16le").toString("base64");

function assertWin32(): void {
  if (process.platform !== "win32") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Windows computer input is only supported on Windows executors");
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "control";
}

export function windowsAppIdentityMatches(requested: string, processName: string, windowTitle = ""): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const req = normalize(requested);
  const proc = normalize(processName);
  const title = normalize(windowTitle);
  return req.length > 0 && proc.length > 0
    && (proc === req || proc.includes(req) || req.includes(proc) || title.includes(req));
}

export function encodeWindowsControlPayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function runWindowsControl(
  payload: Record<string, unknown>,
  outputPath?: string,
  signal?: AbortSignal,
): Promise<{ ok: true; frontmostProcess: string; point?: { x: number; y: number } }> {
  assertWin32();
  const payloadB64 = encodeWindowsControlPayload({ ...payload, sensitiveDenylist: SENSITIVE_APP_DENYLIST });
  return await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", WINDOWS_CONTROL_SCRIPT_B64],
      {
        windowsHide: true,
        signal,
        env: {
          ...buildSafeChildEnv(),
          JK_COMPUTER_PAYLOAD_B64: payloadB64,
          ...(outputPath ? { JK_COMPUTER_OUTPUT_PATH: outputPath } : {}),
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || "Windows computer control failed").trim()));
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim()) as { ok?: boolean; frontmostProcess?: string; point?: { x: number; y: number } };
          if (parsed.ok !== true || typeof parsed.frontmostProcess !== "string") throw new Error("Invalid Windows computer control response");
          resolve({ ok: true, frontmostProcess: parsed.frontmostProcess, point: parsed.point });
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

export async function performWindowsComputerAction(
  input: WindowsComputerActionInput,
  signal?: AbortSignal,
): Promise<WindowsComputerActionResult> {
  if (input.kind === "click" || input.kind === "type" || input.kind === "scroll") {
    if (!input.windowPoint) throw new Error(`${input.kind} requires windowPoint on Windows V1`);
  }
  if (input.kind === "type" && input.text === undefined) throw new Error("type requires text");
  if (input.kind === "key" && (!Number.isInteger(input.keyCode) || (input.keyCode ?? 0) < 1 || (input.keyCode ?? 0) > 255)) {
    throw new Error("keyCode is out of Windows virtual-key range");
  }
  const scrollDelta = input.scrollDelta ?? 0;
  if (input.kind === "scroll" && (!Number.isInteger(input.scrollDelta) || scrollDelta === 0 || Math.abs(scrollDelta) > 20)) {
    throw new Error("scrollDelta is out of range");
  }
  return await runWindowsControl(input as unknown as Record<string, unknown>, undefined, signal);
}

export async function captureWindowsForegroundAppScreenshot(
  projectRoot: string,
  input: { appName: string; label?: string; waitMs?: number },
  signal?: AbortSignal,
): Promise<WindowsComputerScreenshotResult> {
  assertWin32();
  const waitMs = input.waitMs ?? 0;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, waitMs)));
  const root = await fs.realpath(projectRoot);
  const dir = path.join(root, ".jk", "e2e", "screenshots");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${slug(input.label ?? "computer")}.png`);
  const result = await runWindowsControl({ kind: "screenshot", appName: input.appName }, file, signal);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error("Windows computer screenshot did not produce a PNG");
  const image = await fs.readFile(file);
  if (image.length > 6 * 1024 * 1024) throw new Error(`Windows computer screenshot is too large to return (${image.length} bytes)`);
  return {
    path: file,
    bytes: image.length,
    imageBase64: image.toString("base64"),
    mimeType: "image/png",
    frontmostProcess: result.frontmostProcess,
  };
}