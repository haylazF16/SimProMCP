# Goldman Simpro MCP - installer for end users
# ----------------------------------------------
# This script:
#   1. Checks Node.js is installed (else points to nodejs.org).
#   2. Copies the compiled tool from the share folder to a stable local
#      path (%LOCALAPPDATA%\GoldmanSimproMCP) - avoids OneDrive sync
#      issues and the need for admin rights.
#   3. Prompts for the user's Simpro API key (paste once).
#   4. Asks which Goldman companies they want available (Plumbing /
#      Energy / both).
#   5. Merges the simpro_plumbing / simpro_energy entries into
#      %APPDATA%\Claude\claude_desktop_config.json without disturbing
#      anything else that's already there.
#
# Re-running the script is safe - it overwrites only the simpro_*
# entries and refreshes the local copy of the tool.

$ErrorActionPreference = "Stop"

function Write-Section($title) {
  Write-Host ""
  Write-Host "==== $title ====" -ForegroundColor Cyan
}

function Read-NonEmpty($prompt) {
  while ($true) {
    $val = Read-Host $prompt
    if ($val -and $val.Trim()) { return $val.Trim() }
    Write-Host "  (cannot be empty, please try again)" -ForegroundColor Yellow
  }
}

function Read-YesNo($prompt, [bool]$default = $true) {
  $hint = if ($default) { "[Y/n]" } else { "[y/N]" }
  while ($true) {
    $resp = (Read-Host "$prompt $hint").Trim().ToLower()
    if (-not $resp) { return $default }
    if ($resp -eq "y" -or $resp -eq "yes") { return $true }
    if ($resp -eq "n" -or $resp -eq "no")  { return $false }
  }
}

# ----- Banner -----
Write-Host ""
Write-Host "  Goldman Simpro -> Claude Desktop installer" -ForegroundColor Green
Write-Host "  -------------------------------------------" -ForegroundColor Green
Write-Host "  This will set up Claude Desktop to talk to Simpro on this PC."
Write-Host "  Takes about 2 minutes. You'll need your Simpro API key handy."

# ----- Step 1: Node.js -----
Write-Section "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is not installed (or not on your PATH)." -ForegroundColor Yellow
  Write-Host "Please:"
  Write-Host "  1. Go to https://nodejs.org"
  Write-Host "  2. Download the LTS .msi installer (left-hand green button)."
  Write-Host "  3. Run the installer (Next, Next, Install, defaults are fine)."
  Write-Host "  4. RESTART your PC."
  Write-Host "  5. Run install.cmd again."
  Write-Host ""
  Write-Host "Opening nodejs.org for you now..." -ForegroundColor Cyan
  Start-Process "https://nodejs.org"
  exit 1
}
$nodeVer = (& node --version) -replace '^v',''
$major = [int]($nodeVer.Split('.')[0])
if ($major -lt 18) {
  Write-Host "Node.js $nodeVer is too old. This tool needs v18.17 or newer." -ForegroundColor Yellow
  Write-Host "Please update Node.js from https://nodejs.org and re-run."
  exit 1
}
Write-Host "  Node.js v$nodeVer detected. OK." -ForegroundColor Green

# ----- Step 2: copy tool to stable local path -----
Write-Section "Installing the Simpro tool to your PC"
$source = $PSScriptRoot
$dest   = Join-Path $env:LOCALAPPDATA "GoldmanSimproMCP"
$indexJs = Join-Path $dest "dist\index.js"

if (-not (Test-Path (Join-Path $source "dist\index.js"))) {
  Write-Host "ERROR: Cannot find dist\index.js in this folder." -ForegroundColor Red
  Write-Host "Source: $source"
  Write-Host "Make sure you copied the WHOLE share folder, not just install.cmd."
  exit 1
}

Write-Host "  Source: $source"
Write-Host "  Target: $dest"
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }

# Copy dist/ + node_modules/ + package*.json. Skip docs and source files.
$copyItems = @("dist", "node_modules", "package.json", "package-lock.json")
foreach ($item in $copyItems) {
  $src = Join-Path $source $item
  if (-not (Test-Path $src)) {
    if ($item -eq "node_modules") {
      Write-Host "  WARNING: node_modules not found in share folder." -ForegroundColor Yellow
      Write-Host "  Will run 'npm install' instead (one-time, ~30 seconds)."
      Push-Location $dest
      try { & npm install --omit=dev --silent } finally { Pop-Location }
      continue
    }
    Write-Host "  Missing required item: $item" -ForegroundColor Red
    exit 1
  }
  $dst = Join-Path $dest $item
  Write-Host "  Copying $item ..."
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
}
Write-Host "  Tool installed to $dest" -ForegroundColor Green

# ----- Step 3: API key -----
Write-Section "Your Simpro API key"
Write-Host "Paste the access token you generated in Simpro (System -> Setup ->"
Write-Host "System -> API Keys). It looks like a long string of letters and"
Write-Host "numbers. Don't worry, it won't be shown back to you."
$apiKey = Read-NonEmpty "Simpro API key"
if ($apiKey.Length -lt 16) {
  Write-Host "  That looks too short to be a real Simpro API key. Continuing anyway." -ForegroundColor Yellow
}

