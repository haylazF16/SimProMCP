#!/usr/bin/env bash
# install-on-ubuntu.sh
#
# One-shot installer for the Simpro MCP server on Ubuntu (24.04+).
# Installs Node.js 20 LTS, clones the repo into /opt/simpro-mcp,
# builds it, creates a `simpro-mcp` system user, installs the systemd
# service, configures the firewall, and starts the service.
#
# The MCP server binds to the Tailscale IP only (so it's literally
# unreachable from anywhere except devices on your tailnet — even if
# someone's on your office Wi-Fi without Tailscale, they can't see it).
#
# Run: sudo bash scripts/install-on-ubuntu.sh
#  OR: curl -fsSL https://raw.githubusercontent.com/haylazF16/SimProMCP/feat/http-transport/scripts/install-on-ubuntu.sh | sudo bash

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override via env vars before invoking the script if needed)
# ---------------------------------------------------------------------------
INSTALL_DIR="${INSTALL_DIR:-/opt/simpro-mcp}"
REPO_URL="${REPO_URL:-https://github.com/haylazF16/SimProMCP.git}"
REPO_BRANCH="${REPO_BRANCH:-feat/http-transport}"
SERVICE_USER="${SERVICE_USER:-simpro-mcp}"
SERVICE_NAME="simpro-mcp"
HTTP_PORT="${HTTP_PORT:-3001}"

# ---------------------------------------------------------------------------
# Colour-coded output helpers
# ---------------------------------------------------------------------------
red()   { printf '\e[31m%s\e[0m\n' "$*" >&2; }
green() { printf '\e[32m%s\e[0m\n' "$*"; }
blue()  { printf '\e[34m%s\e[0m\n' "$*"; }
yellow(){ printf '\e[33m%s\e[0m\n' "$*"; }

step() { echo; blue "=== $* ==="; }
ok()   { green "  ✓ $*"; }
warn() { yellow "  ! $*"; }
die()  { red    "  ✗ $*"; exit 1; }

# ---------------------------------------------------------------------------
# 0. Pre-flight
# ---------------------------------------------------------------------------
step "Pre-flight checks"

if [[ $EUID -ne 0 ]]; then
  die "This script must be run as root. Use:  sudo bash $0"
fi

if [[ ! -f /etc/os-release ]] || ! grep -q -i "ubuntu" /etc/os-release; then
  die "This script targets Ubuntu. /etc/os-release does not show Ubuntu."
fi

UBUNTU_VERSION=$(. /etc/os-release && echo "$VERSION_ID")
ok "Ubuntu $UBUNTU_VERSION detected"

# Tailscale must be installed and running
if ! command -v tailscale >/dev/null 2>&1; then
  die "Tailscale is not installed. Install it first: https://tailscale.com/download/linux"
fi
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
if [[ -z "$TAILSCALE_IP" ]]; then
  die "Tailscale is installed but not connected. Run:  sudo tailscale up"
fi
ok "Tailscale running, server IP: $TAILSCALE_IP"

# Check port is free
if ss -tlnp 2>/dev/null | grep -q ":$HTTP_PORT "; then
  die "Port $HTTP_PORT is already in use. Stop whatever is using it or set HTTP_PORT=different-number."
fi
ok "Port $HTTP_PORT is free"

# ---------------------------------------------------------------------------
# 1. Install OS packages
# ---------------------------------------------------------------------------
step "Installing system packages (Node.js, git, ufw)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# Node.js 20 LTS via NodeSource if not already a recent enough version
NODE_NEEDED=true
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$CURRENT_NODE" -ge 20 ]]; then
    ok "Node.js $(node --version) already installed"
    NODE_NEEDED=false
  fi
fi
if $NODE_NEEDED; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
  ok "Node.js $(node --version) installed"
fi

apt-get install -y -qq git ufw curl jq >/dev/null 2>&1
ok "git, ufw, curl, jq installed"

