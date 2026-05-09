#!/usr/bin/env bash
# revoke-user.sh — remove a user's token from tokens.json.
# Run: sudo bash /opt/simpro-mcp/scripts/revoke-user.sh

set -euo pipefail

TOKENS_FILE="${SIMPRO_TOKENS_FILE:-/opt/simpro-mcp/tokens.json}"
SERVICE_USER="${SERVICE_USER:-simpro-mcp}"

red()    { printf '\e[31m%s\e[0m\n' "$*" >&2; }
yellow() { printf '\e[33m%s\e[0m\n' "$*"; }
green()  { printf '\e[32m%s\e[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  red "Need sudo. Run:  sudo bash $0"
  exit 1
fi

if [[ ! -f "$TOKENS_FILE" ]]; then
  red "No tokens file at $TOKENS_FILE."
  exit 1
fi

read -r -p "Whose access do you want to revoke? (name substring): " QUERY
[[ -z "$QUERY" ]] && { red "Empty query, aborted."; exit 1; }

# Find matching tokens
mapfile -t MATCHES < <(jq -r --arg q "$QUERY" '
    .tokens
    | to_entries[]
    | select((.value.name // "") | test($q; "i"))
    | "\(.key)\t\(.value.name)\t\(.value.companyAccess | join(","))"
' "$TOKENS_FILE")

if [[ ${#MATCHES[@]} -eq 0 ]]; then
  red "No user matches '$QUERY'."
  exit 1
fi

echo
i=0
for line in "${MATCHES[@]}"; do
  i=$((i+1))
  IFS=$'\t' read -r tok name companies <<<"$line"
  masked="${tok:0:9}...${tok: -4}"
  printf "  [%d] %s  (%s)  token=%s\n" "$i" "$name" "$companies" "$masked"
done
echo

read -r -p "Pick a number to revoke (or blank to cancel): " PICK
[[ -z "$PICK" ]] && { yellow "Cancelled."; exit 0; }
if ! [[ "$PICK" =~ ^[0-9]+$ ]] || [[ "$PICK" -lt 1 ]] || [[ "$PICK" -gt "${#MATCHES[@]}" ]]; then
  red "Out of range."
  exit 1
fi

IFS=$'\t' read -r TARGET_TOKEN TARGET_NAME _ <<<"${MATCHES[$((PICK-1))]}"

read -r -p "Type the user's name to confirm revocation: " CONFIRM
if [[ "$CONFIRM" != "$TARGET_NAME" ]]; then
  red "Name mismatch, cancelled."
  exit 1
fi

# Atomic delete
TMP=$(mktemp)
jq --arg tok "$TARGET_TOKEN" 'del(.tokens[$tok])' "$TOKENS_FILE" > "$TMP"
mv "$TMP" "$TOKENS_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$TOKENS_FILE"
chmod 600 "$TOKENS_FILE"

green ""
green "Revoked $TARGET_NAME. Their token will be rejected on the next request."
yellow "Tip: also delete that user's API key in Simpro for full access removal."
