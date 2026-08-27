#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE="${JK_SYSTEMD_SERVICE:-jk-cloud.service}"
TUNNEL_SERVICE="${JK_TUNNEL_SYSTEMD_SERVICE:-jk-cloudflared.service}"
MODE="${1:-reload}"
DELAY_SEC="${JK_RELOAD_DELAY_SEC:-2}"
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

log() { printf '[jk-reload] %s\n' "$*"; }
fail() { printf '[jk-reload] ERROR: %s\n' "$*" >&2; exit 1; }

command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable"
[[ -f "${PROJECT_ROOT}/dist/cli.js" ]] || fail "dist/cli.js is missing; run npm run build first"

active_state="$(systemctl show "${SERVICE}" -p ActiveState --value 2>/dev/null || true)"
sub_state="$(systemctl show "${SERVICE}" -p SubState --value 2>/dev/null || true)"
restart_policy="$(systemctl show "${SERVICE}" -p Restart --value 2>/dev/null || true)"
main_pid="$(systemctl show "${SERVICE}" -p MainPID --value 2>/dev/null || true)"
need_daemon_reload="$(systemctl show "${SERVICE}" -p NeedDaemonReload --value 2>/dev/null || true)"
tunnel_active="$(systemctl is-active "${TUNNEL_SERVICE}" 2>/dev/null || true)"
tunnel_pid="$(systemctl show "${TUNNEL_SERVICE}" -p MainPID --value 2>/dev/null || true)"

[[ "${active_state}" == "active" && "${sub_state}" == "running" ]] || fail "${SERVICE} is not active/running (${active_state}/${sub_state})"
[[ "${restart_policy}" == "always" ]] || fail "${SERVICE} must use Restart=always (found: ${restart_policy:-unknown})"
[[ "${main_pid}" =~ ^[1-9][0-9]*$ ]] || fail "invalid ${SERVICE} MainPID: ${main_pid:-missing}"
kill -0 "${main_pid}" 2>/dev/null || fail "MainPID ${main_pid} is not alive or not signalable"
[[ "${tunnel_active}" == "active" ]] || fail "${TUNNEL_SERVICE} is not active"
[[ "${tunnel_pid}" =~ ^[1-9][0-9]*$ ]] || fail "invalid ${TUNNEL_SERVICE} MainPID: ${tunnel_pid:-missing}"

service_uid="$(stat -c '%u' "/proc/${main_pid}" 2>/dev/null || true)"
current_uid="$(id -u)"
[[ -n "${service_uid}" && "${service_uid}" == "${current_uid}" ]] || fail "service owner uid ${service_uid:-unknown} does not match current uid ${current_uid}"

if [[ "${need_daemon_reload}" == "yes" ]]; then
  log "warning: systemd reports NeedDaemonReload=yes; this action reloads application code only"
fi

log "preflight OK service=${SERVICE} MainPID=${main_pid} restart=${restart_policy} tunnel_pid=${tunnel_pid}"

if [[ "${MODE}" == "--check" ]]; then
  exit 0
fi
[[ "${MODE}" == "reload" ]] || fail "usage: bash scripts/reload-jk-runtime.sh [--check]"
[[ "${DELAY_SEC}" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "JK_RELOAD_DELAY_SEC must be numeric"

# Return success to the approval job before restarting JK. A detached helper
# signals the service after the caller has received this command result, so
# the job can be persisted as succeeded instead of being orphaned as running.
# Follow-up health/schema checks are read-only and happen after reconnect.
nohup /bin/sh -c 'sleep "$1"; kill -TERM "$2"' jk-reload "${DELAY_SEC}" "${main_pid}" \
  >/dev/null 2>&1 </dev/null &
helper_pid=$!

log "reload scheduled service=${SERVICE} main_pid=${main_pid} helper_pid=${helper_pid} delay=${DELAY_SEC}s tunnel_pid=${tunnel_pid}"