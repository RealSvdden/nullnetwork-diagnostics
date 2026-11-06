<#
.SYNOPSIS
  Release Nullnetwork Diagnostics: deploy the worker, build the installer, publish it
  to the update feed (R2 releases/) and, when gh is logged in, to a GitHub release.

.USAGE
  From the repo root:
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -InitSecrets   # first deploy only
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1                # every release (bump version first)

  Flags:
    -InitSecrets      create DEVICE_MASTER_KEY and IP_SALT when they do not exist yet. Never
                      overwrites: an existing secret is left alone (use the Rotate switches).
    -RotateMasterKey  replace DEVICE_MASTER_KEY: every install re-registers on its next share.
    -RotateIpSalt     replace IP_SALT: every stored IP hash stops matching, which lifts every
                      revoke block (diag_revoked_ips) and resets the per-network registration
                      counts. Rotate it only for that purpose, and separately from the key.
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
param([switch]$InitSecrets, [switch]$RotateMasterKey, [switch]$RotateIpSalt, [switch]$SkipWorker, [switch]$SkipBuild, [switch]$NoGitHub)
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
    if ($InitSecrets -or $RotateMasterKey -or $RotateIpSalt) {
      Step 'Worker: secrets'
      # The two secrets are rotated separately on purpose: a new IP_SALT silently lifts
      # every revoke block and resets registration counts, a new DEVICE_MASTER_KEY only
      # makes installs re-register. -InitSecrets never overwrites either.
      function PutSecret($name, $bytes) {
        $v = & node -e "console.log(require('crypto').randomBytes($bytes).toString('base64url'))"
        $v | & node $wrangler secret put $name; if ($LASTEXITCODE -ne 0) { throw "secret put $name failed" }
      }
      if ($InitSecrets) {
        $listed = & node $wrangler secret list --format json | Out-String
        $existing = @()
        try { $existing = @(($listed | ConvertFrom-Json) | ForEach-Object { $_.name }) } catch { throw "could not read the secret list (wrangler said: $listed); use -RotateMasterKey / -RotateIpSalt explicitly" }
        if ($existing -contains 'DEVICE_MASTER_KEY') { Write-Host 'DEVICE_MASTER_KEY exists - left alone (use -RotateMasterKey to replace it)' } else { PutSecret 'DEVICE_MASTER_KEY' 48 }
        if ($existing -contains 'IP_SALT') { Write-Host 'IP_SALT exists - left alone (use -RotateIpSalt to replace it)' } else { PutSecret 'IP_SALT' 32 }
      }
      if ($RotateMasterKey) {
        Write-Host 'Rotating DEVICE_MASTER_KEY: every install re-registers on its next share.' -ForegroundColor Yellow
        PutSecret 'DEVICE_MASTER_KEY' 48
      }
      if ($RotateIpSalt) {
        Write-Host 'Rotating IP_SALT: every stored IP hash stops matching. This LIFTS EVERY REVOKE BLOCK in diag_revoked_ips and resets the per-network registration counts.' -ForegroundColor Yellow
        PutSecret 'IP_SALT' 32
      }
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
