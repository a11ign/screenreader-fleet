# Bootstrap a freshly-installed Windows box into an NVDA capture worker.
#
# Run this ONCE, in the VM, in an elevated PowerShell, right after Windows setup:
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   irm https://raw.githubusercontent.com/DanBeckDev/a11y-witness/main/packages/worker-fleet/src/provisioning/bootstrap-windows-worker.ps1 | iex
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
# `<# #>` block comment and no param() block -- see diagnose-nvda-worker.ps1 beside this file.
#   A11Y_REPO_URL   (default the public GitHub repo)
#   A11Y_REPO_PATH  (default %USERPROFILE%\a11y-witness)
#
# Auto-logon needs NO configuration and NO password: provisioning gives the console account a
# blank password and points Winlogon at it. Nothing is stored, so there is nothing to distribute
# across a fleet. It requires a LOCAL account -- a Microsoft account cannot hold a blank password.

$ErrorActionPreference = 'Stop'

$RepoUrl  = if ($env:A11Y_REPO_URL) { $env:A11Y_REPO_URL } else { 'https://github.com/DanBeckDev/a11y-witness.git' }
$RepoPath = if ($env:A11Y_REPO_PATH) { $env:A11Y_REPO_PATH } else { Join-Path $env:USERPROFILE 'a11y-witness' }

# What each step did, so the end of a re-run says which steps were already good and which
# were retried. Without this the second run looks identical to the first and you cannot tell
# whether it fixed anything.
$script:outcomes = [ordered]@{}
function Record($name, $state) { $script:outcomes[$name] = $state }

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

# Which architecture to fetch binaries for. Every download below was hardcoded to arm64,
# because this script was written from the UTM guests on an Apple-silicon Mac -- so on an
# x64 box it downloaded ARM binaries that cannot execute, and the failure surfaces as
# "node is not recognized" AFTER a successful-looking install.
#
# `OSArchitecture`, not $env:PROCESSOR_ARCHITECTURE: the env var reports the *process*
# architecture, so an x64 PowerShell emulated on ARM64 Windows reports AMD64 and would
# install the wrong Node. OSArchitecture asks the OS.
#
# The three projects spell the same architecture three different ways, which is exactly
# the kind of thing that looks right in review and 404s at runtime -- so each mapping is
# named rather than derived.
function Get-OsArchitecture {
  # RuntimeInformation is the RIGHT answer and is NOT reliably available here. This script is
  # run via `irm | iex`, which means Windows PowerShell 5.1 on .NET Framework, where the
  # System.Runtime.InteropServices.RuntimeInformation assembly is not loaded by default -- so
  # the static property yields $null and `.ToString()` on it dies with "You cannot call a
  # method on a null-valued expression", an error that names neither the variable nor the
  # line. Try it, never depend on it.
  try {
    $ri = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($ri) { return $ri.ToString().ToLower() }
  } catch {
    # Type not resolvable on this runtime. Fall through to the environment.
  }
  # PROCESSOR_ARCHITEW6432 is set ONLY inside a 32-bit process on a 64-bit OS, and it carries
  # the OS architecture -- so reading it first is what makes this report the machine rather
  # than the process. Preserving that distinction is the entire reason for preferring
  # RuntimeInformation in the first place; the fallback must not quietly lose it.
  $pa = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($pa) {
    'AMD64' { return 'x64' }
    'ARM64' { return 'arm64' }
    'x86'   { return 'x86' }
    default { return "$pa".ToLower() }   # quoted: .ToLower() on a $null would repeat the bug
  }
}
$osArch = Get-OsArchitecture
if ($osArch -notin @('x64', 'arm64')) { throw "unsupported architecture '$osArch' (expected x64 or arm64)" }
$nodeArch    = $osArch                                              # node-vX-win-x64.zip   / -win-arm64.zip
$minGitArch  = if ($osArch -eq 'x64') { '64-bit' } else { 'arm64' } # MinGit-X-64-bit.zip   / -arm64.zip
$openSshArch = if ($osArch -eq 'x64') { 'Win64' }  else { 'ARM64' } # OpenSSH-Win64.msi     / OpenSSH-ARM64.msi
OK "architecture $osArch (node=$nodeArch, mingit=$minGitArch, openssh=$openSshArch)"

function Get-Archive($url, $outFile) {
  Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
  if (-not (Test-Path $outFile)) { throw "download failed: $url" }
}