# ----- Step 4: which companies -----
Write-Section "Which Goldman company will you use?"
Write-Host "  [1] Goldman Plumbing Services only"
Write-Host "  [2] Goldman Energy only"
Write-Host "  [3] Both (recommended)"
$choice = ""
while ($choice -notin @("1","2","3")) {
  $choice = (Read-Host "Pick 1, 2 or 3").Trim()
  if (-not $choice) { $choice = "3" }  # default
}
$wantPlumbing = $choice -in @("1","3")
$wantEnergy   = $choice -in @("2","3")

# ----- Step 5: write Claude Desktop config -----
Write-Section "Configuring Claude Desktop"
$claudeDir  = Join-Path $env:APPDATA "Claude"
$claudeConf = Join-Path $claudeDir "claude_desktop_config.json"
if (-not (Test-Path $claudeDir)) {
  New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
}

$config = $null
if (Test-Path $claudeConf) {
  Write-Host "  Found existing config at $claudeConf - will merge new entries."
  try {
    $config = Get-Content $claudeConf -Raw | ConvertFrom-Json
  } catch {
    $backup = "$claudeConf.bak"
    Write-Host "  WARNING: existing config is not valid JSON. Backing up to $backup" -ForegroundColor Yellow
    Copy-Item $claudeConf $backup -Force
    $config = $null
  }
}
if ($null -eq $config) {
  $config = [PSCustomObject]@{}
}

# Ensure mcpServers exists (PSObject add-or-set helper)
function Set-OrAddProp($obj, $name, $value) {
  if ($obj.PSObject.Properties.Name -contains $name) {
    $obj.$name = $value
  } else {
    $obj | Add-Member -MemberType NoteProperty -Name $name -Value $value
  }
}

if (-not ($config.PSObject.Properties.Name -contains "mcpServers")) {
  Set-OrAddProp $config "mcpServers" ([PSCustomObject]@{})
}
$mcp = $config.mcpServers

# Remove any old single-name entry from earlier versions
if ($mcp.PSObject.Properties.Name -contains "simpro") {
  $mcp.PSObject.Properties.Remove("simpro")
}
# Always remove existing simpro_plumbing/simpro_energy so we don't duplicate
foreach ($n in @("simpro_plumbing","simpro_energy")) {
  if ($mcp.PSObject.Properties.Name -contains $n) {
    $mcp.PSObject.Properties.Remove($n)
  }
}

function Build-Entry($companyId) {
  return [PSCustomObject]@{
    command = "node"
    args    = @($indexJs)
    env     = [PSCustomObject]@{
      SIMPRO_BASE_URL           = "https://goldmanplumbingservices.simprosuite.com"
      SIMPRO_API_KEY            = $apiKey
      SIMPRO_COMPANY_ID         = "$companyId"
      SIMPRO_ENABLE_WRITE_TOOLS = "false"
      SIMPRO_DRY_RUN            = "true"
    }
  }
}

if ($wantPlumbing) { Set-OrAddProp $mcp "simpro_plumbing" (Build-Entry 4) }
if ($wantEnergy)   { Set-OrAddProp $mcp "simpro_energy"   (Build-Entry 37) }

$json = $config | ConvertTo-Json -Depth 12
Set-Content -Path $claudeConf -Value $json -Encoding UTF8
Write-Host "  Wrote $claudeConf" -ForegroundColor Green

# ----- Step 6: done -----
Write-Section "All done"
Write-Host "Next steps:" -ForegroundColor Green
Write-Host "  1. RIGHT-CLICK the Claude icon in your system tray (bottom right,"
Write-Host "     near the clock) and click QUIT. Just closing the window is not"
Write-Host "     enough."
Write-Host "  2. Wait 3 seconds, then open Claude Desktop again from the Start menu."
Write-Host "  3. Click the small tools/hammer icon near the message box. You"
$expected = @()
if ($wantPlumbing) { $expected += "simpro_plumbing" }
if ($wantEnergy)   { $expected += "simpro_energy" }
Write-Host "     should see: $($expected -join ', ')"
Write-Host "  4. In the chat, try:"
if ($wantPlumbing) { Write-Host "        Use Simpro Plumbing to test the connection." -ForegroundColor White }
if ($wantEnergy)   { Write-Host "        Use Simpro Energy to test the connection."   -ForegroundColor White }
Write-Host ""
Write-Host "Writes are OFF by default - Claude can read Simpro but cannot"
Write-Host "modify anything. To enable writes later, see SETUP-GUIDE.md Part 6."
Write-Host ""
Write-Host "If you ever need to re-run this installer (e.g. to update your API"
Write-Host "key), just double-click install.cmd again - it's safe to re-run."
Write-Host ""
