<#
.SYNOPSIS
  Release Nullnetwork Diagnostics: deploy the worker, build the installer, publish it
  to the update feed (R2 releases/) and, when gh is logged in, to a GitHub release.

.USAGE
  From the repo root:
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -InitSecrets   # first deploy only
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1                # every release (bump version first)

  Flags:
    -InitSecrets   generate + store DEVICE_MASTER_KEY and IP_SALT (re-running rotates them;
                   every install then re-registers silently)
    -SkipWorker    don't redeploy the worker
    -SkipBuild     publish what is already in dist\
    -NoGitHub      skip the GitHub release

  The endpoint the app talks to is app.config.json -> shareEndpoint (and
  package.json -> build.publish.url for the updater metadata). Change those by hand
  if the worker moves.

  Needs: node 20+, `npm install` done in the repo root and in worker\, wrangler logged in
  (`npx wrangler login` inside worker\), and CLOUDFLARE_ACCOUNT_ID set if the login
  has access to more than one account.
#>
param([switch]$InitSecrets, [switch]$SkipWorker, [switch]$SkipBuild, [switch]$NoGitHub)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $root 'worker'
$wrangler = Join-Path $worker 'node_modules\wrangler\bin\wrangler.js'
if (-not (Test-Path $wrangler)) { throw "run npm install inside worker\ first" }
function W { param([string[]]$a) & node $wrangler @a; if ($LASTEXITCODE -ne 0) { throw "wrangler $($a -join ' ') failed" } }
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
# PowerShell 5.1 turns native stderr into terminating errors when redirected, so wrangler
# calls below never use 2>&1.

$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$cfg = Get-Content (Join-Path $root 'app.config.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$endpoint = $cfg.shareEndpoint.TrimEnd('/')
if (-not $endpoint) { throw 'app.config.json has no shareEndpoint' }
Write-Host "release v$version -> $endpoint"

if (-not $SkipWorker) {
  Push-Location $worker
  try {
    Step 'Worker: bucket'
    $buckets = & node $wrangler r2 bucket list | Out-String
    if ($buckets -notmatch 'nullnetwork-diagnostics') { W @('r2','bucket','create','nullnetwork-diagnostics') } else { Write-Host 'bucket exists' }
    if ($InitSecrets) {
      Step 'Worker: secrets'
      $k1 = & node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
      $k2 = & node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
      $k1 | & node $wrangler secret put DEVICE_MASTER_KEY; if ($LASTEXITCODE -ne 0) { throw 'secret put DEVICE_MASTER_KEY failed' }
      $k2 | & node $wrangler secret put IP_SALT;           if ($LASTEXITCODE -ne 0) { throw 'secret put IP_SALT failed' }
    }
    Step 'Worker: deploy'
    W @('deploy')
  } finally { Pop-Location }
}

if (-not $SkipBuild) {
  Step 'App: build installer'
  Push-Location $root
  try { & npm run dist; if ($LASTEXITCODE -ne 0) { throw 'npm run dist failed' } } finally { Pop-Location }
}

Step 'Publish to the update feed (releases/)'
$dist = Join-Path $root 'dist'
$yml = Join-Path $dist 'latest.yml'
if (-not (Test-Path $yml)) { throw 'dist\latest.yml missing - did the build run?' }
$exe = Get-ChildItem $dist -File | Where-Object { $_.Name -match "Setup-$([regex]::Escape($version))\.exe$" } | Select-Object -First 1
if (-not $exe) { throw "no installer for v$version in dist\" }
Push-Location $worker
try {
  foreach ($f in @($exe.FullName, $yml)) {
    Write-Host "  uploading $(Split-Path $f -Leaf)"
    W @('r2','object','put',"nullnetwork-diagnostics/releases/$(Split-Path $f -Leaf)",'--file',$f,'--remote')
  }
} finally { Pop-Location }

if (-not $NoGitHub) {
  Step 'GitHub release'
  $ghOk = $false
  try { & gh auth status *> $null; $ghOk = ($LASTEXITCODE -eq 0) } catch { $ghOk = $false }
  if ($ghOk) {
    Push-Location $root
    try {
      $exists = $false
      try { & gh release view "v$version" *> $null; $exists = ($LASTEXITCODE -eq 0) } catch {}
      if ($exists) { & gh release upload "v$version" $exe.FullName $yml --clobber }
      else { & gh release create "v$version" $exe.FullName $yml --title "v$version" --notes "Nullnetwork Diagnostics v$version. Installer SHA-512 is in latest.yml; the same file is served at $endpoint/v1/update/latest.yml." }
      if ($LASTEXITCODE -ne 0) { Write-Host 'GitHub release failed (feed is published regardless)' -ForegroundColor Yellow }
    } finally { Pop-Location }
  } else { Write-Host 'gh not logged in - skipping GitHub release (run: gh auth login)' -ForegroundColor Yellow }
}

Step 'Verify'
$h = Invoke-WebRequest -UseBasicParsing "$endpoint/health"; Write-Host "health: $($h.StatusCode)"
$y = Invoke-WebRequest -UseBasicParsing "$endpoint/v1/update/latest.yml"; Write-Host "latest.yml: $($y.StatusCode) $((($y.Content -split "`n")[0]).Trim())"
$p = Invoke-WebRequest -UseBasicParsing "$endpoint/"; Write-Host "download page: $($p.StatusCode)"
try { Invoke-WebRequest -UseBasicParsing -Method POST "$endpoint/v1/capture" -ContentType 'application/json' -Body '{}' | Out-Null; Write-Host 'WARNING: unsigned capture was accepted' -ForegroundColor Red }
catch { Write-Host "unsigned capture rejected: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Green }
Write-Host "`nDone: $($exe.FullName)" -ForegroundColor Green
