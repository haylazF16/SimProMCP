# Add a user to the Simpro MCP server's tokens.json.
#
# Usage:
#   .\scripts\add-user.ps1
# Walks you through name, Simpro API key, company access, write permission.
# Prints the new bearer token to give to the coworker.
#
# Re-running is safe; the script appends and never overwrites without prompting.

$ErrorActionPreference = "Stop"

$tokensPath = if ($env:SIMPRO_TOKENS_FILE) { $env:SIMPRO_TOKENS_FILE } else { Join-Path $PSScriptRoot "..\tokens.json" }
$tokensPath = [System.IO.Path]::GetFullPath($tokensPath)

function Read-NonEmpty($prompt) {
  while ($true) {
    $v = Read-Host $prompt
    if ($v -and $v.Trim()) { return $v.Trim() }
    Write-Host "  (cannot be empty)" -ForegroundColor Yellow
  }
}

function New-Token() {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $b64 = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  return "smcp_$b64"
}

# Load existing tokens
if (Test-Path $tokensPath) {
  $store = Get-Content $tokensPath -Raw | ConvertFrom-Json
  if (-not ($store.PSObject.Properties.Name -contains "tokens")) {
    $store | Add-Member -NotePropertyName tokens -NotePropertyValue ([PSCustomObject]@{})
  }
} else {
  $store = [PSCustomObject]@{ tokens = [PSCustomObject]@{} }
}

Write-Host ""
Write-Host "  Add a new Simpro MCP user" -ForegroundColor Green
Write-Host "  Tokens file: $tokensPath"
Write-Host ""

$name = Read-NonEmpty "Person's name (for audit log; e.g. 'Tayfun Yildirim')"
$simproKey = Read-NonEmpty "Their Simpro API key (the access token from Simpro System -> API Keys)"

Write-Host ""
Write-Host "Which Goldman company can this user access?"
Write-Host "  [1] Plumbing only"
Write-Host "  [2] Energy only"
Write-Host "  [3] Both"
$choice = ""
while ($choice -notin @("1","2","3")) {
  $choice = (Read-Host "Pick 1, 2 or 3 [3]").Trim()
  if (-not $choice) { $choice = "3" }
}
$companies = @()
if ($choice -in @("1","3")) { $companies += "plumbing" }
if ($choice -in @("2","3")) { $companies += "energy" }

Write-Host ""
$writeAns = (Read-Host "Allow this user to CREATE/UPDATE Simpro records? [y/N]").Trim().ToLower()
$writeEnabled = ($writeAns -eq "y" -or $writeAns -eq "yes")

$newToken = New-Token
$record = [PSCustomObject]@{
  name          = $name
  simproApiKey  = $simproKey
  companyAccess = $companies
  writeEnabled  = $writeEnabled
  createdAt     = (Get-Date -Format "o")
}

# Add to store
$store.tokens | Add-Member -NotePropertyName $newToken -NotePropertyValue $record -Force

# Atomic write
$tmp = "$tokensPath.tmp"
$store | ConvertTo-Json -Depth 8 | Set-Content -Path $tmp -Encoding UTF8
Move-Item -Force $tmp $tokensPath

Write-Host ""
Write-Host "==== User added ====" -ForegroundColor Green
Write-Host "  Name:         $name"
Write-Host "  Companies:    $($companies -join ', ')"
Write-Host "  Write tools:  $writeEnabled"
Write-Host ""
Write-Host "  Bearer token (give to user, then DO NOT keep this on screen):" -ForegroundColor Yellow
Write-Host "  $newToken" -ForegroundColor Cyan
Write-Host ""
Write-Host "How they connect (paste this into Claude Desktop -> Settings -> Connectors -> Add custom connector):"
Write-Host "  Plumbing URL: http://<server-ip>:$(if($env:SIMPRO_HTTP_PORT){$env:SIMPRO_HTTP_PORT}else{'3001'})/mcp/plumbing"
Write-Host "  Energy   URL: http://<server-ip>:$(if($env:SIMPRO_HTTP_PORT){$env:SIMPRO_HTTP_PORT}else{'3001'})/mcp/energy"
Write-Host "  Auth:         Bearer token = $newToken"
Write-Host ""
