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
if ! systemctl stop simpro-mcp; then
  echo "ERROR: could not stop simpro-mcp (are you root? try: sudo $0 ...)." >&2
  echo "Nothing was changed. The service is still running." >&2
  exit 1
fi

PRE_RESTORE="${DEST}.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
cp "${DEST}" "${PRE_RESTORE}" 2>/dev/null || PRE_RESTORE="(none — ${DEST} did not exist)"
cp "${SRC}" "${DEST}.tmp" && mv "${DEST}.tmp" "${DEST}"
chown simpro-mcp:simpro-mcp "${DEST}" 2>/dev/null || true
chmod 600 "${DEST}"

echo "Starting simpro-mcp..."
systemctl start simpro-mcp
sleep 2
if systemctl is-active --quiet simpro-mcp; then
  echo "restore OK — service is running."
else
  {
    echo ""
    echo "!!! RESTORE PROBLEM !!!"
    echo "The simpro-mcp service did NOT come back up and is currently STOPPED."
    echo ""
    echo "Most likely cause: this script was not run as root, so the file"
    echo "ownership (chown simpro-mcp) could not be set and the service user"
    echo "cannot read ${DEST}."
    echo ""
    echo "Try:"
    echo "  1. Re-run this script with sudo:  sudo $0 ${KIND} ${SRC}"
    echo "  2. Inspect why it failed:         sudo journalctl -u simpro-mcp -n 50 --no-pager"
    echo ""
    echo "Your previous ${KIND} file was saved to:"
    echo "  ${PRE_RESTORE}"
    echo "Restore THAT if you need to roll back this restore attempt."
  } >&2
  exit 1
fi
