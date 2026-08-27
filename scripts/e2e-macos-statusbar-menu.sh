#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PATH="${1:-$ROOT/build/macos/ChatGPT To Codex.app}"
APP_NAME="ChatGPT To Codex"

if [[ ! -d "$APP_PATH" ]]; then
  echo "error: app bundle not found: $APP_PATH" >&2
  echo "run: npm run macos:package" >&2
  exit 2
fi

# Keep the proof target native: close the status-bar app only, never Chrome.
osascript -e 'tell application "ChatGPT To Codex" to quit' >/dev/null 2>&1 || true
pkill -x "ChatGPTToCodexStatusBar" >/dev/null 2>&1 || true
sleep 1

open -n "$APP_PATH"

# Wait for the status-bar process, then open its menu through Accessibility.
for _ in {1..30}; do
  if pgrep -x "ChatGPTToCodexStatusBar" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

osascript <<'APPLESCRIPT'
tell application "System Events"
  repeat 20 times
    if exists process "ChatGPT To Codex" then exit repeat
    delay 0.2
  end repeat

  if not (exists process "ChatGPT To Codex") then
    error "ChatGPT To Codex process did not appear"
  end if

  tell process "ChatGPT To Codex"
    set openedMenu to false
    repeat with mb in menu bars
      if (count of menu bar items of mb) > 0 then
        try
          click menu bar item 1 of mb
          set openedMenu to true
          exit repeat
        end try
      end if
    end repeat
    if openedMenu is false then error "Could not open ChatGPT To Codex status-bar menu"
  end tell
end tell
APPLESCRIPT

echo "opened native macOS status-bar menu for $APP_NAME"