$tmp = Join-Path $env:TEMP 'a11y-bootstrap'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# Check the INSTALL PATH, not just the command. `Get-Command node` consults this session's PATH,
# and a session that started before the machine PATH was updated -- or a fresh account's first
# logon -- does not have it, so a perfectly good install looks absent and gets reinstalled.
$nodeHome = Join-Path $env:ProgramFiles 'nodejs'
$nodeExe  = Join-Path $nodeHome 'node.exe'
if ((Get-Command node -ErrorAction SilentlyContinue) -or (Test-Path $nodeExe)) {
  OK "node already present ($(& $(if (Test-Path $nodeExe) { $nodeExe } else { 'node' }) --version))"
  # REPAIR the ACL even when we did not install it. An existing install may carry the permissions
  # of whichever account put it there -- see the Move-Item note below -- and a re-run that skips
  # the install would otherwise never fix a box that is already broken. Idempotent, so it costs
  # nothing to do every time, and it makes "run it again" a real remedy rather than a hope.
  if (Test-Path $nodeHome) {
    icacls $nodeHome /reset /T /C /Q | Out-Null
    Record 'node' 'already present (permissions reset)'
  } else {
    Record 'node' 'already present'
  }
}
else {
  Record 'node' 'installed'
  $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $rel = $idx | Where-Object { $_.lts -and $_.files -contains "win-$nodeArch-zip" } | Select-Object -First 1
  if (-not $rel) { throw "no Node LTS with a win-$nodeArch build found" }
  $zip = Join-Path $tmp 'node.zip'
  Get-Archive "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-win-$nodeArch.zip" $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory -Filter "node-*-win-$nodeArch" | Select-Object -First 1
  # Named, because `$src.FullName` on a $null gives the same useless "null-valued expression"
  # as the bug above. If Node ever changes its archive's top-level directory name, this must
  # say WHICH expectation broke.
  if (-not $src) { throw "expanded Node archive has no 'node-*-win-$nodeArch' directory under $tmp" }
  $dest = $nodeHome
  # run-server.cmd looks for "%ProgramFiles%\nodejs\node.exe" first, so install there.
  #
  # DELETE ONLY AFTER the replacement is in hand. This used to remove the existing install and
  # THEN move the new one in, so any failure between the two -- a bad download, a failed expand,
  # a half-written archive -- left the box with NO node at all. That is worse than the state it
  # started in, and it is silent: the next thing to notice is run-server.cmd's window opening and
  # closing in two seconds because `node` is not a recognised command.
  #
  # Verify the new tree actually contains node.exe before touching the old one, then swap.
  if (-not (Test-Path (Join-Path $src.FullName 'node.exe'))) {
    throw "expanded Node archive at $($src.FullName) has no node.exe -- refusing to replace a working install"
  }
  if (Test-Path $dest) {
    $old = "$dest.old-$PID"
    Rename-Item $dest $old -Force
    try {
      Move-Item $src.FullName $dest
      Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
      # Put it back rather than leaving the box with nothing.
      if (Test-Path $old) { Rename-Item $old $dest -Force }
      throw
    }
  } else {
    Move-Item $src.FullName $dest
  }

  # RESTORE INHERITED PERMISSIONS. Move-Item on the same volume PRESERVES the source ACL rather
  # than inheriting the destination's -- so a tree moved out of one account's %TEMP% into
  # C:\Program Files carries that account's permissions, and nobody else can execute it.
  #
  # Measured: node installed by the first (Microsoft) account, then run by the worker account's
  # UNELEVATED scheduled task -> "Access is denied", exit 5. Elevated shells worked throughout,
  # because an administrator bypasses the ACL -- which is exactly why every manual test passed and
  # only the task failed.
  icacls $dest /reset /T /C /Q | Out-Null
  OK "permissions on $dest reset to inherit (a Move-Item keeps the SOURCE acl)"

  OK "node installed to $dest ($($rel.version))"
}

