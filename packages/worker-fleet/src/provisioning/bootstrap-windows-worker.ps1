# Bootstrap a freshly-installed Windows box into an NVDA capture worker.
#
# Run this ONCE, in the VM, in an elevated PowerShell, right after Windows setup:
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   irm https://raw.githubusercontent.com/DanBeckDev/a11y-witness/main/scripts/bootstrap-windows-worker.ps1 | iex
#
# ...or, if you already have the repo, just run this file. It installs the
# prerequisites, makes the box reachable over SSH, clones the repo, and then hands
# off to provision-nvda-worker.ps1 (which does the NVDA/OS configuration and is the
# tested part of this pair).
#
# STATUS: the individual steps are the ones we ran by hand to build the existing
# worker, but this script has NOT yet been run end-to-end on a fresh Windows install.
# Expect to babysit it the first time; fix and commit what it gets wrong.
#
# Style constraints match the other scripts: `#` line comments and env-var config, no
# `<# #>` block comment and no param() block -- see scripts/diagnose-nvda-worker.ps1.
#   A11Y_REPO_URL   (default the public GitHub repo)
#   A11Y_REPO_PATH  (default %USERPROFILE%\a11y-witness)

$ErrorActionPreference = 'Stop'

$RepoUrl  = if ($env:A11Y_REPO_URL) { $env:A11Y_REPO_URL } else { 'https://github.com/DanBeckDev/a11y-witness.git' }
$RepoPath = if ($env:A11Y_REPO_PATH) { $env:A11Y_REPO_PATH } else { Join-Path $env:USERPROFILE 'a11y-witness' }

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function OK($msg)       { Write-Host "    OK    $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "    WARN  $msg" -ForegroundColor Yellow }

# Same rationale as provision-nvda-worker.ps1: native tools write to stderr as a
# matter of course, and with $ErrorActionPreference='Stop' PowerShell turns any
# stderr line into a terminating error. Gate on the exit code instead.
function Invoke-Native($exe, [string[]] $cmdArgs, [string] $what, [int] $tail = 4) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out  = & $exe @cmdArgs 2>&1
    $code = $LASTEXITCODE
    $out | Select-Object -Last $tail | ForEach-Object { Write-Host "      $_" }
    if ($code -ne 0) { throw "$what failed (exit $code)." }
  } finally { $ErrorActionPreference = $prev }
}

Step 1 'Check elevation'
$elevated = (New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $elevated) { throw 'Run this in an ELEVATED PowerShell (needed for SSH + firewall + policy steps).' }
OK 'elevated'

Step 2 'Install Node.js and Git (direct download, no winget)'
# Do NOT use winget here. On a freshly installed Windows it does not exist: winget ships
# as the "App Installer" Store package, which is not registered on a brand-new image, so
# the call fails with "'winget' is not recognized" and the whole bootstrap dies. Fetching
# the official archives directly has no Store dependency and no installer UI to hang on.
#
# Archives rather than MSIs on purpose: Node's current LTS line publishes
# win-arm64-zip but NO arm64 .msi, so the zip is the only version-agnostic choice.
$ProgressPreference = 'SilentlyContinue'   # or Invoke-WebRequest crawls

function Get-Archive($url, $outFile) {
  Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
  if (-not (Test-Path $outFile)) { throw "download failed: $url" }
}

$tmp = Join-Path $env:TEMP 'a11y-bootstrap'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

if (Get-Command node -ErrorAction SilentlyContinue) { OK "node already present ($(& node --version))" }
else {
  $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $rel = $idx | Where-Object { $_.lts -and $_.files -contains 'win-arm64-zip' } | Select-Object -First 1
  if (-not $rel) { throw 'no Node LTS with a win-arm64 build found' }
  $zip = Join-Path $tmp 'node.zip'
  Get-Archive "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-win-arm64.zip" $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory -Filter 'node-*-win-arm64' | Select-Object -First 1
  $dest = Join-Path $env:ProgramFiles 'nodejs'
  # run-server.cmd looks for "%ProgramFiles%\nodejs\node.exe" first, so install there.
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item $src.FullName $dest
  OK "node installed to $dest ($($rel.version))"
}

if (Get-Command git -ErrorAction SilentlyContinue) { OK "git already present" }
else {
  # MinGit is the portable Git build: a zip, no installer, which is all we need to clone.
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
  $asset = $rel.assets | Where-Object { $_.name -match '^MinGit-.*-arm64\.zip$' } | Select-Object -First 1
  if (-not $asset) { throw 'no MinGit arm64 asset found' }
  $zip = Join-Path $tmp 'mingit.zip'
  Get-Archive $asset.browser_download_url $zip
  $dest = Join-Path $env:ProgramFiles 'MinGit'
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  OK "git installed to $dest ($($asset.name))"
}

