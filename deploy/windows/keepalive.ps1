# Keeps the local API + Cloudflare quick tunnel alive on this Windows machine.
# A quick tunnel gets a new random URL whenever it restarts, so the script also
# re-points and redeploys the static frontend. Run it from Task Scheduler every
# 2 minutes. The local public/index.html always ends up with data-api-base="".
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

$log           = Join-Path $env:TEMP 'caer-keepalive.log'
$lock          = Join-Path $env:TEMP 'caer-keepalive.lock'
$serverPidFile = Join-Path $env:TEMP 'caer-tunnel-server.pid'
$tunnelPidFile = Join-Path $env:TEMP 'caer-tunnel.pid'
$urlFile       = Join-Path $env:TEMP 'caer-tunnel-url.txt'
$deployedFile  = Join-Path $env:TEMP 'caer-deployed-url.txt'
$serverOut     = Join-Path $env:TEMP 'caer-server.out.log'
$serverErr     = Join-Path $env:TEMP 'caer-server.err.log'
$tunnelOut     = Join-Path $env:TEMP 'caer-tunnel.out.log'
$tunnelErr     = Join-Path $env:TEMP 'caer-tunnel.err.log'
$cf            = Join-Path $env:TEMP 'cloudflared.exe'
$index         = Join-Path $root 'public\index.html'
$frontend      = 'https://cloud-android-emulator.legderdeskonline.workers.dev'

function Log([string]$message) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
}

if (Test-Path $lock) {
  if (((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 10) {
    Log 'Another run is in progress; skipping.'
    exit 0
  }
}
Set-Content -Path $lock -Value (Get-Date -Format o)

try {
  # Local API server.
  $serverId = Get-Content $serverPidFile -ErrorAction SilentlyContinue
  $serverAlive = $serverId -and (Get-Process -Id $serverId -ErrorAction SilentlyContinue)
  $localOk = $false
  if ($serverAlive) {
    $localOk = (curl.exe -s -o NUL -w '%{http_code}' --max-time 5 'http://localhost:3000/api/health') -eq '200'
  }
  if (-not $localOk) {
    Log 'Starting local API server.'
    if ($serverAlive) { Stop-Process -Id $serverId -Force -ErrorAction SilentlyContinue }
    $env:CORS_ORIGIN = $frontend
    $process = Start-Process -FilePath 'node' -ArgumentList 'server/server.js' -WorkingDirectory $root -PassThru -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -WindowStyle Hidden
    $process.Id | Set-Content $serverPidFile
    Start-Sleep -Seconds 3
  }

  # Cloudflare quick tunnel.
  $tunnelId = Get-Content $tunnelPidFile -ErrorAction SilentlyContinue
  $tunnelAlive = $tunnelId -and (Get-Process -Id $tunnelId -ErrorAction SilentlyContinue)
  $url = Get-Content $urlFile -ErrorAction SilentlyContinue
  $healthy = $false
  if ($tunnelAlive -and $url) {
    $healthy = (curl.exe -s -o NUL -w '%{http_code}' --max-time 15 "$url/api/health") -eq '200'
  }
  if (-not $healthy) {
    Log 'Starting a new Cloudflare tunnel.'
    if ($tunnelAlive) { Stop-Process -Id $tunnelId -Force -ErrorAction SilentlyContinue }
    Remove-Item $tunnelOut, $tunnelErr, $urlFile -ErrorAction SilentlyContinue
    $tunnel = Start-Process -FilePath $cf -ArgumentList @('tunnel', '--url', 'http://localhost:3000', '--no-autoupdate') -PassThru -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelErr -WindowStyle Hidden
    $tunnel.Id | Set-Content $tunnelPidFile
    $url = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      Start-Sleep -Seconds 2
      $match = Select-String -Path $tunnelErr -Pattern 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($match) { $url = $match.Matches[0].Value; break }
    }
    if (-not $url) { throw 'Could not discover the tunnel URL.' }
    $url | Set-Content $urlFile
    Log "Tunnel URL: $url"
  }

  # Re-point the deployed frontend only when the URL changed.
  $deployedUrl = Get-Content $deployedFile -ErrorAction SilentlyContinue
  if ($deployedUrl -ne $url) {
    $cleanHtml = [regex]::Replace([System.IO.File]::ReadAllText($index), 'data-api-base="[^"]*"', 'data-api-base=""')
    $patchedHtml = [regex]::Replace($cleanHtml, 'data-api-base=""', "data-api-base=`"$url`"")
    Log "Re-pointing frontend to $url."
    try {
      [System.IO.File]::WriteAllText($index, $patchedHtml)
      & node (Join-Path $root 'node_modules\wrangler\bin\wrangler.js') deploy 2>&1 | ForEach-Object { Log $_ }
      $url | Set-Content $deployedFile
      Log 'Frontend redeployed.'
    } finally {
      [System.IO.File]::WriteAllText($index, $cleanHtml)
    }
  }

  $status = curl.exe -s -o NUL -w '%{http_code}' --max-time 15 "$url/api/health"
  Log "Done. Health: $status"
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
} finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
}
