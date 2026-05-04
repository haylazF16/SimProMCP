# Install the Simpro MCP HTTP server as a Windows service.
#
# Run from an ELEVATED PowerShell (Run as Administrator) on the server PC.
#
# What this does:
#   1. Verifies elevation, Node.js, and that the project is built (dist/).
#   2. Sets the system environment variables the service needs.
#   3. Installs node-windows (one-time, into the project folder).
#   4. Calls scripts/service-control.js install, which registers the service
#      with the Windows Service Control Manager and starts it.
#
# After install, the service:
#   - Auto-starts at boot (no logon required)
#   - Auto-restarts up to 5 times if it crashes
#   - Logs to Windows Event Viewer under source "GoldmanSimproMCP"
#   - Listens on http://0.0.0.0:3001 (all LAN interfaces)
#
# Migration to a different server PC later: just run this script there with
# the same project folder, after copying tokens.json across.

$ErrorActionPreference = "Stop"

function Section($t) { Write-Host ""; Write-Host "==== $t ====" -ForegroundColor Cyan }

# ---- Elevation check ----
Section "Pre-flight checks"
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$p  = New-Object System.Security.Principal.WindowsPrincipal($id)
if (-not $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must run from an elevated (Administrator) PowerShell." -ForegroundColor Red
  Write-Host "Right-click the PowerShell icon and choose 'Run as administrator', then re-run."
  exit 1
}
Write-Host "  Running as Administrator. OK." -ForegroundColor Green

# ---- Node.js ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js not found on PATH. Install LTS from https://nodejs.org first." -ForegroundColor Red
  exit 1
}
Write-Host "  Node.js: $((& node --version))"

# ---- Project root ----
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

if (-not (Test-Path "$root\dist\index.js")) {
  Write-Host "  dist/index.js not found. Building..." -ForegroundColor Yellow
  & npm install
  & npm run build
}
Write-Host "  Project root: $root"

# ---- Configuration prompt ----
Section "Service configuration"
function Read-WithDefault($prompt, $default) {
  $v = Read-Host "$prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}

$baseUrl = Read-WithDefault "Simpro base URL" "https://goldmanplumbingservices.simprosuite.com"
$companyId = Read-WithDefault "Default company ID (used only for legacy requests)" "4"
$bindHost = Read-WithDefault "Bind address (0.0.0.0 = all LAN, 127.0.0.1 = localhost only)" "0.0.0.0"
$port = Read-WithDefault "Port" "3001"

$tokensPath = Join-Path $root "tokens.json"
$auditPath  = Join-Path $root "audit.log"
Write-Host ""
Write-Host "  tokens.json -> $tokensPath"
Write-Host "  audit.log   -> $auditPath"

# ---- Set system env vars (so the service inherits them) ----
Section "Setting system environment"
function Set-SysEnv($name, $value) {
  Write-Host "  $name = $value"
  [System.Environment]::SetEnvironmentVariable($name, $value, [System.EnvironmentVariableTarget]::Machine)
}
Set-SysEnv "SIMPRO_TRANSPORT"   "http"
Set-SysEnv "SIMPRO_BASE_URL"    $baseUrl
Set-SysEnv "SIMPRO_COMPANY_ID"  $companyId
Set-SysEnv "SIMPRO_HTTP_HOST"   $bindHost
Set-SysEnv "SIMPRO_HTTP_PORT"   $port
Set-SysEnv "SIMPRO_TOKENS_FILE" $tokensPath
Set-SysEnv "SIMPRO_AUDIT_FILE"  $auditPath
Set-SysEnv "SIMPRO_DRY_RUN"     "true"
# Mirror them to the current session too so service-control.js sees them.
$env:SIMPRO_TRANSPORT   = "http"
$env:SIMPRO_BASE_URL    = $baseUrl
$env:SIMPRO_COMPANY_ID  = $companyId
$env:SIMPRO_HTTP_HOST   = $bindHost
$env:SIMPRO_HTTP_PORT   = $port
$env:SIMPRO_TOKENS_FILE = $tokensPath
$env:SIMPRO_AUDIT_FILE  = $auditPath
$env:SIMPRO_DRY_RUN     = "true"

# ---- Install node-windows (devDep) ----
Section "Installing node-windows"
& npm install --no-save node-windows

# ---- Firewall rule for the chosen port (LAN bind only) ----
if ($bindHost -ne "127.0.0.1") {
  Section "Adding Windows Firewall rule"
  $ruleName = "Goldman Simpro MCP ($port/tcp)"
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "  Rule already exists. Skipping."
  } else {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private,Domain | Out-Null
    Write-Host "  Inbound TCP $port allowed on Private + Domain networks." -ForegroundColor Green
    Write-Host "  (Public networks are NOT allowed — connect via office Wi-Fi or VPN.)" -ForegroundColor Yellow
  }
}

# ---- Install the service ----
Section "Installing Windows service"
& node "$root\scripts\service-control.js" install

Section "Done"
Write-Host "Service is installed and starting." -ForegroundColor Green
Write-Host "Health: http://localhost:$port/healthz" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Add users:    .\scripts\add-user.ps1"
Write-Host "  2. List users:   .\scripts\list-users.ps1"
Write-Host "  3. Revoke users: .\scripts\revoke-user.ps1"
Write-Host ""
Write-Host "Service management:"
Write-Host "  Stop:        Get-Service GoldmanSimproMCP | Stop-Service"
Write-Host "  Start:       Get-Service GoldmanSimproMCP | Start-Service"
Write-Host "  Uninstall:   node scripts\service-control.js uninstall   (from elevated PS)"
Write-Host "  Logs:        Event Viewer -> Windows Logs -> Application -> source 'GoldmanSimproMCP'"
