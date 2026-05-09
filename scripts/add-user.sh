#!/usr/bin/env bash
# add-user.sh — register a new coworker in tokens.json.
# Run on the Ubuntu server: sudo bash /opt/simpro-mcp/scripts/add-user.sh

set -euo pipefail

TOKENS_FILE="${SIMPRO_TOKENS_FILE:-/opt/simpro-mcp/tokens.json}"
SERVICE_USER="${SERVICE_USER:-simpro-mcp}"

# Tailscale-aware coworker URL (taken from the install script's defaults)
TAILNET_HOSTNAME="${TAILNET_HOSTNAME:-goldman-ubuntu}"
HTTP_PORT="${HTTP_PORT:-3001}"

red()    { printf '\e[31m%s\e[0m\n' "$*" >&2; }
green()  { printf '\e[32m%s\e[0m\n' "$*"; }
cyan()   { printf '\e[36m%s\e[0m\n' "$*"; }
yellow() { printf '\e[33m%s\e[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  red "This script needs sudo (it writes to $TOKENS_FILE)."
  red "Run:  sudo bash $0"
  exit 1
fi

if [[ ! -f "$TOKENS_FILE" ]]; then
  echo '{"tokens": {}}' > "$TOKENS_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$TOKENS_FILE"
  chmod 600 "$TOKENS_FILE"
fi

if ! command -v jq >/dev/null 2>&1; then
  red "'jq' is required. Install:  sudo apt-get install -y jq"
  exit 1
fi

# ---------------------------------------------------------------------------
# Generate a fresh bearer token
# ---------------------------------------------------------------------------
new_token() {
  # 32 random bytes, base64url-encoded, prefixed
  local b64
  b64=$(head -c 32 /dev/urandom | base64 | tr -d '=' | tr '/+' '_-')
  echo "smcp_$b64"
}

# ---------------------------------------------------------------------------
# Interactive prompts
# ---------------------------------------------------------------------------
echo
green "  Add a new Simpro MCP user"
echo "  Tokens file: $TOKENS_FILE"
echo

read -r -p "Person's name (e.g. 'Tayfun Yildirim'): " NAME
[[ -z "$NAME" ]] && { red "Name cannot be empty."; exit 1; }

echo
read -r -p "Their Simpro API key (paste the token from Simpro System -> API Keys): " SIMPRO_KEY
[[ -z "$SIMPRO_KEY" ]] && { red "API key cannot be empty."; exit 1; }
if [[ ${#SIMPRO_KEY} -lt 20 ]]; then
  red "That doesn't look like a Simpro API key (too short). Aborting."
  exit 1
fi

echo
echo "Which Goldman company can this user access?"
echo "  [1] Plumbing only"
echo "  [2] Energy only"
echo "  [3] Both"
read -r -p "Pick 1, 2 or 3 [3]: " CHOICE
CHOICE="${CHOICE:-3}"
case "$CHOICE" in
  1) COMPANIES='["plumbing"]' ;;
  2) COMPANIES='["energy"]' ;;
  3) COMPANIES='["plumbing","energy"]' ;;
  *) red "Invalid choice."; exit 1 ;;
esac

echo
read -r -p "Allow this user to CREATE/UPDATE Simpro records? [y/N]: " WRITES
case "${WRITES,,}" in
  y|yes) WRITE_ENABLED=true ;;
  *)     WRITE_ENABLED=false ;;
esac

# ---------------------------------------------------------------------------
# Generate token + persist
# ---------------------------------------------------------------------------
TOKEN=$(new_token)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Atomic update: jq + sponge-style temp+rename
TMP=$(mktemp)
jq --arg tok "$TOKEN" \
   --arg name "$NAME" \
   --arg key "$SIMPRO_KEY" \
   --argjson companies "$COMPANIES" \
   --argjson writes "$WRITE_ENABLED" \
   --arg created "$NOW" \
   '.tokens[$tok] = {
       name: $name,
       simproApiKey: $key,
       companyAccess: $companies,
       writeEnabled: $writes,
       createdAt: $created
    }' "$TOKENS_FILE" > "$TMP"
mv "$TMP" "$TOKENS_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$TOKENS_FILE"
chmod 600 "$TOKENS_FILE"

# ---------------------------------------------------------------------------
# Output — what to send the user
# ---------------------------------------------------------------------------
echo
green "==== User added ===="
echo "  Name:         $NAME"
echo "  Companies:    $(echo "$COMPANIES" | jq -r 'join(", ")')"
echo "  Write tools:  $WRITE_ENABLED"
echo
yellow "  Bearer token (give to user, then DO NOT keep this on screen):"
cyan   "  $TOKEN"
echo
echo "Send the user this connection info (paste into Claude Desktop ->"
echo "Settings -> Connectors -> Add custom connector -> Bearer auth):"
echo
echo "  Name:    Goldman Plumbing"
echo "  URL:     http://$TAILNET_HOSTNAME:$HTTP_PORT/mcp/plumbing"
echo "  Bearer:  $TOKEN"
echo
echo "  Name:    Goldman Energy"
echo "  URL:     http://$TAILNET_HOSTNAME:$HTTP_PORT/mcp/energy"
echo "  Bearer:  $TOKEN"
echo
echo "(Coworker must be on the same Tailscale tailnet to reach the URLs.)"
echo
