#!/usr/bin/env bash
# list-users.sh — show users registered in tokens.json (no secrets shown).
# Run: sudo bash /opt/simpro-mcp/scripts/list-users.sh

set -euo pipefail

TOKENS_FILE="${SIMPRO_TOKENS_FILE:-/opt/simpro-mcp/tokens.json}"

if [[ $EUID -ne 0 ]]; then
  echo "Need sudo (the tokens file is mode 600)." >&2
  echo "Run:  sudo bash $0" >&2
  exit 1
fi

if [[ ! -f "$TOKENS_FILE" ]]; then
  echo "No tokens file at $TOKENS_FILE — run scripts/add-user.sh first."
  exit 0
fi

echo
printf '%-30s  %-12s  %-7s  %-20s  %s\n' "Name" "Companies" "Writes" "Created" "Token (masked)"
printf '%-30s  %-12s  %-7s  %-20s  %s\n' "-----" "---------" "------" "-------" "--------------"

count=$(jq -r '.tokens | keys | length' "$TOKENS_FILE")
if [[ "$count" -eq 0 ]]; then
  echo "(no users registered)"
  exit 0
fi

jq -r '
  .tokens
  | to_entries[]
  | "\(.key)\t\(.value.name)\t\(.value.companyAccess | join(","))\t\(.value.writeEnabled // false)\t\(.value.createdAt // "unknown")"
' "$TOKENS_FILE" \
| while IFS=$'\t' read -r tok name companies writes created; do
    masked="${tok:0:9}...${tok: -4}"
    printf '%-30s  %-12s  %-7s  %-20s  %s\n' \
      "$name" "$companies" "$writes" "${created:0:19}" "$masked"
  done

echo
echo "$count user(s) registered."
