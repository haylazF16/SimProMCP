#!/usr/bin/env bash
# scripts/backup.sh — local tiered backups for the Simpro MCP server.
#
# Subcommands:
#   tokens   copy tokens.json if it differs (sha256) from the newest backup
#   env      copy .env if it differs (sha256) from the newest backup
#   audit    refresh the rolling daily copy; on the 1st, archive prev month
#   prune    apply retention (tokens: newest 96; env: newest 5)
#
# Paths are derived from APP_DIR (default /opt/simpro-mcp). Override via env
# for testing: APP_DIR=/tmp/test scripts/backup.sh tokens
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/simpro-mcp}"
BK="${APP_DIR}/backups"
TOKENS="${APP_DIR}/tokens.json"
ENVF="${APP_DIR}/.env"
AUDIT="${APP_DIR}/audit.log"

mkdir -p "${BK}/tokens" "${BK}/audit" "${BK}/env"
chmod 700 "${BK}"

ts() { date -u +%Y%m%dT%H%M%SZ; }

# newest_file DIR -> prints newest file path by name (ISO ts sorts lexically)
newest_file() {
  local d="$1"
  ls -1 "${d}" 2>/dev/null | sort | tail -n1 | sed "s|^|${d}/|"
}

snapshot_if_changed() {
  local src="$1" dir="$2" prefix="$3"
  [ -f "${src}" ] || { echo "skip: ${src} missing"; return 0; }
  local newest cur new
  newest="$(newest_file "${dir}")"
  cur="$(sha256sum "${src}" | awk '{print $1}')"
  if [ -n "${newest}" ] && [ -f "${newest}" ]; then
    new="$(sha256sum "${newest}" | awk '{print $1}')"
    if [ "${cur}" = "${new}" ]; then echo "unchanged: ${prefix}"; return 0; fi
  fi
  local out="${dir}/${prefix}.$(ts).bak"
  cp "${src}" "${out}.tmp" && mv "${out}.tmp" "${out}"
  echo "wrote: ${out}"
}

cmd_tokens() { snapshot_if_changed "${TOKENS}" "${BK}/tokens" "tokens.json"; }
cmd_env()    { snapshot_if_changed "${ENVF}"   "${BK}/env"    "env"; }

cmd_audit() {
  [ -f "${AUDIT}" ] || { echo "skip: ${AUDIT} missing"; return 0; }
  # Rolling current full copy (single overwritten file).
  cp "${AUDIT}" "${BK}/audit/audit.log.current.bak.tmp"
  mv "${BK}/audit/audit.log.current.bak.tmp" "${BK}/audit/audit.log.current.bak"
  echo "wrote: ${BK}/audit/audit.log.current.bak"
  # On the 1st of the month, archive the PREVIOUS month's lines as gzip.
  if [ "$(date -u +%d)" = "01" ]; then
    local prev arc
    prev="$(date -u -d 'last month' +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)"
    arc="${BK}/audit/audit-${prev}.log.gz"
    if [ ! -f "${arc}" ]; then
      # Lines whose JSON "ts" begins with the previous YYYY-MM.
      grep "\"ts\":\"${prev}" "${AUDIT}" 2>/dev/null | gzip -c > "${arc}.tmp" \
        && mv "${arc}.tmp" "${arc}" \
        && echo "archived: ${arc}" \
        || { rm -f "${arc}.tmp"; echo "no lines for ${prev}, skipped archive"; }
    fi
  fi
}

prune_dir() {
  local dir="$1" keep="$2"
  local n
  n="$(ls -1 "${dir}" 2>/dev/null | wc -l)"
  if [ "${n}" -gt "${keep}" ]; then
    ls -1 "${dir}" | sort | head -n "$((n - keep))" | while read -r f; do
      rm -f "${dir}/${f}"; echo "pruned: ${dir}/${f}"
    done
  fi
}

cmd_prune() {
  prune_dir "${BK}/tokens" 96
  prune_dir "${BK}/env" 5
  # Audit: rolling copy is a single file; monthly gzips kept forever.
}

case "${1:-}" in
  tokens) cmd_tokens ;;
  env)    cmd_env ;;
  audit)  cmd_audit ;;
  prune)  cmd_prune ;;
  *) echo "usage: $0 {tokens|env|audit|prune}" >&2; exit 2 ;;
esac
