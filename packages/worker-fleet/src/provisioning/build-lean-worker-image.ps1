<#
.SYNOPSIS
  Build a Windows 11 image with Defender and unused components removed, keeping everything a capture
  guest needs. Modelled on nano11builder's technique; none of its choices.

.DESCRIPTION
  Why this exists, in one number: Defender's MsMpEng is ~259 MB resident on a guest that commits
  ~1,859 MB, and it is the ONLY remaining item that cannot be dealt with on a running system. Measured
  on this fleet, as NT AUTHORITY\SYSTEM, all three routes fail:

    Set-MpPreference -DisableRealtimeMonitoring   accepted, then silently reverted
    WinDefend\Start = 4                           ERROR: Access is denied
    Policies\...\DisableAntiSpyware = 1           writes fine, and Windows ignores it while TP is on

  Tamper Protection is a RUNTIME guard, so offline is not a workaround, it is the supported way: with
  nothing booted there is no driver defending the hive, and it is just a file.

  IMPORTANT, and it changes what this script can do: `Get-WindowsPackage -Online` on this ARM64 image
  returns NO Defender package. tiny11 removes `Windows-Defender-Client-Package~31bf3856ad364e35~` on
  x64 22621; there is no equivalent here, so DISM package REMOVAL cannot take Defender out offline
  either. The offline SYSTEM-hive service disable below is the mechanism that actually works. The
  feature-package loop still tries, because a future x64 image will have the package and removing it is
  strictly better than disabling it.

  Everything else that could be trimmed already has been, from the running guest, by
  src/capture/nvda/windows-trim.mjs. That yielded ~60 MB, because this ARM64 image ships with exactly
  three provisioned Appx packages (Edge, DevHome, CrossDevice) and none of nano11's targets.

.NOTES
  WHERE THIS RUNS
  It needs DISM, so it runs on Windows, elevated -- in practice on one of the capture guests, driven
  through `utmctl exec`, which runs as SYSTEM. It cannot run on the Mac.

  WHAT IT DELIBERATELY KEEPS, AND WHY THAT MATTERS MORE THAN WHAT IT REMOVES
  nano11builder and tiny11builder both delete Microsoft Edge and the LanguageFeatures Speech and
  TextToSpeech packages. Those are the browser we capture through and the `oneCore` synth NVDA is
  configured to use. An image without them does not fail loudly -- it produces empty transcripts that
  look exactly like the NVDA mute faults this project has already spent days chasing. So the keep-list
  is asserted before the image is committed, and the build FAILS rather than shipping a silent guest.

  ARCHITECTURE
  nano11builder hardcodes `amd64~~10.0.22621.1265` into package names, which is why it is x64-only.
  These guests are ARM64. Every package name here is queried from the mounted image instead.

  NO /ResetBase
  tiny11's core variant runs `/Cleanup-Image /StartComponentCleanup /ResetBase` and deletes WinSxS
  down to an allow-list. That is most of its disk saving and NONE of its memory saving -- WinSxS is a
  component store on disk, not resident memory -- and it leaves an image that can never take a driver,
  feature or update again. Our constraint is RAM. Skipped by default; -ResetBase if you ever need disk.
#>
[CmdletBinding()]
param(
  # Drive letter of a mounted Windows 11 ISO, e.g. 'E'.
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z]$')][string] $SourceDrive,
  [string] $WorkDir  = 'C:\lean11',
  [string] $OutputIso = 'C:\lean11.iso',
  [int]    $ImageIndex = 0,          # 0 = pick the Pro edition automatically
  [switch] $ResetBase,               # see NOTES: disk only, and makes the image unserviceable
  [switch] $KeepMounted              # leave the image mounted for inspection instead of committing
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function OK($m)   { Write-Host "    OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    WARN $m" -ForegroundColor Yellow }

# --- what must survive, and what may go -------------------------------------

# Asserted present after every removal. The build fails if any of these vanish, because a guest that
# cannot run Edge or speak is indistinguishable from the mute faults we already chase.
$MustKeepPatterns = @(
  'LanguageFeatures-Speech',        # NVDA's oneCore synth
  'LanguageFeatures-TextToSpeech'
)
$MustKeepPaths = @(
  'Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
)

# Feature packages safe to remove. Speech, TextToSpeech and anything Edge are absent BY DESIGN.
$RemovableFeaturePatterns = @(
  'Microsoft-Windows-InternetExplorer-Optional-Package',
  'Microsoft-Windows-MediaPlayer-Package',
  'Microsoft-Windows-WordPad-FoD-Package',
  'Microsoft-Windows-StepsRecorder-Package',
  'Microsoft-Windows-TabletPCMath-Package',
  'Microsoft-Windows-Wallpaper-Content-Extended-FoD-Package',
  'Microsoft-Windows-LanguageFeatures-Handwriting',
  'Microsoft-Windows-LanguageFeatures-OCR',
  # The reason this script exists. Removable offline only.
  'Windows-Defender-Client-Package'
)

