# List users registered in tokens.json. Does NOT print Simpro API keys
# or the bearer tokens themselves — only metadata.

$ErrorActionPreference = "Stop"
$tokensPath = if ($env:SIMPRO_TOKENS_FILE) { $env:SIMPRO_TOKENS_FILE } else { Join-Path $PSScriptRoot "..\tokens.json" }
$tokensPath = [System.IO.Path]::GetFullPath($tokensPath)

if (-not (Test-Path $tokensPath)) {
  Write-Host "No tokens file at $tokensPath. Run scripts\add-user.ps1 first."
  exit 0
}
$store = Get-Content $tokensPath -Raw | ConvertFrom-Json

Write-Host ""
Write-Host "Tokens file: $tokensPath" -ForegroundColor Cyan
Write-Host ""

$rows = @()
foreach ($p in $store.tokens.PSObject.Properties) {
  $tok = $p.Name
  $r = $p.Value
  $masked = $tok.Substring(0,9) + "..." + $tok.Substring($tok.Length - 4)
  $rows += [PSCustomObject]@{
    Token      = $masked
    Name       = $r.name
    Companies  = ($r.companyAccess -join ',')
    Writes     = if ($r.writeEnabled) { "yes" } else { "no" }
    Created    = $r.createdAt
    LastUsed   = if ($r.lastUsedAt) { $r.lastUsedAt } else { "(never)" }
  }
}
if ($rows.Count -eq 0) {
  Write-Host "(no users registered)"
} else {
  $rows | Format-Table -AutoSize
  Write-Host ""
  Write-Host "$($rows.Count) user(s) registered."
}