# ---------------------------------------------------------------------------
# 2. Create the unprivileged service user
# ---------------------------------------------------------------------------
step "Creating service user '$SERVICE_USER'"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system \
          --home-dir "$INSTALL_DIR" \
          --shell /usr/sbin/nologin \
          --comment "Simpro MCP server" \
          "$SERVICE_USER"
  ok "User '$SERVICE_USER' created"
else
  ok "User '$SERVICE_USER' already exists"
fi

# ---------------------------------------------------------------------------
# 3. Clone or update the repo
# ---------------------------------------------------------------------------
step "Fetching code from $REPO_URL ($REPO_BRANCH)"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "$INSTALL_DIR already has a git checkout — pulling latest"
  sudo -u "$SERVICE_USER" -- git -C "$INSTALL_DIR" fetch --quiet origin "$REPO_BRANCH"
  sudo -u "$SERVICE_USER" -- git -C "$INSTALL_DIR" checkout --quiet "$REPO_BRANCH"
  sudo -u "$SERVICE_USER" -- git -C "$INSTALL_DIR" reset --hard --quiet "origin/$REPO_BRANCH"
  ok "Repo updated to latest $REPO_BRANCH"
else
  mkdir -p "$INSTALL_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" -- git clone --quiet --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "Repo cloned"
fi

# ---------------------------------------------------------------------------
# 4. Install dependencies and build
# ---------------------------------------------------------------------------
step "Installing dependencies + building"

cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" -- npm ci --silent
ok "npm ci done"
sudo -u "$SERVICE_USER" -- npm run build --silent
ok "npm run build done — dist/index.js exists"

# ---------------------------------------------------------------------------
# 5. Write the .env file (safety flags + binding) if not already present
# ---------------------------------------------------------------------------
step "Writing $INSTALL_DIR/.env"

ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — leaving it alone. Edit manually if needed."
else
  cat > "$ENV_FILE" <<EOF
# Goldman Simpro MCP server runtime config (managed by install-on-ubuntu.sh)
# Edit this file then 'sudo systemctl restart $SERVICE_NAME' to apply.

# Transport: HTTP server mode (LAN/Tailscale)
SIMPRO_TRANSPORT=http

# Bind ONLY to the Tailscale IP. The server is literally unreachable from
# devices that aren't on your tailnet, even on the office LAN.
SIMPRO_HTTP_HOST=$TAILSCALE_IP
SIMPRO_HTTP_PORT=$HTTP_PORT

# Per-deployment Simpro values
SIMPRO_BASE_URL=https://goldmanplumbingservices.simprosuite.com
SIMPRO_COMPANY_ID=4

# Per-user keys come from tokens.json, but a fallback is required at startup
# even though it isn't used at runtime in HTTP mode.
SIMPRO_API_KEY=placeholder-replaced-per-request-from-tokens.json

# Safety flags. Leave these as the conservative defaults until a user
# (you) has tested writes are working as intended.
SIMPRO_ENABLE_WRITE_TOOLS=false
SIMPRO_DRY_RUN=true

# File paths
SIMPRO_TOKENS_FILE=$INSTALL_DIR/tokens.json
SIMPRO_AUDIT_FILE=$INSTALL_DIR/audit.log
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  ok ".env written (writes disabled, dry-run on — flip these manually when ready)"
fi

# Create empty tokens.json if missing
TOKENS_FILE="$INSTALL_DIR/tokens.json"
if [[ ! -f "$TOKENS_FILE" ]]; then
  echo '{"tokens": {}}' > "$TOKENS_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$TOKENS_FILE"
  chmod 600 "$TOKENS_FILE"
  ok "Empty tokens.json created (run scripts/add-user.sh to add users)"
fi

# Touch the audit log
AUDIT_FILE="$INSTALL_DIR/audit.log"
if [[ ! -f "$AUDIT_FILE" ]]; then
  touch "$AUDIT_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$AUDIT_FILE"
  chmod 640 "$AUDIT_FILE"
fi