# Provisioned Appx. Kept in sync with src/capture/nvda/windows-trim.mjs, which has the unit tests
# proving Edge and the speech stack can never appear in a removal set.
$RemovableAppxPrefixes = @(
  'Clipchamp.Clipchamp', 'Microsoft.BingNews', 'Microsoft.BingWeather', 'Microsoft.GamingApp',
  'Microsoft.GetHelp', 'Microsoft.Getstarted', 'Microsoft.MicrosoftOfficeHub',
  'Microsoft.MicrosoftSolitaireCollection', 'Microsoft.People', 'Microsoft.PowerAutomateDesktop',
  'Microsoft.Todos', 'Microsoft.WindowsAlarms', 'microsoft.windowscommunicationsapps',
  'Microsoft.WindowsFeedbackHub', 'Microsoft.WindowsMaps', 'Microsoft.WindowsSoundRecorder',
  'Microsoft.Xbox.TCUI', 'Microsoft.XboxGameOverlay', 'Microsoft.XboxGamingOverlay',
  'Microsoft.YourPhone', 'Microsoft.ZuneMusic', 'Microsoft.ZuneVideo',
  'MicrosoftCorporationII.MicrosoftFamily', 'MicrosoftCorporationII.QuickAssist',
  'MicrosoftTeams', 'MSTeams', 'Microsoft.Windows.Copilot', 'Microsoft.Copilot',
  'Microsoft.OutlookForWindows', 'Microsoft.549981C3F5F10',
  'Microsoft.Windows.DevHome', 'MicrosoftWindows.CrossDevice'
)

# Anything matching these is never removed, whatever the lists above say. Deliberately blunter than it
# needs to be: leaving a few MB of Xbox speech-to-text captioning behind is the right price for a rule
# that cannot take out NVDA's synth.
$NeverRemovePatterns = @(
  'edge', 'webview', 'speech', 'texttospeech', 'onecore', 'narrator', 'accessib',
  'uiautomation', 'dotnet', 'netfx', 'vclibs', 'ui.xaml', 'runtime', 'servicingstack'
)

function Test-NeverRemove([string] $name) {
  foreach ($p in $NeverRemovePatterns) { if ($name -match [regex]::Escape($p)) { return $true } }
  return $false
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Must run elevated. DISM offline servicing needs it, as does every removal below.'
}

$mount = Join-Path $WorkDir 'mount'
$src   = "${SourceDrive}:"
if (-not (Test-Path "$src\sources")) { throw "No \sources on ${src} -- is the ISO mounted?" }

# --- copy and mount ----------------------------------------------------------

