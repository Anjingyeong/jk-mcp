#!/usr/bin/env bash
set -Eeuo pipefail

resolve_self() {
  local src="${BASH_SOURCE[0]}"
  while [ -L "$src" ]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" && pwd
}

ROOT="$(resolve_self)"
if [ ! -f "$ROOT/dist/cli.js" ]; then
  ROOT="$(cd -P "$ROOT/.." && pwd)"
fi
LOCAL_LAUNCHER="${JK_LOCAL_LAUNCHER:-${HOME:-}/.local/share/chatgpt2codex/local/launcher.sh}"
if [ "${JK_LOCAL_LAUNCHER_ACTIVE:-0}" != "1" ] && [ -x "$LOCAL_LAUNCHER" ]; then
  export JK_LOCAL_LAUNCHER_ACTIVE=1
  exec "$LOCAL_LAUNCHER" "$ROOT/linux/start-chatgpt2codex.sh" "$@"
fi
BIN_DIR="$ROOT/bin"
PATH="$BIN_DIR:$PATH"
export PATH

DOCTOR=0
WORKSPACE="${WORKSPACE:-$HOME/workspace}"
PORT="${PORT:-7979}"
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --doctor|-d)
      DOCTOR=1
      shift
      ;;
    --no-tunnel)
      # Backward-compatible no-op. Public JK no longer provisions tunnels.
      shift
      ;;
    --workspace)
      WORKSPACE="${2:?--workspace requires a value}"
      shift 2
      ;;
    --port)
      PORT="${2:?--port requires a value}"
      shift 2
      ;;
    --public-hostname)
      PUBLIC_HOSTNAME="${2:?--public-hostname requires a value}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

WORKSPACE="$(mkdir -p "$WORKSPACE" && cd "$WORKSPACE" && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt2codex.XXXXXX")"
SERVER_PID=""
SCHEDULER_PIDS=()

cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  local pid
  for pid in "${SCHEDULER_PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

# Optional host-local startup hook. The hook lives under the ignored
# .chatgpt2codex state directory so deployments can start colocated services
# without hard-coding project-specific logic into the JK launcher. Hook failures
# are isolated from the JK runtime and never block its own startup.
STARTUP_HOOK="$ROOT/.chatgpt2codex/startup-hook.sh"
if [ -f "$STARTUP_HOOK" ]; then
  (bash "$STARTUP_HOOK" || true) >>"$ROOT/.chatgpt2codex/startup-hook.log" 2>&1 &
fi

need_tool() {
  local name
  for name in "$@"; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return 0
    fi
  done
  echo "missing required command: $*" >&2
  exit 1
}

NODE="$(need_tool node)"
CLI="$ROOT/dist/cli.js"

node_fetch_ok() {
  local url="$1"
  "$NODE" -e '
const url = process.argv[1];
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 4000);
fetch(url, { signal: controller.signal })
  .then((res) => process.exit(res.status >= 200 && res.status < 500 ? 0 : 1))
  .catch(() => process.exit(1))
  .finally(() => clearTimeout(timeout));
' "$url"
}

wait_http_ok() {
  local url="$1"
  local tries="$2"
  local label="$3"
  local i
  for ((i = 0; i < tries; i++)); do
    if node_fetch_ok "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not become ready: $url" >&2
  return 1
}

start_logged() {
  local name="$1"
  shift
  "$@" >"$TMP_DIR/$name.out.log" 2>"$TMP_DIR/$name.err.log" &
  echo "$!"
}

start_project_schedulers() {
  local container project scheduler name pid index=0
  for container in "$WORKSPACE/projects" "$WORKSPACE"/*/projects; do
    [ -d "$container" ] || continue
    for project in "$container"/*; do
      [ -d "$project" ] || continue
      scheduler="$project/scripts/run_scheduler.sh"
      [ -x "$scheduler" ] || continue
      index=$((index + 1))
      name="project-scheduler-$index"
      pid="$(start_logged "$name" "$scheduler")"
      SCHEDULER_PIDS+=("$pid")
      echo "[chatgpt2codex] project scheduler started: $(basename "$project") pid=$pid"
    done
  done
}

read_logs() {
  local name="$1"
  cat "$TMP_DIR/$name.out.log" "$TMP_DIR/$name.err.log" 2>/dev/null || true
}

if [ ! -f "$CLI" ]; then
  echo "dist/cli.js was not found under $ROOT" >&2
  exit 1
fi

if [ "$DOCTOR" -eq 1 ]; then
  exec "$NODE" "$CLI" doctor
fi

doctor_text="$("$NODE" "$CLI" doctor 2>/dev/null || true)"
if [[ "$doctor_text" != *"owner token configured"* || "${CHATGPT2CODEX_ROTATE_OWNER_TOKEN:-}" == "1" ]]; then
  init_args=(init --workspace "$WORKSPACE")
  [ "${CHATGPT2CODEX_ROTATE_OWNER_TOKEN:-}" = "1" ] && init_args+=(--rotate-owner-token)
  echo "[chatgpt2codex] initializing local owner token..."
  "$NODE" "$CLI" "${init_args[@]}"
  echo
  echo "[chatgpt2codex] save the printed owner token securely."
fi

if [ -n "$PUBLIC_HOSTNAME" ]; then
  # Public exposure is managed outside JK. This hostname is metadata only;
  # the server itself remains bound to loopback.
  PUBLIC_URL="https://$PUBLIC_HOSTNAME"
else
  PUBLIC_URL="http://127.0.0.1:$PORT"
fi

echo "[chatgpt2codex] starting local HTTP/OAuth MCP server..."
export CHATGPT2CODEX_AUTO_CAPTURE="${CHATGPT2CODEX_AUTO_CAPTURE:-0}"
server_args=("$NODE" "$CLI" serve --http --port "$PORT" --public-url "$PUBLIC_URL" --workspace "$WORKSPACE")
if [ -n "${CHATGPT2CODEX_ACTIVE_PROJECT_ROOT:-}" ]; then
  server_args+=(--active-project-root "$CHATGPT2CODEX_ACTIVE_PROJECT_ROOT")
  server_args+=(--active-project-preset "${CHATGPT2CODEX_ACTIVE_PROJECT_PRESET:-full-write}")
fi
SERVER_PID="$(start_logged server "${server_args[@]}")"
if ! wait_http_ok "http://127.0.0.1:$PORT/healthz" 30 "local server"; then
  read_logs server >&2
  exit 1
fi
start_project_schedulers

echo
echo "============================================================"
echo " chatgpt2codex is ready"
echo "============================================================"
echo " ChatGPT connector MCP URL:"
echo
echo "   $PUBLIC_URL/mcp"
echo
echo " Notes:"
echo "   - Keep this process running."
echo "   - Ctrl+C stops the local server."
echo "   - Use CHATGPT2CODEX_ROTATE_OWNER_TOKEN=1 to rotate the owner token."
if [ -n "$PUBLIC_HOSTNAME" ]; then
  echo "   - PUBLIC_HOSTNAME is metadata only; configure your reverse proxy or tunnel separately."
else
  echo "   - Public exposure is disabled. Configure an external reverse proxy or tunnel if needed."
fi
echo "============================================================"

while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited" >&2
    read_logs server >&2
    exit 1
  fi
  sleep 1
done