# ---------------------------------------------------------------------------
# 6. Install + start the systemd service
# ---------------------------------------------------------------------------
step "Installing systemd unit + starting $SERVICE_NAME"

cp "$INSTALL_DIR/scripts/$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable --quiet "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Wait briefly for service to come up
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "$SERVICE_NAME is running"
else
  red "Service failed to start. Last 30 lines of journal:"
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2
  exit 1
fi

# --- S6: backups + timers ---
install -d -o simpro-mcp -g simpro-mcp -m 700 /opt/simpro-mcp/backups
cp /opt/simpro-mcp/scripts/simpro-mcp-backup-tokens.service /etc/systemd/system/
cp /opt/simpro-mcp/scripts/simpro-mcp-backup-tokens.timer   /etc/systemd/system/
cp /opt/simpro-mcp/scripts/simpro-mcp-backup-audit.service  /etc/systemd/system/
cp /opt/simpro-mcp/scripts/simpro-mcp-backup-audit.timer    /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now simpro-mcp-backup-tokens.timer
systemctl enable --now simpro-mcp-backup-audit.timer
echo "S6 backup timers installed and enabled."

# ---------------------------------------------------------------------------
# 7. Firewall: allow Tailscale only, block port $HTTP_PORT from elsewhere
# ---------------------------------------------------------------------------
step "Configuring firewall (UFW)"

# Make sure UFW is enabled but doesn't break SSH on first run
if ! ufw status | grep -q "Status: active"; then
  warn "UFW not active. Enabling now — keeping SSH allowed so you don't get locked out."
  ufw allow OpenSSH >/dev/null
  yes | ufw enable >/dev/null
fi

# Allow port $HTTP_PORT only from Tailscale interface
ufw allow in on tailscale0 to any port "$HTTP_PORT" proto tcp >/dev/null 2>&1 || true
# And explicitly DENY it from anywhere else (defense in depth, even though
# we bind to the Tailscale IP only)
ufw deny "$HTTP_PORT/tcp" >/dev/null 2>&1 || true
# But re-allow it on tailscale0 (re-running the above lines reorders things)
ufw delete deny "$HTTP_PORT/tcp" >/dev/null 2>&1 || true
ufw allow in on tailscale0 to any port "$HTTP_PORT" proto tcp >/dev/null 2>&1 || true
ufw reload >/dev/null
ok "Firewall: port $HTTP_PORT allowed from tailscale0 only"

# ---------------------------------------------------------------------------
# 8. Smoke test
# ---------------------------------------------------------------------------
step "Smoke test"

HEALTH_URL="http://$TAILSCALE_IP:$HTTP_PORT/healthz"
if HEALTH_RESP=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null); then
  ok "Health probe: $HEALTH_RESP"
else
  warn "Health probe failed — service may still be starting. Check 'journalctl -u $SERVICE_NAME -f'"
fi

# ---------------------------------------------------------------------------
# 9. Done
# ---------------------------------------------------------------------------
echo
green "=============================================================="
green "  Simpro MCP server installed and running on Ubuntu."
green "=============================================================="
echo
echo "Server status:        sudo systemctl status $SERVICE_NAME"
echo "Live logs:            sudo journalctl -u $SERVICE_NAME -f"
echo "Restart after .env edit:  sudo systemctl restart $SERVICE_NAME"
echo
echo "Next steps:"
echo "  1. Add yourself as the first user:"
echo "       sudo bash $INSTALL_DIR/scripts/add-user.sh"
echo "  2. Once writes are tested, edit $INSTALL_DIR/.env to flip"
echo "     SIMPRO_DRY_RUN=false (then 'sudo systemctl restart $SERVICE_NAME')."
echo "  3. Coworker connection URL (give to them with their bearer token):"
echo "       http://goldman-ubuntu:$HTTP_PORT/mcp/plumbing"
echo "       http://goldman-ubuntu:$HTTP_PORT/mcp/energy"
echo "     (Coworkers must be on Tailscale to reach these.)"
echo
green "Done."
