# Provision (or repair) the Windows NVDA capture worker. Idempotent: safe to
# re-run on an already-working machine, and that is the intended way to repair one.
#
# Encodes every step the worker needs, in dependency order, with a verification
# line after each. Written to be run by a person OR an agent. Copy it over and run
# it with -File:
#
#   scp scripts/provision-nvda-worker.ps1 user@host:C:/Users/user/
#   ssh user@host "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\user\provision-nvda-worker.ps1"
#
# Do NOT pipe this to `powershell -Command -`. That mode silently truncated a script
# of this size mid-run, and a leading `<# #>` block comment suppresses its output
# entirely. Reserve stdin piping for short ad-hoc snippets; use -File for anything real.
#
# Read docs/nvda-worker-runbook.md first if anything here is surprising. Each step
# exists because its absence has broken capture at least once.
#
# Config comes from the environment rather than param(), so the same file works in
# either invocation mode:
#   A11Y_REPO_PATH        checkout location (default %USERPROFILE%\a11y-witness)
#   A11Y_PORT             worker port; must match the client's A11Y_WORKER (default 8765)
#   A11Y_TASK_NAME        scheduled-task name (default a11ysrv)
#   A11Y_SKIP_NPM_INSTALL set to 1 to re-apply only OS/NVDA configuration

$ErrorActionPreference = 'Stop'

$RepoPath       = if ($env:A11Y_REPO_PATH) { $env:A11Y_REPO_PATH } else { Join-Path $env:USERPROFILE 'a11y-witness' }

