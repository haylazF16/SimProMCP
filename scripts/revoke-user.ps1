# Revoke a user's bearer token. Looks them up by name (case-insensitive
# substring) and removes the matching record from tokens.json.

$ErrorActionPreference = "Stop"
$tokensPath = if ($env:SIMPRO_TOKENS_FILE) { $env:SIMPRO_TOKENS_FILE } else { Join-Path $PSScriptRoot "..\tokens.json" }
$tokensPath = [System.IO.Path]::GetFullPath($tokensPath)

if (-not (Test-Path $tokensPath)) {
  Write-Host "No tokens file at $tokensPath."
  exit 1
}

$store = Get-Content $tokensPath -Raw | ConvertFrom-Json
$query = (Read-Host "Whose access do you want to revoke? (name substring)").Trim()
if (-not $query) { Write-Host "Empty query, aborted."; exit 1 }

$matches = @()
foreach ($p in $store.tokens.PSObject.Properties) {
  if ($p.Value.name -and ($p.Value.name -ilike "*$query*")) {
    $matches += [PSCustomObject]@{
      Token = $p.Name
      Name  = $p.Value.name
      Companies = ($p.Value.companyAccess -join ',')
    }
  }
}
if ($matches.Count -eq 0) {
  Write-Host "No user matches '$query'."
  exit 1
}
Write-Host ""
$i = 0
foreach ($m in $matches) {
  $i += 1
  $masked = $m.Token.Substring(0,9) + "..." + $m.Token.Substring($m.Token.Length - 4)
  Write-Host "  [$i] $($m.Name)  ($($m.Companies))  token=$masked"
}
Write-Host ""
$pick = (Read-Host "Pick a number to revoke (or blank to cancel)").Trim()
if (-not $pick) { Write-Host "Cancelled."; exit 0 }
$idx = [int]$pick - 1
if ($idx -lt 0 -or $idx -ge $matches.Count) { Write-Host "Out of range."; exit 1 }
$target = $matches[$idx]

$confirm = (Read-Host "Type the user's name to confirm revocation").Trim()
if ($confirm -ne $target.Name) { Write-Host "Name mismatch, cancelled."; exit 1 }

$store.tokens.PSObject.Properties.Remove($target.Token)

$tmp = "$tokensPath.tmp"
$store | ConvertTo-Json -Depth 8 | Set-Content -Path $tmp -Encoding UTF8
Move-Item -Force $tmp $tokensPath

Write-Host ""
Write-Host "Revoked $($target.Name). Their token will be rejected on the next request." -ForegroundColor Green
Write-Host "Tip: also delete that user's API key in Simpro for full access removal." -ForegroundColor Yellow
