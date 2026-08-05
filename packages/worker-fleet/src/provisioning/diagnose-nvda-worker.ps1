# Diagnose a broken NVDA capture worker. Read-only: changes nothing.
#
# Checks every layer in the order that failures actually cascade, and prints a
# VERDICT per layer rather than raw dumps, so the first FAIL is the thing to fix.
# Exits non-zero if any check failed. Copy it over and run it with -File:
#
#   scp scripts/diagnose-nvda-worker.ps1 user@host:C:/Users/user/
#   ssh user@host "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\user\diagnose-nvda-worker.ps1"
#
# Do NOT pipe this to `powershell -Command -`. That mode silently truncated this
# script mid-run (the summary and exit code never executed), and a leading `<# #>`
# block comment suppresses its output entirely. Reserve stdin piping for short
# ad-hoc snippets; use -File for anything real.
#
# Every check here corresponds to a real outage. The mapping from error text to
# cause is in docs/nvda-worker-runbook.md; this script applies it automatically.
#
# Config comes from the environment rather than param(), so the same file works in
# either invocation mode:
#   A11Y_REPO_PATH  (default %USERPROFILE%\a11y-witness)
#   A11Y_PORT       (default 8765)

$ErrorActionPreference = 'SilentlyContinue'

$RepoPath = if ($env:A11Y_REPO_PATH) { $env:A11Y_REPO_PATH } else { Join-Path $env:USERPROFILE 'a11y-witness' }
$Port     = if ($env:A11Y_PORT) { [int] $env:A11Y_PORT } else { 8765 }
$fails = @()

