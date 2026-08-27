@echo off
setlocal
set "ROOT=%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\windows\Install-Prerequisites.ps1"
if errorlevel 1 (
  echo.
  echo JK prerequisite setup failed.
  pause
  exit /b 1
)
powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%ROOT%\windows\ChatGPTToCodexTray.ps1"
