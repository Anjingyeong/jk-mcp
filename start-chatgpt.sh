#!/usr/bin/env bash
# JK public launcher: local MCP/HTTP only.
# Public exposure, reverse proxies, tunnels, and persistent hosting are host-local concerns.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$ROOT/linux/start-chatgpt2codex.sh"

if [ ! -f "$LAUNCHER" ]; then
  echo "[chatgpt2codex] launcher not found: $LAUNCHER" >&2
  exit 1
fi

args=()
if [ -n "${WORKSPACE:-}" ]; then
  args+=(--workspace "$WORKSPACE")
fi
if [ -n "${PORT:-}" ]; then
  args+=(--port "$PORT")
fi
if [ -n "${PUBLIC_HOSTNAME:-}" ]; then
  args+=(--public-hostname "$PUBLIC_HOSTNAME")
fi

if [ "${CHATGPT2CODEX_EXPOSE_WEB:-0}" = "1" ] && [ -z "${PUBLIC_HOSTNAME:-}" ]; then
  echo "[chatgpt2codex] warning: CHATGPT2CODEX_EXPOSE_WEB no longer provisions a public tunnel." >&2
  echo "[chatgpt2codex] configure an external reverse proxy/tunnel and set PUBLIC_HOSTNAME instead." >&2
fi

exec /bin/bash "$LAUNCHER" "${args[@]}" "$@"