Step "Copying $src to $WorkDir"
New-Item -ItemType Directory -Force -Path $WorkDir, $mount | Out-Null
Copy-Item -Path "$src\*" -Destination $WorkDir -Recurse -Force
$wim = Join-Path $WorkDir 'sources\install.wim'
if (-not (Test-Path $wim)) {
  $esd = Join-Path $WorkDir 'sources\install.esd'
  if (-not (Test-Path $esd)) { throw 'Neither install.wim nor install.esd found in sources.' }
  Step 'Converting install.esd to install.wim'
  $idx = if ($ImageIndex -gt 0) { $ImageIndex } else {
    (Get-WindowsImage -ImagePath $esd | Where-Object ImageName -match 'Pro' |
      Select-Object -First 1).ImageIndex
  }
  & dism /English /Export-Image /SourceImageFile:$esd /SourceIndex:$idx `
         /DestinationImageFile:$wim /Compress:max /CheckIntegrity
  Remove-Item $esd -Force
  $ImageIndex = 1
}
Set-ItemProperty $wim -Name IsReadOnly -Value $false

if ($ImageIndex -le 0) {
  $ImageIndex = (Get-WindowsImage -ImagePath $wim | Where-Object ImageName -match 'Pro' |
    Select-Object -First 1).ImageIndex
  if (-not $ImageIndex) { throw 'No Pro edition found; pass -ImageIndex explicitly.' }
}
OK "using image index $ImageIndex"

Step 'Mounting the image'
& dism /English /Mount-Image /ImageFile:$wim /Index:$ImageIndex /MountDir:$mount
if ($LASTEXITCODE -ne 0) { throw 'Mount-Image failed.' }

try {
  # --- removals, all queried from the image, never hardcoded ------------------

  Step 'Removing provisioned apps'
  $appx = Get-AppxProvisionedPackage -Path $mount
  foreach ($pkg in $appx) {
    $name = $pkg.PackageName
    if (Test-NeverRemove $name) { continue }
    if (-not ($RemovableAppxPrefixes | Where-Object { $name -like "$_*" })) { continue }
    try {
      Remove-AppxProvisionedPackage -Path $mount -PackageName $name -ErrorAction Stop | Out-Null
      OK "removed appx $($name.Split('_')[0])"
    } catch { Warn "could not remove $name : $($_.Exception.Message)" }
  }

  Step 'Removing feature packages (including Defender, which is the point)'
  $packages = Get-WindowsPackage -Path $mount
  foreach ($pattern in $RemovableFeaturePatterns) {
    foreach ($pkg in ($packages | Where-Object { $_.PackageName -like "$pattern*" })) {
      if (Test-NeverRemove $pkg.PackageName) { Warn "kept $($pkg.PackageName) (keep-list)"; continue }
      try {
        Remove-WindowsPackage -Path $mount -PackageName $pkg.PackageName -ErrorAction Stop | Out-Null
        OK "removed $($pkg.PackageName)"
      } catch { Warn "could not remove $($pkg.PackageName): $($_.Exception.Message)" }
    }
  }

  # Defender, disabled in the offline hives. Tamper Protection is a runtime guard and there is no
  # runtime here, which is the whole reason this step is in an image build and not in windows-trim.mjs.
  #
  # ORDER AND HIVE BOTH MATTER, and getting either wrong makes the whole step a no-op.
  # Tamper Protection is itself a registry value, and it lives in SOFTWARE, not SYSTEM:
  # `Microsoft\Windows Defender\Features\TamperProtection`. Disabling the services in SYSTEM while
  # leaving that flag armed means the guest boots with Tamper Protection active and reverts them --
  # which is exactly what happens on a live system, and would make this build look like it did nothing.
  # Clear the flag first, then the services.
  Step 'Disarming Tamper Protection in the offline SOFTWARE hive'
  & reg load HKLM\zSOFTWARE "$mount\Windows\System32\config\SOFTWARE" | Out-Null
  try {
    $features = 'HKLM:\zSOFTWARE\Microsoft\Windows Defender\Features'
    New-Item -Path $features -Force | Out-Null
    Set-ItemProperty $features -Name TamperProtection -Value 0 -Type DWord
    Set-ItemProperty $features -Name TamperProtectionSource -Value 0 -Type DWord -ErrorAction SilentlyContinue
    OK 'TamperProtection = 0'
    $policy = 'HKLM:\zSOFTWARE\Policies\Microsoft\Windows Defender'
    New-Item -Path $policy -Force | Out-Null
    Set-ItemProperty $policy -Name DisableAntiSpyware -Value 1 -Type DWord
    Set-ItemProperty $policy -Name DisableAntiVirus -Value 1 -Type DWord
    New-Item -Path "$policy\Real-Time Protection" -Force | Out-Null
    Set-ItemProperty "$policy\Real-Time Protection" -Name DisableRealtimeMonitoring -Value 1 -Type DWord
    OK 'DisableAntiSpyware / DisableRealtimeMonitoring policies set'
  } finally {
    # The GC call is not superstition: PowerShell keeps hive handles open and `reg unload` fails with
    # "Access is denied" while they live, leaving the image mounted with a loaded hive.
    [gc]::Collect(); [gc]::WaitForPendingFinalizers()
    & reg unload HKLM\zSOFTWARE | Out-Null
  }

  Step 'Disabling Defender services in the offline SYSTEM hive'
  & reg load HKLM\zSYSTEM "$mount\Windows\System32\config\SYSTEM" | Out-Null
  try {
    foreach ($svc in 'WinDefend', 'WdNisSvc', 'WdNisDrv', 'WdFilter', 'WdBoot', 'Sense') {
      $key = "HKLM:\zSYSTEM\ControlSet001\Services\$svc"
      if (Test-Path $key) { Set-ItemProperty $key -Name Start -Value 4; OK "$svc disabled" }
    }
  } finally {
    [gc]::Collect(); [gc]::WaitForPendingFinalizers()
    & reg unload HKLM\zSYSTEM | Out-Null
  }

  # --- the assertions that make this safe to ship -----------------------------

  Step 'Verifying the image can still capture'
  $after = Get-WindowsPackage -Path $mount
  foreach ($needed in $MustKeepPatterns) {
    if (-not ($after | Where-Object { $_.PackageName -like "*$needed*" })) {
      throw "FATAL: $needed is missing from the image. NVDA would be silent. Refusing to commit."
    }
    OK "$needed present"
  }
  foreach ($path in $MustKeepPaths) {
    if (-not (Test-Path (Join-Path $mount $path))) {
      throw "FATAL: $path is missing. There would be no browser to capture through. Refusing to commit."
    }
    OK "$path present"
  }

  if ($ResetBase) {
    Warn 'ResetBase: disk only, and the image can never be serviced again.'
    & dism /English /Image:$mount /Cleanup-Image /StartComponentCleanup /ResetBase
  }
} catch {
  Step 'Build failed -- discarding the mount so a broken image is never written'
  & dism /English /Unmount-Image /MountDir:$mount /Discard | Out-Null
  throw
}

if ($KeepMounted) { OK "left mounted at $mount for inspection"; return }

Step 'Committing and unmounting'
& dism /English /Unmount-Image /MountDir:$mount /Commit
if ($LASTEXITCODE -ne 0) { throw 'Unmount /Commit failed.' }

Step 'Building the ISO'
$oscdimg = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit' `
  -Recurse -Filter oscdimg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $oscdimg) {
  Warn "oscdimg.exe not found (install the Windows ADK). The serviced tree is at $WorkDir."
  return
}
$boot = "$WorkDir\efi\microsoft\boot\efisys.bin"
& $oscdimg.FullName -m -o -u2 -udfver102 -bootdata:"1#pEF,e,b$boot" $WorkDir $OutputIso
OK "wrote $OutputIso"
