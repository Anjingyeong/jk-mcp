#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/dist/cli.js" ]; then
  SOURCE_DIR="$SCRIPT_DIR"
else
  SOURCE_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
fi
PREFIX=""
LAUNCH=0
INSTALL_SYSTEMD=0
USER_SYSTEMD=0
WORKSPACE="${WORKSPACE:-$HOME/workspace}"
PORT="${PORT:-7979}"

if [ "$(id -u)" -eq 0 ]; then
  CANONICAL_PREFIX="/opt/jk"
  LEGACY_PREFIX="/opt/chatgpt2codex"
else
  CANONICAL_PREFIX="$HOME/.local/share/jk-app"
  LEGACY_PREFIX="$HOME/.local/share/chatgpt2codex-app"
fi
LEGACY_SYSTEMD_UNIT="/etc/systemd/system/chatgpt2codex.service"
LEGACY_USER_SYSTEMD_UNIT="$HOME/.config/systemd/user/chatgpt2codex.service"
LEGACY_INSTALL=0

usage() {
  cat <<'EOF'
Usage: install-linux.sh [options]

Options:
  --prefix PATH       Default: /opt/jk as root, otherwise ~/.local/share/jk-app
                      Existing legacy installations retain their current prefix.
  --launch           Start JK after installing
  --no-launch        Install only
  --systemd          Install and start a system service (root)
  --user-systemd     Install and start a user systemd service
  --workspace PATH   Workspace used by --launch/systemd. Default: ~/workspace
  --port PORT        Port used by --launch/systemd. Default: 7979
  -h, --help         Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      PREFIX="${2:?--prefix requires a value}"
      shift 2
      ;;
    --launch)
      LAUNCH=1
      shift
      ;;
    --no-launch)
      LAUNCH=0
      shift
      ;;
    --systemd)
      INSTALL_SYSTEMD=1
      shift
      ;;
    --user-systemd)
      USER_SYSTEMD=1
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -e "$LEGACY_PREFIX" ] || [ -f "$LEGACY_SYSTEMD_UNIT" ] || [ -f "$LEGACY_USER_SYSTEMD_UNIT" ]; then
  LEGACY_INSTALL=1
fi

if [ -z "$PREFIX" ]; then
  if [ "$LEGACY_INSTALL" -eq 1 ]; then
    PREFIX="$LEGACY_PREFIX"
  else
    PREFIX="$CANONICAL_PREFIX"
  fi
fi

PREFIX="$(mkdir -p "$(dirname "$PREFIX")" && cd "$(dirname "$PREFIX")" && pwd)/$(basename "$PREFIX")"
WORKSPACE="$(mkdir -p "$WORKSPACE" && cd "$WORKSPACE" && pwd)"

case "$PREFIX" in
  ""|"/"|"/usr"|"/usr/local"|"/opt"|"$HOME"|"$HOME/")
    echo "refusing unsafe install prefix: $PREFIX" >&2
    exit 1
    ;;
esac

stop_existing() {
  if command -v pgrep >/dev/null 2>&1; then
    local pids
    pids="$(pgrep -f "$PREFIX" || true)"
    if [ -n "$pids" ]; then
      echo "$pids" | while read -r pid; do
        [ -z "$pid" ] && continue
        [ "$pid" = "$$" ] && continue
        kill "$pid" 2>/dev/null || true
      done
      sleep 1
      echo "$pids" | while read -r pid; do
        [ -z "$pid" ] && continue
        [ "$pid" = "$$" ] && continue
        kill -9 "$pid" 2>/dev/null || true
      done
    fi
  fi
}

link_bin() {
  local target_dir
  if [ "$(id -u)" -eq 0 ] && [ -d /usr/local/bin ]; then
    target_dir="/usr/local/bin"
  else
    target_dir="$HOME/.local/bin"
    mkdir -p "$target_dir"
  fi
  ln -sfn "$PREFIX/jk" "$target_dir/jk"
  ln -sfn "$PREFIX/start-jk.sh" "$target_dir/jk-start"
  if [ "$LEGACY_INSTALL" -eq 1 ]; then
    # Preserve legacy command links only when upgrading that installation.
    ln -sfn "$PREFIX/jk" "$target_dir/chatgpt2codex"
    ln -sfn "$PREFIX/start-jk.sh" "$target_dir/chatgpt2codex-start"
  fi
  echo "$target_dir"
}

install_systemd_service() {
  local unit_path="$1"
  local user_mode="$2"
  local wanted_by="multi-user.target"
  [ "$user_mode" = "1" ] && wanted_by="default.target"
  mkdir -p "$(dirname "$unit_path")"
  cat >"$unit_path" <<EOF
[Unit]
Description=JK local MCP bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORKSPACE
Environment=WORKSPACE=$WORKSPACE
Environment=PORT=$PORT
ExecStart=$PREFIX/start-jk.sh --workspace $WORKSPACE --port $PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=$wanted_by
EOF

  if [ "$user_mode" = "1" ]; then
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE_NAME.service"
  else
    systemctl daemon-reload
    systemctl enable --now "$SERVICE_NAME.service"
  fi
}

echo "[jk] installing to $PREFIX"
stop_existing

tmp="$(mktemp -d "${TMPDIR:-/tmp}/jk-install.XXXXXX")"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp/app"
cp -a "$SOURCE_DIR/." "$tmp/app/"
rm -rf "$tmp/app/.git" "$tmp/app/build"
rm -rf "$PREFIX"
mkdir -p "$(dirname "$PREFIX")"
mv "$tmp/app" "$PREFIX"

chmod +x "$PREFIX/jk" "$PREFIX/start-jk.sh" "$PREFIX/install-linux.sh" 2>/dev/null || true
find "$PREFIX/bin" -maxdepth 1 -type f -exec chmod +x {} \; 2>/dev/null || true

bin_dir="$(link_bin)"
SERVICE_NAME="jk"
[ "$LEGACY_INSTALL" -eq 1 ] && SERVICE_NAME="chatgpt2codex"

if [ "$INSTALL_SYSTEMD" -eq 1 ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "--systemd requires root. Use --user-systemd for a user service." >&2
    exit 1
  fi
  install_systemd_service "/etc/systemd/system/$SERVICE_NAME.service" 0
fi

if [ "$USER_SYSTEMD" -eq 1 ]; then
  install_systemd_service "$HOME/.config/systemd/user/$SERVICE_NAME.service" 1
fi

cat <<EOF

JK installed.
  app: $PREFIX
  commands: $bin_dir/jk, $bin_dir/jk-start
  service: $SERVICE_NAME.service

EOF

if [ "$LEGACY_INSTALL" -eq 1 ]; then
  cat <<EOF
  legacy aliases: $bin_dir/chatgpt2codex, $bin_dir/chatgpt2codex-start

EOF
fi

cat <<EOF

Start now:
  jk-start --workspace "$WORKSPACE" --port "$PORT"

EOF

if [ "$LAUNCH" -eq 1 ]; then
  exec "$PREFIX/start-jk.sh" --workspace "$WORKSPACE" --port "$PORT"
fi