# Put both on the MACHINE path so the scheduled task's session sees them too, then
# refresh this process so the rest of the bootstrap can use them immediately.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
foreach ($p in @((Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $env:ProgramFiles 'MinGit\cmd'))) {
  if ($machinePath -notlike "*$p*") { $machinePath = "$machinePath;$p" }
}
[Environment]::SetEnvironmentVariable('Path', $machinePath, 'Machine')
$env:Path = $machinePath + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
OK "node $(& node --version 2>&1), git $(& git --version 2>&1)"

Step 3 'Install the OpenSSH server (best effort)'
# Best effort on purpose: the worker is driven over HTTP on 8765, and on a local VM the
# UTM guest agent (`utmctl exec` / `utmctl file pull`) is a perfectly good control
# channel. SSH is a convenience, so a failure here must not abort provisioning.
#
# Deliberately NOT Add-WindowsCapability: that route can stall indefinitely on Windows
# Update (documented in src/capture/nvda/README.md). Use the Win32-OpenSSH release.
try {
  if (Get-Service sshd -ErrorAction SilentlyContinue) { OK 'sshd already present' }
  else {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest' -UseBasicParsing
    $asset = $rel.assets | Where-Object { $_.name -match '^OpenSSH-ARM64.*\.msi$' } | Select-Object -First 1
    if (-not $asset) { throw 'no OpenSSH ARM64 msi asset found' }
    $msi = Join-Path $tmp 'openssh.msi'
    Get-Archive $asset.browser_download_url $msi
    Invoke-Native 'msiexec.exe' @('/i', $msi, '/qn', '/norestart') 'OpenSSH msi' 2
  }
  Set-Service -Name sshd -StartupType Automatic
  Start-Service sshd
  if (-not (Get-NetFirewallRule -Name 'sshd-a11y' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'sshd-a11y' -DisplayName 'OpenSSH Server (a11y-witness)' `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  OK "sshd $((Get-Service sshd).Status), port 22 allowed"
} catch {
  Warn "OpenSSH setup failed ($($_.Exception.Message)). Continuing -- the worker does not need it."
}

Step 4 'Clone the repo'
if (Test-Path (Join-Path $RepoPath '.git')) {
  OK "already cloned at $RepoPath"
} else {
  Invoke-Native 'git' @('clone', $RepoUrl, $RepoPath) 'git clone' 2
  OK "cloned to $RepoPath"
}

Step 5 'Hand off to the provisioning script'
$provision = Join-Path $RepoPath 'scripts\provision-nvda-worker.ps1'
if (-not (Test-Path $provision)) { throw "Not found: $provision" }
$env:A11Y_REPO_PATH = $RepoPath
& powershell -NoProfile -ExecutionPolicy Bypass -File $provision
if ($LASTEXITCODE -ne 0) { throw "Provisioning failed (exit $LASTEXITCODE)." }

# A fresh install needs ONE reboot before it can capture. Observed on two independent
# clean builds: provisioning completes, /health answers, NVDA connects -- and every read
# comes back empty (0 phrases, no error). After a single reboot, capture works.
#
# It is NOT ForegroundLockTimeout: that is applied live via SystemParametersInfo by both
# provisioning and run-server.cmd, and the logs confirm 0 in the session that still failed.
# The remaining cause is something about the first-logon session (guest-tools drivers
# settling, or first-logon shell state holding the foreground) and is not yet pinned down.
# The remedy is reliable and reproducible, so take it: auto-logon plus the at-logon trigger
# bring the worker back on their own, ~65s later.
Step 6 'Reboot to finish (a fresh install cannot capture until it has restarted once)'
OK 'rebooting now; the worker restarts itself via auto-logon + the at-logon task'
Start-Process -FilePath 'shutdown.exe' -ArgumentList '/r','/t','5' -NoNewWindow

Write-Host @"

--- Bootstrap complete ---

Reach it from your Mac:

  ssh-copy-id is not on Windows; append your public key to:
      C:\Users\$env:USERNAME\.ssh\authorized_keys
  (for an ADMIN account Windows uses C:\ProgramData\ssh\administrators_authorized_keys
   instead -- a very common reason key auth silently fails on Windows)

  Then, from the Mac:
      A11Y_WORKER=http://<vm-ip>:8765 npm run witness -- https://example.com --task "..."

Remaining manual step: auto-logon, so the interactive session survives a reboot.
provision-nvda-worker.ps1 prints the exact command; it needs a password, so it is
deliberately not automated here.
"@
