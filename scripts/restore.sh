#!/usr/bin/env bash
# scripts/restore.sh — guided restore of tokens.json or .env from a backup.
#
# Usage:
#   sudo scripts/restore.sh tokens /opt/simpro-mcp/backups/tokens/tokens.json.<TS>.bak
#   sudo scripts/restore.sh env    /opt/simpro-mcp/backups/env/env.<TS>.bak
#
# Stops the service, validates, copies, restarts. Confirm prompt before write.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/simpro-mcp}"
KIND="${1:-}"
SRC="${2:-}"

case "${KIND}" in
  tokens) DEST="${APP_DIR}/tokens.json" ;;
  env)    DEST="${APP_DIR}/.env" ;;
  *) echo "usage: $0 {tokens|env} <backup-file>" >&2; exit 2 ;;
esac

[ -f "${SRC}" ] || { echo "backup file not found: ${SRC}" >&2; exit 1; }

if [ "${KIND}" = "tokens" ]; then
  # Validate JSON before we overwrite the live file.
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${SRC}" 2>/dev/null; then
    echo "REFUSING: ${SRC} is not valid JSON" >&2; exit 1
  fi
fi

echo "About to restore:"
echo "  from: ${SRC}"
echo "  to:   ${DEST}"
read -r -p "Type 'yes' to proceed: " ans
[ "${ans}" = "yes" ] || { echo "aborted"; exit 0; }

echo "Stopping simpro-mcp..."
systemctl stop simpro-mcp

cp "${DEST}" "${DEST}.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
cp "${SRC}" "${DEST}.tmp" && mv "${DEST}.tmp" "${DEST}"
chown simpro-mcp:simpro-mcp "${DEST}" 2>/dev/null || true
chmod 600 "${DEST}"

echo "Starting simpro-mcp..."
systemctl start simpro-mcp
sleep 2
systemctl is-active simpro-mcp && echo "restore OK" || { echo "service did not come up — check journalctl" >&2; exit 1; }