function Section($t) { Write-Host "`n== $t ==" -ForegroundColor Cyan }
function Pass($m)    { Write-Host "  PASS  $m" -ForegroundColor Green }
function Fail($m, $fix) {
  Write-Host "  FAIL  $m" -ForegroundColor Red
  Write-Host "        fix: $fix" -ForegroundColor Yellow
  $script:fails += $m
}
function Info($m)    { Write-Host "  info  $m" -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
Section 'Layer 1: interactive desktop session'
# Without a logged-on console session NVDA runs but announces NOTHING, and every
# capture comes back empty with no error -- the most confusing failure mode there is.
$sessions = query session 2>$null
Info (($sessions | Out-String).Trim())
if ($sessions | Select-String '^\s*>?\s*console\s+\S+\s+\d+\s+Active') {
  Pass 'console session Active'
} else {
  Fail 'no Active console session' 'log in at the VM console (not SSH); enable auto-logon so reboots recover'
}

# A modal dialog freezes the whole interactive session invisibly: captures return 0
# phrases even on a known-good page, with no error anywhere.
$dialogs = Get-Process | Where-Object { $_.MainWindowTitle -and $_.SessionId -ne 0 } |
  Select-Object Name, MainWindowTitle
if ($dialogs) { Info "windows on the desktop: $((($dialogs | ForEach-Object { "$($_.Name):$($_.MainWindowTitle)" }) -join ' | '))" }
if (Get-Process LogonUI) { Fail 'LogonUI is running: the desktop is LOCKED' 'unlock the console; disable the screensaver/lock' }
else { Pass 'desktop not locked' }

# ---------------------------------------------------------------------------
Section 'Layer 2: worker process and port'
$node = Get-Process node
if ($node) { Pass "node running (pid $($node.Id -join ','), session $($node.SessionId -join ','))" }
else { Fail 'no node process' "Start-ScheduledTask -TaskName a11ysrv" }

if (Get-NetTCPConnection -LocalPort $Port -State Listen) { Pass "listening on $Port" }
else { Fail "nothing listening on $Port" "Start-ScheduledTask -TaskName a11ysrv; then check $RepoPath\server.log" }

$task = Get-ScheduledTask -TaskName 'a11ysrv'
if ($task) {
  $trigCount = ($task.Triggers | Measure-Object).Count
  if ($task.Principal.LogonType -ne 'Interactive') {
    Fail "task LogonType is $($task.Principal.LogonType), not Interactive" 're-register with -LogonType Interactive, or NVDA gets no desktop'
  } else { Pass 'task LogonType Interactive' }
  if ($trigCount -eq 0) {
    Fail 'task has NO trigger: it will not restart after a reboot' 'add: Set-ScheduledTask -TaskName a11ysrv -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)'
  } else { Pass "task has $trigCount trigger(s)" }
} else { Fail 'scheduled task a11ysrv is not registered' 'run scripts/provision-nvda-worker.ps1' }

# ---------------------------------------------------------------------------
Section 'Layer 3: guidepup / NVDA version pairing'
$gpJson = Join-Path $RepoPath 'node_modules\@guidepup\guidepup\package.json'
if (Test-Path $gpJson) {
  $gp = (Get-Content $gpJson -Raw | ConvertFrom-Json).version
  Info "@guidepup/guidepup $gp"
  if ([version]($gp -replace '-.*$') -lt [version]'0.29.0') {
    Fail "guidepup $gp cannot drive NVDA 2026.x" 'bump to >=0.29.2; symptom is "NVDA not installed" thrown from NVDAClient.connect'
  } else { Pass "guidepup $gp speaks NVDA 2026 core Remote Access" }
} else { Fail '@guidepup/guidepup not installed' 'npm install' }

# ---------------------------------------------------------------------------
Section 'Layer 4: NVDA install integrity'
# guidepup >=0.29 resolves the install from this cache path, NOT the old
# HKCU\Software\Guidepup\Nvda registry pointer.
$cacheRoot = if ($env:GUIDEPUP_SCREEN_READERS_PATH) { $env:GUIDEPUP_SCREEN_READERS_PATH } else { Join-Path $env:LOCALAPPDATA 'guidepup' }
Info "cache root: $cacheRoot"
$nvdaExe = Get-ChildItem (Join-Path $cacheRoot 'nvda') -Recurse -Filter 'nvda.exe' |
  Sort-Object FullName -Descending | Select-Object -First 1

if (-not $nvdaExe) {
  Fail "no nvda.exe under $cacheRoot" 'run from the repo: npx @guidepup/setup install nvda  (symptom: "NVDA is not supported")'
} else {
  $dir = Split-Path $nvdaExe.FullName
  $count = (Get-ChildItem $dir -Recurse -File).Count
  $mb = [Math]::Round(((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
  Info "$dir -- $count files, $mb MB"
  # A stub install (temp cleanup deleted the payload) launches and dies instantly:
  # "Timed out waiting for NVDA to be running", and no nvda.log is ever written.
  if ($count -lt 500) {
    Fail "install looks GUTTED ($count files, expected ~1700+)" 'delete that directory and re-run npx @guidepup/setup install nvda'
  } else { Pass "install intact ($count files, $mb MB)" }
  foreach ($f in @('library.zip', 'nvda_slave.exe', 'nvda.exe')) {
    if (Test-Path (Join-Path $dir $f)) { Pass "  $f present" }
    else { Fail "  $f MISSING" 'the install is incomplete; reinstall NVDA' }
  }
  if (Test-Path (Join-Path $dir 'userConfig\remoteAccess\localRelay\NvdaRemoteRelay.pem')) {
    Pass '  Remote Access relay cert present (NVDA 2026 core)'
  } elseif (Test-Path (Join-Path $dir 'userConfig\addons\remote\globalPlugins\remoteClient\server.pem')) {
    Pass '  legacy NVDA Remote add-on cert present'
  } else {
    Fail '  no speech-channel certificate' 'reinstall NVDA; without it connect() throws "NVDA not installed"'
  }
  # The single most damaging silent misconfiguration: probes record the Speech
  # Viewer window instead of the page's response, and capture-check still passes.
  if (Get-ChildItem $dir -Recurse -Filter 'nvda.ini' | Select-String 'showSpeechViewerAtStartup = True') {
    Fail '  Speech Viewer is ENABLED: interaction probes will record "NVDA Speech Viewer"' 'set showSpeechViewerAtStartup = False in the install userConfig\nvda.ini'
  } else { Pass '  Speech Viewer disabled' }
}

# ---------------------------------------------------------------------------
Section 'Layer 5: focus and dialog hygiene'
$flt = (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ForegroundLockTimeout).ForegroundLockTimeout
if ($flt -eq 0) { Pass 'ForegroundLockTimeout = 0' } else { Fail "ForegroundLockTimeout = $flt" 'npx @guidepup/setup setup' }

$ss = (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive).ScreenSaveActive
if ($ss -eq '0') { Pass 'screensaver disabled' } else { Fail "screensaver enabled ($ss)" 'set ScreenSaveActive=0; it steals foreground mid-capture' }

$notify = (Get-NetFirewallProfile).NotifyOnListen | Sort-Object -Unique
if ($notify -contains 'True') { Fail "firewall NotifyOnListen is True ($($notify -join ','))" 'Set-NetFirewallProfile -Profile Domain,Private,Public -NotifyOnListen False -- the allow-app dialog is unclickable on a VM' }
else { Pass 'firewall NotifyOnListen False (no allow-app dialogs)' }

$edge = Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
if ($edge.HideFirstRunExperience -eq 1) { Pass 'Edge HideFirstRunExperience = 1' }
else { Fail 'Edge first-run experience not suppressed' 'set HKLM\SOFTWARE\Policies\Microsoft\Edge HideFirstRunExperience=1, BrowserSignin=0' }

# ---------------------------------------------------------------------------
Section 'Layer 6: last capture outcome'
$log = Join-Path $RepoPath 'server.log'
if (Test-Path $log) {
  Get-Content $log -Tail 12 | ForEach-Object { Info $_ }
  $body = Get-Content $log -Raw
  # Map the exact error strings to their real causes -- each of these was, at least
  # once, misread as something else.
  if ($body -match 'Timed out waiting for NVDA to be running') {
    Fail 'log: NVDA start timed out' 'NVDA install is gutted/stub (Layer 4), or no interactive desktop (Layer 1)'
  }
  if ($body -match 'NVDA not installed') {
    Fail 'log: "NVDA not installed"' 'MISLEADING: usually thrown by NVDAClient.connect when the speech-channel cert is missing or guidepup is too old (Layers 3-4), NOT a missing install'
  }
  if ($body -match 'NVDA is not supported') {
    Fail 'log: "NVDA is not supported"' 'guidepup resolved no install at its cache path (Layer 4): npx @guidepup/setup install nvda'
  }
  if ($body -match 'afterStart\.lastSpoken=""' -and $body -match '-> 0 phrases') {
    Fail 'log: 0 phrases and NVDA silent right after start' 'no interactive desktop, or a modal dialog is blocking the session (Layer 1)'
  }
} else { Info "no server.log at $log yet" }

# ---------------------------------------------------------------------------
Write-Host ''
if ($fails.Count -eq 0) {
  Write-Host 'ALL CHECKS PASSED -- if capture still fails, run a real capture and inspect' -ForegroundColor Green
  Write-Host 'diagnostics[].afterStart.lastSpoken plus interaction.formChanges in the response.' -ForegroundColor Green
} else {
  Write-Host "$($fails.Count) CHECK(S) FAILED -- fix the FIRST one; later failures are usually downstream." -ForegroundColor Red
  exit 1
}
