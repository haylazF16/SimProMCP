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

# funnel — probe the public URL directly (more reliable than `tailscale funnel
# status` which returns nothing when this script runs as root via sudo, because
# only the tailscale operator user sees state). Override host via FUNNEL_URL.
FUNNEL_URL="${FUNNEL_URL:-https://goldman-ubuntu.tail6b5a4b.ts.net/healthz}"
if curl -fsS -m 5 -o /dev/null "${FUNNEL_URL}" 2>/dev/null; then
  line "funnel:" "on (${FUNNEL_URL})"
else
  line "funnel:" "UNREACHABLE (${FUNNEL_URL})"; rc=1
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

# systemd failed units — count all (informational) but only fail rc when a
# simpro-mcp unit is among them. Unrelated failed services on the box
# (e.g. xrdp from another project) shouldn't cause our health check to alarm.
fc="$(systemctl --failed --no-legend 2>/dev/null | wc -l)"
simpro_fc="$(systemctl --failed --no-legend 2>/dev/null | grep -c simpro-mcp || true)"
line "failed:" "${fc} (simpro-mcp=${simpro_fc})"
[ "${simpro_fc:-0}" -gt 0 ] && rc=1

exit "${rc}"
