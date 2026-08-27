#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p 'require("./package.json").version')"
BUILD_DIR="$ROOT/build/windows"
PACKAGE_DIR="$BUILD_DIR/chatgpt2codex-${VERSION}-windows"
ZIP_PATH="$BUILD_DIR/chatgpt2codex-${VERSION}-windows.zip"

cd "$ROOT"
npm run build

rm -rf "$PACKAGE_DIR" "$ZIP_PATH"
mkdir -p "$PACKAGE_DIR"

cp -R "$ROOT/dist" "$PACKAGE_DIR/dist"
cp -R "$ROOT/assets" "$PACKAGE_DIR/assets"
cp -R "$ROOT/windows" "$PACKAGE_DIR/windows"
cp "$ROOT/README.md" "$PACKAGE_DIR/README.md"
cp "$ROOT/package.json" "$PACKAGE_DIR/package.json"
cp "$ROOT/package-lock.json" "$PACKAGE_DIR/package-lock.json"
cp "$ROOT/start-chatgpt.ps1" "$PACKAGE_DIR/start-chatgpt.ps1"
if [[ -f "$ROOT/JK.exe" ]]; then
  cp "$ROOT/JK.exe" "$PACKAGE_DIR/JK.exe"
else
  echo "warning: JK.exe is missing; run windows\\Build-ChatGPTToCodexExe.ps1 on Windows before public release packaging." >&2
fi
find "$PACKAGE_DIR/dist" -name '*.map' -delete

if [[ -f "$ROOT/bin/windows/cloudflared.exe" ]]; then
  mkdir -p "$PACKAGE_DIR/bin"
  cp "$ROOT/bin/windows/cloudflared.exe" "$PACKAGE_DIR/bin/cloudflared.exe"
fi

(
  cd "$PACKAGE_DIR"
  npm ci --omit=dev --ignore-scripts --prefer-offline
)

(
  cd "$BUILD_DIR"
  zip -qr "$ZIP_PATH" "$(basename "$PACKAGE_DIR")"
)

echo "$ZIP_PATH"
