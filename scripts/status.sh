#!/usr/bin/env bash
# scripts/status.sh — one-screen health check. Exit 0 = all healthy.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/simpro-mcp}"
BK="${APP_DIR}/backups"
PORT="${SIMPRO_HTTP_PORT:-3001}"
rc=0

line() { printf '%-12s %s\n' "$1" "$2"; }

# service
if systemctl is-active --quiet simpro-mcp; then
  since="$(systemctl show simpro-mcp -p ActiveEnterTimestamp --value)"
  line "service:" "active (since ${since})"
else
  line "service:" "FAILED"; rc=1
fi

# listen
if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
  line "listen:" "127.0.0.1:${PORT} OK"
else
  line "listen:" "UNREACHABLE"; rc=1
fi

# funnel
if command -v tailscale >/dev/null 2>&1 && tailscale funnel status 2>/dev/null | grep -q "Funnel on"; then
  line "funnel:" "on"
else
  line "funnel:" "OFF (or tailscale unavailable)"
fi

# backups
tnewest="$(ls -1 "${BK}/tokens" 2>/dev/null | sort | tail -n1)"
line "backups:" "tokens=${tnewest:-NONE} audit=$( [ -f "${BK}/audit/audit.log.current.bak" ] && echo present || echo NONE )"
[ -z "${tnewest:-}" ] && rc=1

# timers
for t in simpro-mcp-backup-tokens.timer simpro-mcp-backup-audit.timer; do
  if systemctl is-active --quiet "${t}"; then s=ok; else s=DOWN; rc=1; fi
  line "timer:" "${t}=${s}"
done

# errors in last 24h
errs="$(journalctl -u simpro-mcp --since '24 hours ago' --no-pager 2>/dev/null | grep -cE '\[(error|fatal|srv-error)\]' || true)"
line "errors24h:" "${errs:-0}"

# systemd failed units
fc="$(systemctl --failed --no-legend 2>/dev/null | wc -l)"
line "failed:" "${fc}"
[ "${fc}" -gt 0 ] && rc=1

exit "${rc}"