if (Get-Command git -ErrorAction SilentlyContinue) { OK "git already present"; Record 'git' 'already present' }
else {
  Record 'git' 'installed'
  # MinGit is the portable Git build: a zip, no installer, which is all we need to clone.
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
  # `[0-9.]+` rather than `.*` between the name and the architecture. Git for Windows also
  # ships MinGit-<ver>-busybox-64-bit.zip, which a `.*` matches just as happily -- so the
  # build you got would depend on GitHub's asset ordering rather than on this code. That is
  # the "check that cannot discriminate" shape, and it would have installed a busybox Git
  # that looks identical until something needs a real coreutil.
  $asset = $rel.assets | Where-Object { $_.name -match "^MinGit-[0-9.]+-$([regex]::Escape($minGitArch))\.zip$" } | Select-Object -First 1
  if (-not $asset) { throw "no MinGit $minGitArch asset found" }
  $zip = Join-Path $tmp 'mingit.zip'
  Get-Archive $asset.browser_download_url $zip
  $dest = Join-Path $env:ProgramFiles 'MinGit'
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  icacls $dest /reset /T /C /Q | Out-Null
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
# Update (documented in packages/nvda-worker/README.md). Use the Win32-OpenSSH release.
try {
  if (Get-Service sshd -ErrorAction SilentlyContinue) { OK 'sshd already present'; Record 'sshd' 'already present' }
  else {
    Record 'sshd' 'installed'
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest' -UseBasicParsing
    $asset = $rel.assets | Where-Object { $_.name -match "^OpenSSH-$([regex]::Escape($openSshArch)).*\.msi$" } | Select-Object -First 1
    if (-not $asset) { throw "no OpenSSH $openSshArch msi asset found" }
    $msi = Join-Path $tmp 'openssh.msi'
    Get-Archive $asset.browser_download_url $msi
    # Start-Process -Wait, NOT `& msiexec`. msiexec.exe is a GUI-subsystem binary, so invoking
    # it through the call operator returns IMMEDIATELY and $LASTEXITCODE is meaningless -- the
    # install had not happened yet when the next line ran, and `Set-Service -Name sshd` failed
    # with "not found on computer '.'", which reads like a broken MSI rather than a race.
    # 3010 is "success, reboot required" and is not a failure.
    $mi = Start-Process 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
    if ($mi.ExitCode -notin @(0, 3010)) { throw "OpenSSH msi failed (exit $($mi.ExitCode))" }
    # Service registration can lag the installer's exit. Poll for the CONDITION rather than
    # guessing a sleep -- the same rule the capture path already follows.
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Get-Service sshd -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
    }
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
      throw "OpenSSH msi reported success (exit $($mi.ExitCode)) but no sshd service appeared within 30s"
    }
  }
  Set-Service -Name sshd -StartupType Automatic
  Start-Service sshd
  if (-not (Get-NetFirewallRule -Name 'sshd-a11y' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'sshd-a11y' -DisplayName 'OpenSSH Server (a11y-witness)' `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  OK "sshd $((Get-Service sshd).Status), port 22 allowed"
  Record 'sshd' "running on port 22"
} catch {
  # Non-fatal by design, and now explicitly RETRYABLE: the summary names it, and a re-run
  # re-enters this step because its guard is "is there an sshd service", which there is not.
  Record 'sshd' "FAILED - $($_.Exception.Message)"
  Warn "OpenSSH setup failed ($($_.Exception.Message)). Continuing -- the worker does not need it."
  Warn "Re-run this script to retry it; every other step skips itself when already done."
}

Step 4 'Clone the repo'
if (Test-Path (Join-Path $RepoPath '.git')) {
  # PULL on a re-run. Without this, a second attempt keeps running the same buggy checkout and
  # fails identically on something already fixed upstream -- which is exactly what the stale
  # provisioning paths would have done.
  Invoke-Native 'git' @('-C', $RepoPath, 'pull', '--ff-only') 'git pull' 2
  OK "already cloned at $RepoPath (pulled)"
  Record 'repo' 'pulled'
} else {
  Invoke-Native 'git' @('clone', $RepoUrl, $RepoPath) 'git clone' 2
  OK "cloned to $RepoPath"
  Record 'repo' 'cloned'
}

Step 5 'Hand off to the provisioning script'
# Located by SEARCH, not by a hardcoded path. This read 'scripts\provision-nvda-worker.ps1'
# and the repo has since moved everything under packages/ -- so the bootstrap cloned
# successfully and then died here with "Not found", after doing all the expensive work.
# A path spelled out in one script and owned by another is exactly the coupling that rots,
# and the same restructure silently broke the provision-revision hash list below.
$provision = Get-ChildItem -Path $RepoPath -Filter 'provision-nvda-worker.ps1' -Recurse -File `
  -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $provision) { throw "provision-nvda-worker.ps1 not found anywhere under $RepoPath" }
OK "provisioning script at $provision"
$env:A11Y_REPO_PATH = $RepoPath
& powershell -NoProfile -ExecutionPolicy Bypass -File $provision
$provisionExit = $LASTEXITCODE
# 75 means provisioning created the local worker account, armed the a11ybootstrap task, and is
# rebooting to continue as that user. It is NOT a failure, and we must not fall through to the
# final step -- that unregisters a11ybootstrap, disarming the handoff we are relying on three
# lines after arming it.
# A FLAG, not `exit`. This script is designed to be run as `irm <url> | iex`, and Invoke-Expression
# evaluates in the CALLER's session -- so `exit` here does not end the script, it terminates the
# operator's entire PowerShell window. Which it did.
#
# `return` would work in both invocation modes, but its behaviour under iex is exactly the kind of
# thing that is obvious right up until it is wrong, and there is no way to test PowerShell from the
# machine this is written on. A guarded block cannot be ambiguous.
$handedOff = $false
if ($provisionExit -eq 75) {
  OK 'provisioning handed off to the worker account; the machine is rebooting to continue'
  $handedOff = $true
} elseif ($provisionExit -ne 0) {
  throw "Provisioning failed (exit $provisionExit)."
}

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
# Skipped entirely on the handoff path: provisioning has already armed a11ybootstrap and
# scheduled the reboot, and the block below would UNREGISTER that task -- dismantling the
# handoff moments after it was set up.
if (-not $handedOff) {
  Step 6 'Reboot to finish (a fresh install cannot capture until it has restarted once)'

  # What this run actually did. On a re-run most lines should read "already present", and the
  # ones that do not are what changed -- without this, a second run looks identical to the first
  # and you cannot tell whether it fixed anything.
  Write-Host "`n    --- what this run did ---" -ForegroundColor Cyan
  foreach ($k in $script:outcomes.Keys) {
    $v = $script:outcomes[$k]
    $colour = if ("$v" -like 'FAILED*') { 'Red' } elseif ("$v" -like '*already*') { 'DarkGray' } else { 'Green' }
    Write-Host ("    {0,-8} {1}" -f $k, $v) -ForegroundColor $colour
  }
  $failed = $script:outcomes.Keys | Where-Object { "$($script:outcomes[$_])" -like 'FAILED*' }
  if ($failed) { Warn "re-run this script to retry: $($failed -join ', ')" }

  # Remove the first-run continuation task, if provisioning left one. Getting this far means setup
  # succeeded, and leaving it armed would re-run the whole bootstrap at EVERY logon.
  #
  # That is not merely untidy, it is a boot loop: this script reboots when /health is not answering,
  # and /health is never answering at the moment a logon task fires. Run once, then disarm.
  #
  # Deliberately NOT turned into a general update-on-boot mechanism, tempting as that is. Three
  # reasons, all of which matter more than the convenience:
  #   - `workerCode` is recorded on every capture so you know what produced it. A worker that
  #     silently updates itself on reboot can span two code versions inside one corpus run, and the
  #     provenance stops meaning anything.
  #   - `worker:deploy` exists and VERIFIES over /health.code, which shares no failure mode with the
  #     push. An unattended self-update has no such check.
  #   - one bad push would then brick every box in the fleet at its next restart, simultaneously.
  if (Get-ScheduledTask -TaskName 'a11ybootstrap' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'a11ybootstrap' -Confirm:$false -ErrorAction SilentlyContinue
    OK "removed the 'a11ybootstrap' first-run task -- setup is complete, it will not run again"
    Record 'first-run task' 'removed'
  }

  # Only reboot if the worker is not ALREADY answering. The reboot exists because a freshly
  # installed Windows cannot capture until it has restarted once -- it is not a general remedy,
  # and rebooting a healthy box on every re-run turns "run it again to fix one step" into an
  # outage. Checked over HTTP because that is the channel the worker actually serves on.
  $alreadyServing = $false
  # `if/else`, not the `? :` ternary: this runs on Windows PowerShell 5.1, where the ternary is a
  # PARSE error -- so it would not fail at this line, it would refuse to load the whole script.
  $workerPort = if ($env:A11Y_PORT) { $env:A11Y_PORT } else { 8765 }
  try {
    $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$workerPort/health" -UseBasicParsing -TimeoutSec 3
    $alreadyServing = $probe.StatusCode -eq 200
  } catch {
    # Not answering is the normal case on a first run; it is why we are about to reboot.
  }
  if ($alreadyServing) {
    OK 'worker is already serving /health -- skipping the reboot'
  } else {
    OK 'rebooting now; the worker restarts itself via auto-logon + the at-logon task'
    Start-Process -FilePath 'shutdown.exe' -ArgumentList '/r','/t','5' -NoNewWindow
  }

  Write-Host @"

  --- Bootstrap complete ---

  Reach it from your Mac:

    ssh-copy-id is not on Windows; append your public key to:
        C:\Users\$env:USERNAME\.ssh\authorized_keys
    (for an ADMIN account Windows uses C:\ProgramData\ssh\administrators_authorized_keys
     instead -- a very common reason key auth silently fails on Windows)

    Then, from the Mac:
        A11Y_WORKER=http://<vm-ip>:8765 npm run witness -- https://example.com --task "..."

  Auto-logon, so the interactive session survives a reboot:
  Auto-logon is configured automatically and needs NO password: provisioning gives the
  console account a blank password, which LimitBlankPasswordUse confines to console
  logon only.
"@
}