# Resolve a repo file by NAME rather than by a hardcoded relative path.
#
# Four paths in this script were spelled 'src\capture\nvda\...', and the repo moved everything
# under packages/. One threw ("Worker launcher not found"); the other two sat behind
# `if (Test-Path ...)` and SILENTLY skipped -- so the Windows trim never ran and the a11ycheck
# task was never registered, on every guest provisioned since the restructure, with no message.
# A guard that cannot tell "moved" from "deliberately absent" reports neither.
#
# Searches the source trees only: a provisioned guest has node_modules, and recursing the whole
# repo takes minutes.
function Resolve-RepoFile($name, [switch] $Required) {
  $roots = @('packages', 'scripts', 'src') |
    ForEach-Object { Join-Path $RepoPath $_ } | Where-Object { Test-Path $_ }
  foreach ($root in $roots) {
    $hit = Get-ChildItem -Path $root -Filter $name -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules\\' } | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  if ($Required) { throw "$name not found under $RepoPath (searched: $($roots -join ', '))" }
  Warn "$name not found under $RepoPath -- the step that needs it will be skipped"
  return $null
}
$Port           = if ($env:A11Y_PORT) { [int] $env:A11Y_PORT } else { 8765 }
$TaskName       = if ($env:A11Y_TASK_NAME) { $env:A11Y_TASK_NAME } else { 'a11ysrv' }
$SkipNpmInstall = $env:A11Y_SKIP_NPM_INSTALL -eq '1'
$script:warnings = @()

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function OK($msg)       { Write-Host "    OK    $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "    WARN  $msg" -ForegroundColor Yellow; $script:warnings += $msg }

# npm and npx write progress and warnings to stderr as a matter of course. With
# $ErrorActionPreference = 'Stop', PowerShell promotes ANY native stderr line to a
# terminating NativeCommandError — so npm's routine "allow-scripts" warning would
# abort provisioning with a misleading error. Relax error handling around native
# calls and gate on the only trustworthy signal: the process exit code.
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

# npx.ps1 is blocked by the default execution policy, so always call the .cmd.
$npx = Join-Path $env:ProgramFiles 'nodejs\npx.cmd'
$npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'

# ---------------------------------------------------------------------------
Step 1 'Preconditions'

if (-not (Test-Path $RepoPath)) { throw "Repo not found at $RepoPath. Clone it first, or pass -RepoPath." }
OK "repo at $RepoPath"

foreach ($exe in @($npx, $npm)) {
  if (-not (Test-Path $exe)) { throw "Node.js not found ($exe). Install it: winget install --id OpenJS.NodeJS.LTS -e --silent" }
}
OK "node $(& node --version), npm $(& $npm --version)"

# NVDA is a GUI app: it needs a real logged-on desktop. Over SSH alone there is no
# interactive session and NVDA announces nothing at all, so this is worth asserting
# loudly rather than discovering later via empty transcripts.
# `query session` prefixes the CURRENT session with '>', so the anchor must allow it;
# otherwise this warns "NO active console session" on a box that plainly has one.
$console = (query session 2>$null | Select-String '^\s*>?\s*console\s+\S+\s+\d+\s+Active')
if ($console) { OK 'an interactive console session is logged on' }
else { Warn 'NO active console session. NVDA cannot run until someone is logged on at the console (see the auto-logon step).' }

$elevatedEarly = (New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltinRole]::Administrator)

# The worker account must be LOCAL, and this is checked FIRST because everything below is
# per-user: the a11ysrv task is registered `-AtLogOn -User <account>`, NVDA caches to
# %LOCALAPPDATA%\guidepup, and the repo and Edge profile live in the profile. Provisioning a
# Microsoft account's profile and then auto-logging in as someone else produces a box that boots,
# logs in, and serves nothing -- so this refuses at the START rather than after ten minutes of
# work that will be abandoned.
#
# A Microsoft account cannot hold a blank password, and a blank password is what lets this fleet
# auto-log-on with no credential stored anywhere. So the answer is a dedicated local account,
# which is what the UTM guests already use.
# Not 0 and not 1: "I did my job and the machine is restarting to continue as another user" is a
# third outcome, and collapsing it into either of the other two makes the caller do the wrong thing.
$EXIT_HANDOFF_REBOOT = 75
$WorkerAccount = if ($env:A11Y_WORKER_ACCOUNT) { $env:A11Y_WORKER_ACCOUNT } else { 'witness' }
$me = $null
try { $me = Get-LocalUser -Name $env:USERNAME -ErrorAction Stop } catch { }

if ($me -and (-not $me.PrincipalSource -or $me.PrincipalSource -eq 'Local')) {
  OK "running as LOCAL account '$env:USERNAME' -- correct for a worker"
} else {
  $kind = if ($me) { $me.PrincipalSource } else { 'non-local' }
  Warn "running as a $kind account ('$env:USERNAME'), which cannot hold a blank password."

  # Create the local account and point auto-logon at it, so the ONLY thing left is to reboot and
  # run this again. Creating it here rather than telling you to is the difference between a
  # repeatable setup and a per-machine ritual that gets skipped on machine seven.
  if (-not $elevatedEarly) {
    throw "Elevation is required to create the local '$WorkerAccount' account. Re-run this elevated."
  }
  $blank = New-Object System.Security.SecureString
  if (Get-LocalUser -Name $WorkerAccount -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $WorkerAccount -Password $blank -PasswordNeverExpires $true
    OK "local account '$WorkerAccount' already existed; password blanked"
  } else {
    # -Description is capped at 48 characters by a ValidateLength attribute, and going over it
    # fails argument binding rather than truncating -- "Cannot validate argument on parameter
    # 'Description'", which does not mention a length. This one is 43.
    New-LocalUser -Name $WorkerAccount -NoPassword `
      -FullName 'a11y-witness capture worker' `
      -Description 'Console-only worker. No password by design.' | Out-Null
    # Separate call: -PasswordNeverExpires lives in a different parameter set from -NoPassword,
    # so combining them fails to bind rather than doing what it reads like.
    Set-LocalUser -Name $WorkerAccount -PasswordNeverExpires $true -ErrorAction SilentlyContinue
    OK "created local account '$WorkerAccount'"
  }
  # Administrators because provisioning sets the firewall, Edge policy and a scheduled task.
  #
  # VERIFIED, not assumed. This was `-ErrorAction SilentlyContinue` followed by an unconditional
  # OK saying the account was an administrator -- so a silent failure printed success, which is
  # the exact shape this file has spent the day removing, written by me while removing it.
  # It also matters beyond provisioning: sshd picks administrators_authorized_keys for a member
  # of that group and the profile's own authorized_keys for anyone else, so getting this wrong
  # makes key auth fail later with no error that mentions group membership.
  Add-LocalGroupMember -Group 'Administrators' -Member $WorkerAccount -ErrorAction SilentlyContinue
  $inAdmins = Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*\$WorkerAccount" }
  if ($inAdmins) { OK "'$WorkerAccount' is an administrator" }
  else { throw "could not add '$WorkerAccount' to Administrators -- provisioning needs it for the firewall, Edge policy and task registration" }

  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $winlogon -Name AutoAdminLogon    -Value '1'            -Type String -Force
  Set-ItemProperty $winlogon -Name DefaultUserName   -Value $WorkerAccount -Type String -Force
  Set-ItemProperty $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME -Type String -Force
  foreach ($dead in @('DefaultPassword', 'AutoLogonCount')) {
    Remove-ItemProperty $winlogon -Name $dead -ErrorAction SilentlyContinue
  }
  OK "auto-logon now points at '$WorkerAccount' with no stored credential"

  # Continue AUTOMATICALLY at that account's first logon, rather than leaving a manual step.
  #
  # A scheduled task, not RunOnce or a Startup shortcut: those run without elevation, and the rest
  # of provisioning needs it for the firewall, Edge policy and task registration. -RunLevel Highest
  # is the only mechanism here that gets an elevated, INTERACTIVE session -- which NVDA needs too.
  #
  # The script is copied to ProgramData rather than run from the old profile: `witness` is an
  # administrator and could read C:\Users\borem\..., but a machine-wide appliance should not depend
  # on the profile of the human who happened to unbox it.
  $bootstrapSrc = Resolve-RepoFile 'bootstrap-windows-worker.ps1'
  if ($bootstrapSrc) {
    $shared = 'C:\ProgramData\a11y-witness'
    New-Item -ItemType Directory -Force -Path $shared | Out-Null
    $bootstrapDst = Join-Path $shared 'bootstrap.ps1'
    Copy-Item $bootstrapSrc $bootstrapDst -Force

    Unregister-ScheduledTask -TaskName 'a11ybootstrap' -Confirm:$false -ErrorAction SilentlyContinue
    # LOG IT. A scheduled task runs hidden, so without a redirect an unattended failure leaves
    # nothing to read at all -- which is how this run became a guessing game. Transcript, not just
    # stdout redirection, because PowerShell writes Write-Host to the host rather than stdout and
    # the OK/Warn lines here are all Write-Host.
    $bootstrapLog = Join-Path $shared 'bootstrap.log'
    $inner = "Start-Transcript -Path '$bootstrapLog' -Append; " +
             "try { & '$bootstrapDst' } finally { Stop-Transcript }"
    Register-ScheduledTask -TaskName 'a11ybootstrap' `
      -Action (New-ScheduledTaskAction -Execute 'powershell.exe' `
                 -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$inner`"") `
      -Principal (New-ScheduledTaskPrincipal -UserId $WorkerAccount -LogonType Interactive -RunLevel Highest) `
      -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $WorkerAccount) `
      -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -StartWhenAvailable) `
      -Force | Out-Null
    # The bootstrap unregisters this itself once it gets far enough to succeed, so it does not run
    # on every logon for ever -- see the note there about why continuous re-provisioning is a
    # different and more dangerous idea than finishing a first install.
    OK "registered 'a11ybootstrap' -- finishes setup at $WorkerAccount's first logon"
    OK "its transcript will be at $bootstrapLog"
  } else {
    Warn 'bootstrap-windows-worker.ps1 not found in the repo -- cannot continue automatically.'
    Warn "After rebooting, run the bootstrap by hand as $WorkerAccount."
  }

  Write-Host @"

--- Handing off to '$WorkerAccount' ---

  Nothing below this point would land in the right profile, so this run stops here.

  '$WorkerAccount' exists, is an administrator, has no password, and is the auto-logon user.
  The 'a11ybootstrap' task will finish setup elevated at its first logon and then remove
  itself. REBOOTING NOW -- no further input needed. Watch /health come up.

  This detour happens ONCE per machine, and not at all on a box whose autounattend.xml
  created a local account at install time.
"@

  # Reboot ourselves rather than telling somebody to. The whole point of this path is that it
  # needs no operator, and "now go and restart it" is the manual step it exists to remove.
  #
  # 20s so the message is readable and an operator watching can Ctrl-C the shutdown if they
  # were mid-something: `shutdown /a` aborts it.
  Start-Process -FilePath 'shutdown.exe' -ArgumentList '/r', '/t', '20' -NoNewWindow

  # A DISTINCT exit code, not 0 and not a throw. The caller must know this is a planned handoff:
  #   - exit 0 would let the bootstrap continue to its final step, which UNREGISTERS
  #     a11ybootstrap -- disarming the task we just armed, three lines after arming it.
  #   - a throw reads as a failure in the log of a run that did exactly what it should.
  exit $EXIT_HANDOFF_REBOOT
}

$elevated = $elevatedEarly
if ($elevated) { OK 'session is elevated (needed for the firewall/Edge-policy steps)' }
else { Warn 'not elevated: the firewall and Edge-policy steps will be skipped.' }

# ---------------------------------------------------------------------------
Step 2 'Dependencies'

if ($SkipNpmInstall) { OK 'skipped (A11Y_SKIP_NPM_INSTALL=1)' }
else {
  Push-Location $RepoPath
  try { Invoke-Native $npm @('install') 'npm install' }
  finally { Pop-Location }
}
$gpManifest = Join-Path $RepoPath 'node_modules\@guidepup\guidepup\package.json'
if (-not (Test-Path $gpManifest)) { throw '@guidepup/guidepup is not installed. Run npm install.' }
$gpVersion = (Get-Content $gpManifest -Raw | ConvertFrom-Json).version
OK "@guidepup/guidepup $gpVersion"

# guidepup <0.29 looks for the old NVDA Remote ADD-ON certificate; NVDA 2026.1.x
# ships Remote Access in core and has no such add-on, so the pair fails at
# NVDAClient.connect and reports it, misleadingly, as "NVDA not installed".
if ([version]($gpVersion -replace '-.*$') -lt [version]'0.29.0') {
  Warn "guidepup $gpVersion cannot drive NVDA 2026.x. Bump it to >=0.29.2 in package.json."
}

# ---------------------------------------------------------------------------
Step 3 'Guidepup environment (zeroes ForegroundLockTimeout so Edge can take focus)'

Push-Location $RepoPath
try { Invoke-Native $npx @('--yes', '@guidepup/setup', 'setup') 'guidepup setup' 2 }
finally { Pop-Location }
# Apply ForegroundLockTimeout to THIS session, now, via SystemParametersInfo. A registry
# write alone is not enough: the value is cached per session, and Windows does not reliably
# consume it at logon either, so "it will work after a reboot" is not a safe claim. Left
# non-zero, captures return 0 phrases with NO error anywhere -- nvda.start() succeeds,
# windowsActivate reports ok, and every read comes back empty, because Edge is refused the
# foreground. See scripts/apply-foreground-lock-timeout.ps1 for the detail.
$fltScript = Join-Path $PSScriptRoot 'apply-foreground-lock-timeout.ps1'
if (Test-Path $fltScript) {
  $fltOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $fltScript 2>&1
  if ($LASTEXITCODE -eq 0) { OK ($fltOut | Select-Object -First 1) }
  else { Warn (($fltOut | Out-String).Trim()) }
} else {
  Warn "not found: $fltScript (ForegroundLockTimeout not applied; Edge may fail to take focus)"
}

# ---------------------------------------------------------------------------
Step 4 'Install NVDA'

# Run from the repo: the installer reads the LOCAL @guidepup/guidepup manifest.json
# to decide which NVDA build to fetch, so this is what keeps the screen reader and
# the driver in lockstep. It caches to %LOCALAPPDATA%\guidepup (override with
# GUIDEPUP_SCREEN_READERS_PATH) -- NOT %TEMP%, which Windows cleanup empties.
Push-Location $RepoPath
try { Invoke-Native $npx @('--yes', '@guidepup/setup', 'install', 'nvda') 'guidepup install nvda' 4 }
finally { Pop-Location }

$cacheRoot = if ($env:GUIDEPUP_SCREEN_READERS_PATH) { $env:GUIDEPUP_SCREEN_READERS_PATH } else { Join-Path $env:LOCALAPPDATA 'guidepup' }
$nvdaExe = Get-ChildItem (Join-Path $cacheRoot 'nvda') -Recurse -Filter 'nvda.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $nvdaExe) { throw "NVDA not found under $cacheRoot. The install step failed." }

# A gutted install is the failure this whole script exists to prevent: %TEMP%
# cleanup once deleted library.zip and left nvda.exe as a stub that launches and
# dies, producing "Timed out waiting for NVDA to be running" and no nvda.log.
$nvdaDir  = Split-Path $nvdaExe.FullName
$fileCount = (Get-ChildItem $nvdaDir -Recurse -File -ErrorAction SilentlyContinue).Count
if ($fileCount -lt 500) { throw "NVDA install at $nvdaDir looks gutted ($fileCount files; expect ~1700+). Delete it and re-run." }
OK "NVDA at $nvdaDir ($fileCount files)"
foreach ($required in @('library.zip', 'nvda_slave.exe')) {
  if (-not (Test-Path (Join-Path $nvdaDir $required))) { throw "NVDA install is incomplete: $required missing." }
}
OK 'payload files present (library.zip, nvda_slave.exe)'

# ---------------------------------------------------------------------------
Step 5 'Disable the NVDA Speech Viewer'

# Guidepup's bundled config ships the Speech Viewer ON. That window's focus event
# is announced, so it lands in the spokenPhraseLog delta captured right after
# activating a control: every interaction probe returns "NVDA Speech Viewer"
# instead of the page's response, making an accessible page and an inaccessible
# one indistinguishable. capture-check still passes, because it asserts that the
# probe fired, not what it heard -- so this fails silently and must be asserted.
$patched = 0
foreach ($ini in (Get-ChildItem $nvdaDir -Recurse -Filter 'nvda.ini' -ErrorAction SilentlyContinue)) {
  $body = Get-Content $ini.FullName -Raw
  $new  = $body -replace 'showSpeechViewerAtStartup = True', 'showSpeechViewerAtStartup = False'
  if ($new -ne $body) { Set-Content -Path $ini.FullName -Value $new -NoNewline; $patched++ }
}
$stillOn = (Get-ChildItem $nvdaDir -Recurse -Filter 'nvda.ini' -ErrorAction SilentlyContinue |
  Select-String 'showSpeechViewerAtStartup = True')
if ($stillOn) { throw 'Speech Viewer is still enabled; interaction probes would be unusable.' }
OK "Speech Viewer off (patched $patched file(s)). NOTE: reinstalling NVDA resets this -- re-run this script."

# ---------------------------------------------------------------------------
Step 6 'No blocking dialogs (a VM console cannot be clicked)'

if ($elevated) {
  # A program that starts listening with no matching rule raises the "allow this
  # app" alert, which blocks the whole interactive session until dismissed.
  Set-NetFirewallProfile -Profile Domain, Private, Public -NotifyOnListen False
  OK 'firewall NotifyOnListen = False (no allow-app dialogs)'

  $ruleName = "a11y-witness worker $Port"
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
  }
  OK "inbound rule '$ruleName'"

  # A brand-new Edge profile shows a welcome/sign-in surface. On a page with no
  # headings, NVDA quick-nav escapes the empty document into that browser UI and
  # records it as phantom elements ("Welcome to Microsoft Edge").
  $edgeKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
  New-Item -Path $edgeKey -Force | Out-Null
  Set-ItemProperty $edgeKey -Name 'HideFirstRunExperience' -Value 1 -Type DWord
  Set-ItemProperty $edgeKey -Name 'BrowserSignin' -Value 0 -Type DWord
  # Stop Edge doing anything when we are not asking it to. A capture launches and kills Edge
  # once per capture -- 90 times in a dataset run -- and background work racing that is both
  # a source of leaked processes and of noise in the guest.
  #
  # Observed after a 45-pair run: 5 msedge processes alive on an idle, freshly booted machine
  # with zero captures run, plus WER crash reports from MicrosoftEdgeUpdate.exe and Edge's
  # own setup.exe (EdgeInstallerError 0x220). Edge was updating itself underneath the run.
  Set-ItemProperty $edgeKey -Name 'BackgroundModeEnabled' -Value 0 -Type DWord
  Set-ItemProperty $edgeKey -Name 'StartupBoostEnabled' -Value 0 -Type DWord
  # Autofill draws a suggestion icon inside recognised inputs, and NVDA announces it as an embedded
  # object (U+FFFC) appended to the field announcement. Whether it appears depends on what the durable
  # profile has learned, so the same page announces differently over the life of a run -- measured
  # rising from 3% to 31% of affected captures as the profile accumulated, with 26 good/bad pairs in
  # the corpus disagreeing about it. Off, so a form field announcement is a property of the PAGE.
  Set-ItemProperty $edgeKey -Name 'AutofillAddressEnabled' -Value 0 -Type DWord
  Set-ItemProperty $edgeKey -Name 'AutofillCreditCardEnabled' -Value 0 -Type DWord
  Set-ItemProperty $edgeKey -Name 'PasswordManagerEnabled' -Value 0 -Type DWord
  OK 'Edge policies set (first-run suppressed, no background mode, no startup boost)'

  # Edge auto-update, off. On a workstation this is right; on a capture appliance it means an
  # installer runs unannounced while we are driving the browser.
  $edgeUpdateKey = 'HKLM:\SOFTWARE\Policies\Microsoft\EdgeUpdate'
  New-Item -Path $edgeUpdateKey -Force | Out-Null
  Set-ItemProperty $edgeUpdateKey -Name 'UpdateDefault' -Value 0 -Type DWord
  Set-ItemProperty $edgeUpdateKey -Name 'AutoUpdateCheckPeriodMinutes' -Value 0 -Type DWord
  OK 'Edge auto-update disabled'

  # Windows must not choose its own downtime. During one 94-minute dataset run Windows
  # Update rebooted the worker TWICE mid-capture:
  #   id=1074  winlogon.exe has initiated the power off ... on behalf of NT AUTHORITY\SYSTEM
  # at 09:02:55 and 09:09:30. The run only survived because auto-logon plus the at-logon task
  # self-heal, and the outages happened to fall between cases.
  #
  # Updates still download and install -- we are not leaving the box unpatched -- but the
  # reboot waits for a human. The worker always has a logged-on user (auto-logon is required
  # for NVDA), which is exactly the condition this policy keys on.
  # Nothing may pop to the foreground uninvited. A capture works by forcing Edge to the front
  # and reading what NVDA announces; a notification that steals focus mid-capture corrupts the
  # evidence, and one that sits over the page does it silently. Observed on the guest: OneDrive
  # offering "Turn On Windows Backup" during a run.
  $explorerPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Explorer'
  New-Item -Path $explorerPolicy -Force | Out-Null
  Set-ItemProperty $explorerPolicy -Name 'DisableNotificationCenter' -Value 1 -Type DWord
  $oneDrive = 'HKLM:\SOFTWARE\Policies\Microsoft\OneDrive'
  New-Item -Path $oneDrive -Force | Out-Null
  Set-ItemProperty $oneDrive -Name 'DisableFileSyncNGSC' -Value 1 -Type DWord
  Set-ItemProperty $oneDrive -Name 'PreventNetworkTrafficPreUserSignIn' -Value 1 -Type DWord
  $contentDelivery = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'
  if (Test-Path $contentDelivery) {
    foreach ($n in @('SubscribedContent-338389Enabled','SubscribedContent-310093Enabled','SoftLandingEnabled','SystemPaneSuggestionsEnabled')) {
      Set-ItemProperty $contentDelivery -Name $n -Value 0 -Type DWord -ErrorAction SilentlyContinue
    }
  }
  # The policy stops OneDrive starting again; it does not remove the per-user Run entry that
  # relaunches it at logon, and it does not dismiss a toast already on screen. Observed: the
  # policy applied cleanly and the "Turn On Windows Backup" prompt was still sitting over the
  # desktop. Remove it properly.
  Get-Process OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($n in @('OneDrive', 'OneDriveSetup')) {
    Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $n -ErrorAction SilentlyContinue
  }
  $odSetup = "$env:SystemRoot\SysWOW64\OneDriveSetup.exe"
  if (-not (Test-Path $odSetup)) { $odSetup = "$env:SystemRoot\System32\OneDriveSetup.exe" }
  if (Test-Path $odSetup) { Start-Process $odSetup -ArgumentList '/uninstall' -Wait -ErrorAction SilentlyContinue }
  OK 'notifications, suggestion popups and OneDrive removed'

  $auKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
  New-Item -Path $auKey -Force | Out-Null
  Set-ItemProperty $auKey -Name 'NoAutoRebootWithLoggedOnUsers' -Value 1 -Type DWord
  OK 'Windows Update will not reboot on its own while a user is logged on'
} else {
  Warn 'skipped firewall + Edge/Update policies (needs elevation)'
}

# UAC prompts land on the secure desktop, where NVDA cannot read them and
# automation cannot click them. The answer is to need no elevation at runtime --
# never to elevate the worker. Guidepup drives nvda_noUIAccess.exe, which cannot
# read elevated windows at all, so an elevated browser would capture nothing.
if ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).PromptOnSecureDesktop -eq 1) {
  OK 'UAC prompts on secure desktop (fine: nothing in the capture path needs elevation)'
}

# The screensaver can take the foreground mid-capture and steal focus from Edge.
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -Value '0'
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveTimeOut -Value '0'
OK 'screensaver disabled'

# ---------------------------------------------------------------------------
Step 7 'Trim Windows background services and apps'

# A capture guest runs a browser and a screen reader -- 425 MB of work -- inside ~1,850 MB of committed
# memory. That matters because host cost scales at ~1.8-2.0x the guest's CONFIGURED RAM, so the ceiling
# is the big lever: 4,096 MB costs the host ~8.1 GB, 2,560 MB costs ~4.7 GB. But the ceiling cannot go
# below what Windows commits, and a stock guest at 2,560 MB was measured paging badly -- capture phases
# went from ~20 s to a 36.6 s median with 4 recoveries in 10 captures. Trimming the OS is what makes a
# lower ceiling reachable; it is not the prize itself.
#
# This lives here, and not in the worker, because every call below needs elevation and the worker task
# is deliberately RunLevel Limited (see Step 8). The worker attempts the same trim at boot, detects it
# is unelevated, and records `needsElevation` rather than failing silently -- which it did, on three
# consecutive boots, before this existed.
#
# The list is nano11builder's technique with none of its choices: nano11 deletes Edge and
# LanguageFeatures-Speech/-TextToSpeech (the browser we capture through and NVDA's `oneCore` synth), and
# hardcodes amd64 package names while these guests are ARM64. So names are read from the guest, and
# packages/nvda-worker/src/windows-trim.mjs holds the authoritative allow/deny lists with the tests that keep
# Edge and the speech stack out of the removal set.
$trimScript = Resolve-RepoFile 'windows-trim.mjs'
$trimMarker = Join-Path $RepoPath '.windows-trimmed'
if (Test-Path $trimScript) {
  if (Test-Path $trimMarker) {
    OK "already trimmed ($((Get-Content $trimMarker -Raw).Trim()))"
  } else {
    # Elevated here, so DISM and sc.exe both work. Minutes, mostly Appx removal.
    & node $trimScript $trimMarker 2>&1 | Select-Object -Last 6 | ForEach-Object { Write-Host "      $_" }
    if (Test-Path $trimMarker) { OK "trimmed: $((Get-Content $trimMarker -Raw).Trim())" }
    else { Warn 'trim produced no marker -- see .windows-trimmed.log' }
  }
} else {
  Warn "trim script not found at $trimScript (deploy it first)"
}

# Defender is ~242 MB, the single largest removable item, and Tamper Protection blocks turning it off
# from a running system -- confirmed on this fleet: Get-MpComputerStatus reports IsTamperProtected=True.
# That is why tiny11 does it offline against a mounted image. Reported, not fought: if Defender is the
# only thing that needs offline access, ~242 MB is the entire return on owning an ISO pipeline, and that
# should be decided on the number rather than on enthusiasm.
$tp = try { (Get-MpComputerStatus).IsTamperProtected } catch { $null }
if ($tp -eq $true) {
  Warn 'Defender stays (~242 MB): Tamper Protection is ON and blocks disabling it from the running OS. Turn it off in Windows Security, or remove Defender offline in an image build.'
} elseif ($tp -eq $false) {
  try {
    Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction Stop
    OK 'Defender real-time protection disabled (Tamper Protection was off)'
  } catch { Warn "Defender still on: $($_.Exception.Message)" }
} else {
  OK 'Defender not present or not queryable'
}

# ---------------------------------------------------------------------------
Step 7a 'Never sleep, and keep the NIC awake'

# A worker that sleeps is a worker that has vanished, and this is BARE-METAL ONLY: VMs do not
# sleep, so the whole fleet ran for months without needing it. On the first physical box it
# presented as `EHOSTUNREACH <worker>:8765` for every request in an evidence-check run --
# 48 instant failures -- and then answered a curl 30 seconds later. Intermittent unreachability
# reads as a flaky network or a wedged worker; it was Windows power management doing its job.
#
# Two separate mechanisms, and fixing only one leaves the fault intermittent:
#   - the sleep/hibernate timers put the whole machine away
#   - the NIC's own selective suspend powers the adapter down while the OS stays up
try {
  # 0 = never. AC only: these boxes have no battery, and a laptop-based worker sleeping on
  # battery is correct behaviour rather than a fault.
  foreach ($setting in @('standby-timeout-ac', 'hibernate-timeout-ac', 'disk-timeout-ac')) {
    Invoke-Native 'powercfg.exe' @('/change', $setting, '0') "powercfg $setting" 1
  }
  # Hibernation off entirely: it also reclaims hiberfil.sys, which is RAM-sized on a disk that
  # holds a browser profile and an NVDA install.
  & powercfg.exe /hibernate off 2>&1 | Out-Null
  OK 'sleep, hibernate and disk timeouts disabled on AC'
} catch {
  Warn "powercfg failed ($($_.Exception.Message)) -- the worker may sleep and look unreachable"
}

try {
  # "Allow the computer to turn off this device to save power" is ON by default on most NICs.
  # Set-NetAdapterPowerManagement is not present on every SKU, so fall back to the registry
  # value it writes: PnPCapabilities 24 = disable both power-down and wake-armed.
  $adapters = Get-NetAdapter -Physical -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' }
  foreach ($a in $adapters) {
    try {
      Set-NetAdapterPowerManagement -Name $a.Name -AllowComputerToTurnOffDevice Disabled -ErrorAction Stop
    } catch {
      $key = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}"
      Get-ChildItem $key -ErrorAction SilentlyContinue | Where-Object {
        (Get-ItemProperty $_.PSPath -Name DriverDesc -ErrorAction SilentlyContinue).DriverDesc -eq $a.InterfaceDescription
      } | ForEach-Object { Set-ItemProperty $_.PSPath -Name PnPCapabilities -Value 24 -Type DWord -Force }
    }
    OK "NIC '$($a.Name)' will not be powered down"
  }
  if (-not $adapters) { Warn 'no physical network adapter reported Up -- NIC power saving not checked' }
} catch {
  Warn "NIC power management not adjusted ($($_.Exception.Message))"
}

# ---------------------------------------------------------------------------
Step 7b 'Durable browser capture profile'

# browsers.mjs defaults this under %LOCALAPPDATA%, one directory PER BROWSER; A11Y_BROWSER_PROFILE
# overrides for any browser and A11Y_EDGE_PROFILE for Edge only (kept because this script has always
# read it, and provisioning preparing one path while the worker uses another leaves a first-run
# browser -- which NVDA records as phantom elements on pages with no headings).
# It must not sit in %TEMP%, for the same reason the NVDA install must not.
#
# Both are created regardless of which browser this guest will drive: they cost an empty directory, and
# a guest whose browser is switched later should not need re-provisioning to get a prepared profile.
$profileNames = @('edge-profile', 'chrome-profile')
foreach ($name in $profileNames) {
  $dir = if ($env:A11Y_BROWSER_PROFILE) { $env:A11Y_BROWSER_PROFILE }
         elseif ($name -eq 'edge-profile' -and $env:A11Y_EDGE_PROFILE) { $env:A11Y_EDGE_PROFILE }
         else { Join-Path $env:LOCALAPPDATA "a11y-witness\$name" }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  OK "Browser profile dir $dir"
}

# ---------------------------------------------------------------------------
Step 8 "Worker scheduled task '$TaskName'"

# LogonType Interactive is mandatory: the task then runs inside the logged-on
# desktop session. A service, or a plain SSH command, has no desktop and NVDA
# announces nothing. RunLevel Limited (not Highest) keeps it unelevated on
# purpose -- see the UAC/UIAccess note above.
$cmd = Resolve-RepoFile 'run-server.cmd' -Required

# Use the RESOLVED identity, not "$env:USERDOMAIN\$env:USERNAME": on a workgroup
# machine USERDOMAIN is literally "WORKGROUP", which is not an account any SID maps
# to, and Register-ScheduledTask fails with HRESULT 0x80070534.
$account   = [Security.Principal.WindowsIdentity]::GetCurrent().Name
# Resolve node HERE and pass it to the launcher, rather than letting the launcher work it out
# from an environment the task does not have. Provisioning runs in an interactive elevated
# session where %ProgramFiles% is correct; the task's environment has neither that nor node on
# PATH, and every attempt to re-derive it inside cmd has failed -- including a for-set over
# absolute literals. Baked into the task definition, it is inspectable with Get-ScheduledTask
# and cannot be derived wrongly at launch.
$nodeForTask = @(
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  'C:\Program Files\nodejs\node.exe',
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $nodeForTask) { $nodeForTask = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeForTask) { throw 'node.exe not found -- cannot register a worker task that would fail at launch' }
OK "worker will run: $nodeForTask"
# The path is quoted because it contains spaces. Built as a separate variable rather than
# nested backtick-escaped quotes inside an interpolated string: the escaped form is easy to
# get wrong and, when wrong, swallows the NEXT line into the string -- which is exactly what
# happened, producing a parse error about a variable reference two lines further down.
$nodeArg   = '"' + $nodeForTask + '"'
$action    = New-ScheduledTaskAction -Execute $cmd -Argument $nodeArg
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
# An at-logon trigger is what makes the worker self-healing across reboots. Without
# it the task sits at "Ready" forever and the machine looks dead after a restart.
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $account
# The at-logon trigger covers reboots but NOT a crash: when the worker process died the task
# went back to "Ready" and stayed there, so the machine answered nothing until someone logged
# on again. Observed for real -- an NVDA socket error killed the worker and it never came back.
#
# RestartCount/RestartInterval make Task Scheduler bring it back on a non-zero exit, which is
# why server.mjs now exits 1 on an unrecoverable error instead of limping on.
# ExecutionTimeLimit 0 = no limit: this is a long-running service, not a batch job, and the
# default 3-day limit would silently kill it.
$settings  = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger `
  -Settings $settings -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
OK "registered: logon=$($task.Principal.LogonType) runLevel=$($task.Principal.RunLevel) triggers=$(($task.Triggers | Measure-Object).Count) restarts=$($task.Settings.RestartCount)"

# The capture-regression gate needs the same interactive desktop the worker does, so it needs
# its own task -- `utmctl exec` and SSH land in session 0 and Guidepup reports that as
# "NVDA is not supported", which reads like a broken install. Registering it here means every
# worker can run the gate; it was previously reconstructed by hand each time.
#
# No trigger: this one is started on demand, never at logon. ExecutionTimeLimit is 30 minutes
# rather than unlimited, because unlike the worker it IS a batch job and a wedged check should
# not sit there forever.
$checkCmd = Resolve-RepoFile 'run-capture-check.cmd'
if (Test-Path $checkCmd) {
  $checkSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName 'a11ycheck' `
    -Action (New-ScheduledTaskAction -Execute $checkCmd) `
    -Principal $principal -Settings $checkSettings -Force | Out-Null
  OK "registered 'a11ycheck' (on-demand capture-regression gate)"
} else {
  Warn "no run-capture-check.cmd at $checkCmd -- skipping the a11ycheck task"
}

# ---------------------------------------------------------------------------
# Stamp WHAT provisioned this guest, so the host's capture cache can tell when the
# environment behind the evidence changed.
#
# Provisioning is not cosmetic: it sets NVDA's configuration, Edge's policies and
# ForegroundLockTimeout, each of which changes what a capture hears. Two guests running identical
# capture code can therefore produce different evidence, and without this the cache would reuse
# one guest's captures for another's environment.
#
# Written by the guest rather than hashed on the host on purpose -- this records what the guest
# ACTUALLY has, which is the only thing worth keying on. A host-side hash would describe the
# script we intended to run.
# Delegated to stamp-provision-revision.ps1 so there is ONE definition of what the stamp covers. It was
# inline here, which meant the Ansible role could not stamp at all -- a box re-provisioned through
# `provision-role.yml` kept whatever revision its first boot happened to write, and four functionally
# identical machines reported four different revisions that no re-provision could converge.
#
# Same shape as `worker-files.mjs`: that list was duplicated in server.mjs and check-worker-code.mjs with
# a third derived by regex, and every copy had to agree or the comparison meant nothing.
$stampScript = Resolve-RepoFile 'stamp-provision-revision.ps1' -Required
$stamp = & powershell -NoProfile -ExecutionPolicy Bypass -File $stampScript -RepoPath $RepoPath
if ($LASTEXITCODE -ne 0) { throw "provision stamp failed: $stamp" }
OK "provision revision stamped: $stamp"

# ---------------------------------------------------------------------------
Step 8a 'Auto-logon with NO stored credential'

# NVDA needs a logged-on console session, and a11ysrv triggers AT LOGON. Without auto-logon a
# rebooted box sits at the login screen and never serves -- indistinguishable, from outside, from
# a dead machine. Every box in a fleet restarts, so this cannot be a manual step.
#
# NO PASSWORD IS STORED ANYWHERE, and that is the point rather than a shortcut. Auto-logon with a
# real password means the secret exists in LSA, in the operator's shell, and in whatever
# distributed it to ten machines. A local account with a BLANK password needs none of that: there
# is no credential to leak, rotate or forget.
#
# The security maths favours it, which is not obvious and is worth writing down:
#
#   - Auto-logon ALREADY means the box boots to an unlocked desktop. Anyone with physical access
#     owns that session whether the password is blank or forty characters. The marginal exposure
#     of blanking it is close to zero.
#   - Windows ships LimitBlankPasswordUse=1, which blocks blank-password accounts from NETWORK
#     logon entirely -- no SMB, no RDP, no password-auth SSH. The account becomes console-only,
#     which is strictly narrower than it was before.
#   - SSH still works, because provisioning sets up KEY auth. Key auth is unaffected by this.
#
# It is verified below rather than assumed, because "blank password" is only safe while
# LimitBlankPasswordUse holds.
# NOT $account: Step 8 already uses that name for the task PRINCIPAL (a domain-qualified string),
# and this is a LocalUser object. Two meanings for one name in one scope is how somebody later reads
# the wrong one and cannot see why.
$localUser = $null
try { $localUser = Get-LocalUser -Name $env:USERNAME -ErrorAction Stop } catch { }

if (-not $localUser) {
  Warn "no LOCAL account named '$env:USERNAME' -- auto-logon NOT configured."
  Warn 'A Microsoft or domain account cannot hold a blank password. Create a local account for the'
  Warn 'worker (the UTM guests use one called `witness`) and re-provision under it.'
  Warn 'AS IT STANDS THIS WORKER WILL NOT COME BACK AFTER A REBOOT.'
} elseif ($localUser.PrincipalSource -and $localUser.PrincipalSource -ne 'Local') {
  Warn "'$env:USERNAME' is a $($localUser.PrincipalSource) account, not Local -- auto-logon NOT configured."
  Warn 'AS IT STANDS THIS WORKER WILL NOT COME BACK AFTER A REBOOT.'
} else {
  try {
    # An empty SecureString IS the blank password; there is no separate "clear" verb.
    Set-LocalUser -Name $env:USERNAME -Password (New-Object System.Security.SecureString) -ErrorAction Stop
    # Never expires: a worker that stops logging in because a password aged out is the same
    # outage arriving on a timer.
    Set-LocalUser -Name $env:USERNAME -PasswordNeverExpires $true -ErrorAction SilentlyContinue

    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty $winlogon -Name AutoAdminLogon  -Value '1'               -Type String -Force
    Set-ItemProperty $winlogon -Name DefaultUserName -Value $env:USERNAME     -Type String -Force
    Set-ItemProperty $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME -Type String -Force
    # Any leftover DefaultPassword would be world-readable plaintext, and AutoLogonCount makes
    # auto-logon one-shot -- it decrements to zero and then the box silently stops coming back.
    foreach ($dead in @('DefaultPassword', 'AutoLogonCount')) {
      Remove-ItemProperty $winlogon -Name $dead -ErrorAction SilentlyContinue
    }

    # Verify by the MARKS Winlogon actually reads, not by the absence of an exception.
    $w = Get-ItemProperty $winlogon -ErrorAction Stop
    if ("$($w.AutoAdminLogon)" -ne '1')        { throw "AutoAdminLogon is '$($w.AutoAdminLogon)', not 1" }
    if ("$($w.DefaultUserName)" -ne "$env:USERNAME") { throw "DefaultUserName is '$($w.DefaultUserName)'" }
    if ($w.PSObject.Properties.Name -contains 'DefaultPassword') { throw 'DefaultPassword still present' }
    OK "auto-logon enabled for $env:USERNAME with NO stored credential"

    # The guard that makes a blank password narrow rather than wide. 1 (or absent, which defaults
    # to 1) confines the account to console logon. If somebody has set it to 0, say so loudly --
    # that combination really would be a blank-password account reachable over the network.
    $lanman = 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa'
    $limit = (Get-ItemProperty $lanman -Name LimitBlankPasswordUse -ErrorAction SilentlyContinue).LimitBlankPasswordUse
    if ($null -eq $limit -or "$limit" -eq '1') {
      OK 'LimitBlankPasswordUse is on: this account cannot be used over the network'
    } else {
      Warn "LimitBlankPasswordUse is $limit -- a blank-password account IS reachable over the network."
      Warn 'Set it back to 1 unless you know why it was changed.'
    }
    Warn 'This box now boots to an UNLOCKED desktop. Correct for a lab worker on its own segment; not for anything else.'
  } catch {
    Warn "auto-logon setup failed ($($_.Exception.Message))"
    Warn 'AS IT STANDS THIS WORKER WILL NOT COME BACK AFTER A REBOOT.'
  }
}

# ---------------------------------------------------------------------------
Step 9 'Start and verify'

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskName
# Both waits below are POLLED CONDITIONS with a budget, not fixed counts. They were 20s for
# the port and a single 10s request for /health, and both are too short on a cold box -- so
# provisioning reported failure on a worker that had actually come up fine.
$LISTEN_BUDGET_S = 90    # node start + module load on a cold, unwarmed filesystem
$HEALTH_BUDGET_S = 240   # see below
$HEALTH_ATTEMPT_S = 30
$POLL_S = 2

$listenDeadline = (Get-Date).AddSeconds($LISTEN_BUDGET_S)
while (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -and
       (Get-Date) -lt $listenDeadline) {
  Start-Sleep -Seconds $POLL_S
}
if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  throw "Worker did not listen on $Port within ${LISTEN_BUDGET_S}s. Check $RepoPath\server.log."
}
OK "listening on $Port"

# The FIRST /health triggers NVDA's warm-up, and a cold NVDA start is ~19s -- with the worker's
# own retry policy (3 attempts, 30s apart) the honest worst case is well over two minutes. A
# single 10s request therefore timed out against a HEALTHY worker and reported "operation
# timed out", which reads like a broken guest.
#
# The deadline must exceed the slowest honest answer, or "not ready yet" and "broken" become
# the same observation -- the same rule the capture path follows for silence.
$health = $null
$healthDeadline = (Get-Date).AddSeconds($HEALTH_BUDGET_S)
$lastErr = 'never attempted'
while (-not $health -and (Get-Date) -lt $healthDeadline) {
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec $HEALTH_ATTEMPT_S }
  catch { $lastErr = $_.Exception.Message; Start-Sleep -Seconds $POLL_S }
}
if (-not $health) { throw "/health did not answer within ${HEALTH_BUDGET_S}s (last error: $lastErr)" }
OK "/health -> ok=$($health.ok) ready=$($health.readiness.ready) screenReader=$($health.screenReader)"

# ready:false immediately after a boot is NORMAL and self-correcting -- it means "not yet",
# not "broken", and each pool worker waits for its own before taking work. Failing provisioning
# on it would sideline a healthy guest over an optimisation it does not need.
if (-not $health.readiness.ready) {
  Warn "not ready yet: $($health.readiness.reason). This is normal right after a boot and clears on its own."
}

# ---------------------------------------------------------------------------
Write-Host "`n--- Provisioning complete ---" -ForegroundColor Cyan
if ($script:warnings.Count) {
  Write-Host "$($script:warnings.Count) warning(s):" -ForegroundColor Yellow
  $script:warnings | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}

Write-Host @"

Next steps this script deliberately does NOT do:

  1. VERIFY IT SURVIVES A REBOOT. Auto-logon is configured above, with no stored
     credential -- but "it works now" says nothing about whether it comes back, and
     every box in a fleet restarts. Reboot this one and watch /health answer on its
     own before you call it provisioned.

  2. Prove capture end-to-end. From the control machine:
         curl http://<this-host>:$Port/health
         node packages/lab/src/harnesses/capture-check.mjs   # on THIS box, in the console session

  3. Diagnose a broken worker: packages/worker-fleet/src/provisioning/diagnose-nvda-worker.ps1
"@
