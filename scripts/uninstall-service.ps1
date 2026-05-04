# Uninstall the Goldman Simpro MCP Windows service.
# Run from an ELEVATED PowerShell (Run as Administrator).

$ErrorActionPreference = "Stop"

$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$p  = New-Object System.Security.Principal.WindowsPrincipal($id)
if (-not $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must run from an elevated PowerShell." -ForegroundColor Red
  exit 1
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Write-Host "Stopping and uninstalling GoldmanSimproMCP service..."
& node "$root\scripts\service-control.js" uninstall

# Optional: also remove the firewall rule
$rules = Get-NetFirewallRule -DisplayName "Goldman Simpro MCP*" -ErrorAction SilentlyContinue
foreach ($r in $rules) {
  Write-Host "Removing firewall rule: $($r.DisplayName)"
  Remove-NetFirewallRule -DisplayName $r.DisplayName
}

# Optional: clear system env vars (kept by default in case admin re-installs)
$keepEnv = (Read-Host "Also remove SIMPRO_* system environment variables? [y/N]").Trim().ToLower()
if ($keepEnv -eq "y" -or $keepEnv -eq "yes") {
  foreach ($n in "SIMPRO_TRANSPORT","SIMPRO_BASE_URL","SIMPRO_COMPANY_ID","SIMPRO_HTTP_HOST","SIMPRO_HTTP_PORT","SIMPRO_TOKENS_FILE","SIMPRO_AUDIT_FILE","SIMPRO_DRY_RUN") {
    [System.Environment]::SetEnvironmentVariable($n, $null, [System.EnvironmentVariableTarget]::Machine)
  }
  Write-Host "Cleared SIMPRO_* env vars." -ForegroundColor Green
}

Write-Host "Done." -ForegroundColor Green
