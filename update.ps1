# Goldman Simpro MCP - updater
# Refreshes the locally-installed copy of the tool with the latest dist/.
# Does NOT touch your Claude config or your API key.
# Re-run this whenever a new version is published to the share folder.

$ErrorActionPreference = "Stop"

function Section($t) { Write-Host ""; Write-Host "==== $t ====" -ForegroundColor Cyan }

$source = $PSScriptRoot
$dest   = Join-Path $env:LOCALAPPDATA "GoldmanSimproMCP"

Write-Host ""
Write-Host "  Goldman Simpro -> Claude Desktop updater" -ForegroundColor Green

if (-not (Test-Path $dest)) {
  Write-Host "  No existing install found at $dest." -ForegroundColor Yellow
  Write-Host "  Run install.cmd first (not update.cmd) to do the initial setup."
  exit 1
}
if (-not (Test-Path (Join-Path $source "dist\index.js"))) {
  Write-Host "  ERROR: dist\index.js not found in this folder." -ForegroundColor Red
  Write-Host "  Make sure you're running update.cmd from the share folder."
  exit 1
}

Section "Refreshing tool files"
foreach ($item in @("dist", "node_modules", "package.json", "package-lock.json")) {
  $src = Join-Path $source $item
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $dest $item
  Write-Host "  Updating $item ..."
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
}

Section "Done"
Write-Host "Next: RIGHT-CLICK the Claude icon in your system tray -> QUIT," -ForegroundColor Green
Write-Host "wait 3 seconds, then reopen Claude Desktop. Your API key and"
Write-Host "settings are unchanged."
Write-Host ""
