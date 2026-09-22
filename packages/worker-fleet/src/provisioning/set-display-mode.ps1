# Pin the display mode (width x height) the fleet's capture window holds, and prove it landed.
#
# #1567/#1819: originally a `win_powershell` task, run directly over the SSH connection Ansible uses.
# EnumDisplaySettings failed there -- `ok=0` even as the console-session `witness` account, not only under
# `become`/SYSTEM -- because an OpenSSH-spawned PowerShell child does not attach to the interactive window
# station the console session's desktop uses, the same "SSH has no interactive desktop" fact
# `tasks/run-interactive.yml`'s header already names for `SystemParametersInfo` and guidepup. That move
# was NECESSARY and it stands; this script is still called through the interactive one-shot task.
#
# ## #1955: it was necessary and it was not SUFFICIENT, and this is the part that was missing
#
# Run through `run-interactive.yml` against the real fleet on 2026-09-22 it failed identically on 10 of 10
# workers. Measured on a11y-worker-2 (orchestrator, 2026-09-22T18:58Z), the interactive route is provably
# doing its job -- `sessionId=1`, `windowStation='WinSta0'`, `desktop='Default'`, and
# `GetSystemMetrics` reporting `screen=1024x768 monitors=1`. The desktop has a display. The call still
# failed. So the fault was never the session, and #1833 did not miss.
#
# The fault is THE DEVICE ARGUMENT. Measured on the same box, in the same interactive task, seconds apart:
#
#     EnumDisplaySettingsW($null,         ENUM_CURRENT_SETTINGS) -> False,  mode 0x0
#     EnumDisplaySettingsW('\\.\DISPLAY1', ENUM_CURRENT_SETTINGS) -> True,   mode 1024x768
#     EnumDisplayDevicesA($null, 0) -> False        EnumDisplayDevicesW($null, 0) -> False
#     GetDC(null) + GetDeviceCaps      -> HORZRES=1024 VERTRES=768 BITSPIXEL=32
#     Screen.AllScreens                -> '\\.\DISPLAY1' 1024x768 primary
#
# THOSE FIVE READINGS, AND NO MORE THAN THOSE FIVE -- and READ WHAT `$null` IN THEM ACTUALLY SENT, because
# it is not what it says. PowerShell converts `$null` to `[string]::Empty` when it binds a `string`
# parameter; only `[NullString]::Value` sends a genuine NULL. Measured under pwsh 7.6.6 against a C#
# `s == null` probe, not reasoned: literal `$null` and a variable holding `$null` both arrive as
# "not-null, length 0", and `[NullString]::Value` arrives as NULL. So every line above that reads `$null`
# passed a device NAMED `""` -- and no display device is called that, on this fleet or anywhere else.
#
# WHICH MAKES THE CHEAPER EXPLANATION THE RIGHT ONE, and #1968's first telling of this file got it wrong.
# The ten-host failure was `EnumDisplaySettings($null, ...)` in this script's previous version: a
# PowerShell binding trap, refused by any Windows box, not a property of these workers. What the readings
# above do establish is narrower and still enough to act on: an EMPTY-named call refuses and a call naming
# `\\.\DISPLAY1` answers. They establish NOTHING about a real NULL device, because no call in the list
# ever passed one.
#
# THE FIX IS THEREFORE TO STOP ASKING FOR "the default device" AND TO NAME ONE -- unchanged by the above,
# and the reading that shows it working (worker-7, below) is unaffected. The primary display's device name
# comes from `MonitorFromPoint` + `GetMonitorInfoW`, and it is passed to `EnumDisplaySettingsW` and
# `ChangeDisplaySettingsExW`. `ChangeDisplaySettings` (no `Ex`) cannot take a device name at all, which is
# why it is gone.
#
# The diagnostic's own nameless arm now passes `[NullString]::Value`, so the NEXT fleet run is the first
# reading that has ever actually asked the NULL question. Until one comes back, this file claims the
# empty-name finding and no more.
#
# That the lookup path runs here is a READING too, not an assumption. With this script in place on
# a11y-worker-7 (orchestrator, 2026-09-22T19:07Z) it printed
# `context: current mode reads 640 x 480 on '\\.\DISPLAY1'`, and the name in that line is precisely what
# `MonitorFromPoint` + `GetMonitorInfoW` returned -- so both ran and both answered. Neither of them takes a
# device name, so neither is evidence about NULL-versus-named; they are the way OUT of that question.
#
# ## Why the context block prints on every run
#
# The failure this row exists for returned ONE sentence -- `EnumDisplaySettings could not read the current
# display mode` -- and that sentence could not tell apart (1) the task landed in session 0 after all,
# (2) it landed in session 1 but on a desktop with no display, and (3) it reached the right desktop and
# the call refused anyway. Three causes, three files, one sentence: a fleet play that cannot separate them
# buys nothing, and today's cost a full ten-host run for exactly that. The block prints on success too,
# because a passing reading and a failing one are only comparable if they report the same fields.
#
# `SetLastError = true` is on the P/Invokes, but READ THE ERROR CODES WITH SUSPICION and the script says so
# where it prints them: none of these functions is documented to call SetLastError on failure, and measured
# here `203` (ERROR_ENVVAR_NOT_FOUND) came back from the FAILING calls and from the SUCCEEDING one alike.
# It is a stale value from an unrelated call, which makes it exactly the shape of evidence this repo is
# most wary of -- a number that looks like a finding and is not.
#
# Config comes from the environment rather than param(), matching diagnose-nvda-worker.ps1's reasoning --
# the caller is a single templated Ansible string either way, and an env assignment ahead of the call
# avoids one more layer of quoting inside `run-interactive.yml`'s already-quoted -Command string:
#   A11Y_DISPLAY_WIDTH, A11Y_DISPLAY_HEIGHT
#
# Losing check-mode support is the real trade here: the old `win_powershell` task honoured
# `ansible-playbook --check`; a scheduled task run through `run-interactive.yml` does not, the same as
# every other interactive step in this role (`provision.yml`'s call into provision-nvda-worker.ps1).

$ErrorActionPreference = 'Stop'

$Width = [int] $env:A11Y_DISPLAY_WIDTH
$Height = [int] $env:A11Y_DISPLAY_HEIGHT
if ($Width -le 0 -or $Height -le 0) {
  Write-Output "A11Y_DISPLAY_WIDTH/A11Y_DISPLAY_HEIGHT must both be positive integers, got $Width x $Height"
  exit 1
}

if (-not ('A11yDisplay.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition '
    using System;
    using System.Runtime.InteropServices;
    using System.Text;
    namespace A11yDisplay {
      // DEVMODEW. The Unicode form is deliberate: the measured working call on the fleet is
      // EnumDisplaySettingsW with a named device, so the whole path is W rather than a mix.
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
      }
      [StructLayout(LayoutKind.Sequential)]
      public struct RECT { public int left; public int top; public int right; public int bottom; }
      [StructLayout(LayoutKind.Sequential)]
      public struct POINT { public int x; public int y; }
      // MONITORINFOEXW: MONITORINFO plus szDevice, the `\\.\DISPLAYn` name this script exists to obtain.
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
      }
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct DISPLAY_DEVICE {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
      }
      public class NativeMethods {
        [DllImport("user32.dll", EntryPoint = "EnumDisplaySettingsW", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
        [DllImport("user32.dll", EntryPoint = "ChangeDisplaySettingsExW", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE devMode, IntPtr window, int flags, IntPtr param);
        [DllImport("user32.dll", EntryPoint = "EnumDisplayDevicesW", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool EnumDisplayDevices(string device, int devNum, ref DISPLAY_DEVICE info, int flags);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr MonitorFromPoint(POINT pt, int flags);
        [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetThreadDesktop(int threadId);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int lengthNeeded);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern int GetSystemMetrics(int index);
        [DllImport("kernel32.dll")]
        public static extern int GetCurrentThreadId();
      }
    }
  '
}

$ENUM_CURRENT_SETTINGS = -1
$DM_PELSWIDTH = 0x00080000
$DM_PELSHEIGHT = 0x00100000
$CDS_UPDATEREGISTRY = 0x01
$DISP_CHANGE_SUCCESSFUL = 0
$MONITOR_DEFAULTTOPRIMARY = 1
$UOI_NAME = 2
$USER_OBJECT_NAME_CHARS = 256
$SM_CXSCREEN = 0
$SM_CYSCREEN = 1
$SM_CMONITORS = 80

# Printed beside every result and trusted by nobody -- see this file's header on why `203` came back from
# the failing calls and the succeeding one alike.
function Get-LastWin32Error {
  [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

# The NAME of a window station or desktop HANDLE. Reported rather than inferred: "is this the interactive
# desktop" is one of the three cases the old one-line failure could not answer, and `WinSta0` + `Default`
# is what rules it out.
function Get-UserObjectName {
  param([IntPtr] $Handle)
  if ($Handle -eq [IntPtr]::Zero) {
    return "(null handle, Win32 $(Get-LastWin32Error))"
  }
  $name = New-Object System.Text.StringBuilder $USER_OBJECT_NAME_CHARS
  $needed = 0
  if ([A11yDisplay.NativeMethods]::GetUserObjectInformation(
      $Handle, $UOI_NAME, $name, $name.Capacity, [ref] $needed)) {
    return $name.ToString()
  }
  return "(unreadable, Win32 $(Get-LastWin32Error))"
}

# THE FIX, and the one line in this script that had to change. `$null` means "whatever the system
# considers the default display device", and on this fleet that question has no answer -- every NULL-device
# GDI call refuses while every named one answers. MonitorFromPoint(0,0, DEFAULTTOPRIMARY) names the
# primary monitor and GetMonitorInfoW reads its `\\.\DISPLAYn` back.
#
# Returns $null on failure rather than throwing, so the caller can print the whole context block before
# giving up -- a refusal that reports nothing is what made the previous failure unrepeatable.
#
# IT PRINTS NOTHING, and says why it failed through `[ref] $Reason` instead. In PowerShell everything a
# function writes JOINS ITS RETURN VALUE, so an earlier draft's `Write-Output` on the failure path came
# back to the caller AS the device name: `$deviceName` held the diagnostic sentence, `-not $deviceName`
# was false, the script never took its own failure branch, and the message was never printed either. A
# function that both reports and returns can do neither here.
function Get-PrimaryDisplayName {
  param([ref] $Reason)
  $origin = New-Object A11yDisplay.POINT
  $origin.x = 0
  $origin.y = 0
  $monitor = [A11yDisplay.NativeMethods]::MonitorFromPoint($origin, $MONITOR_DEFAULTTOPRIMARY)
  if ($monitor -eq [IntPtr]::Zero) {
    $Reason.Value = "MonitorFromPoint found no primary monitor, last Win32 $(Get-LastWin32Error) -- unreliable"
    return $null
  }
  $info = New-Object A11yDisplay.MONITORINFOEX
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [A11yDisplay.NativeMethods]::GetMonitorInfo($monitor, [ref] $info)) {
    $Reason.Value = "GetMonitorInfo refused for monitor $monitor, last Win32 $(Get-LastWin32Error) -- unreliable"
    return $null
  }
  return $info.szDevice
}

# One pass of `EnumDisplayDevices` over `$Device`. A NULL device enumerates the ADAPTERS on this desktop;
# a `\\.\DISPLAYn` name enumerates the MONITORS on that adapter.
#
# The formatted lines come back through `[ref] $Lines` and THE COUNT IS THE RETURN VALUE, an int. Both
# halves of that shape are reviewer-2's blocker on #1968 at `a58c7e44`, and the defect it replaces was
# worse than the report: this function used to `return ,$lines` while the caller counted
# `@(Get-EnumeratedDevices ...)`. PowerShell's unary comma deliberately emits the collection as ONE
# pipeline object, `@()` collects that single object, and `.Count` was therefore **1 for every
# population**. Measured under pwsh 7.6.6, not reasoned: 0 lines -> 1, 1 line -> 1, 3 lines -> 1. So the
# caller's `if ($adapters.Count -gt 0)` was taken on every run, the named same-API control NEVER
# executed, and an empty enumeration reported `enumerated 1 adapter(s)` -- a count of the wrapper,
# printed as a count of devices, in exactly the case the control exists to separate.
#
# A COUNT MUST NOT CROSS A FUNCTION BOUNDARY AS A COLLECTION. An int cannot be unrolled, re-wrapped or
# collected, so the shape that produced this defect cannot be spelled here again; the lines take the
# `[ref]` route `Get-PrimaryDisplayName` already uses for the same PowerShell reason. `display-mode.test.ts`
# runs this pair under a real PowerShell against a stubbed API and reads the count off the output, because
# no assertion over the script's TEXT can tell "the control is written" from "the control ran".
#
# `$Device` is deliberately untyped, AND THAT IS NOT ENOUGH ON ITS OWN. `[string] $Device` would coerce
# `$null` to the empty string at the PowerShell parameter -- but so does the .NET method binding one line
# further down, whatever this parameter is declared as, which is the trap this file's header now records.
# The caller therefore hands in `[NullString]::Value` rather than `$null`, and it survives an untyped
# parameter unchanged (measured, same probe). `""` is a different argument to this API than NULL, and
# telling the two apart is the one distinction this whole script turns on.
function Get-EnumeratedDevices {
  param($Device, [string] $Label, [ref] $Lines)
  $found = @()
  $info = New-Object A11yDisplay.DISPLAY_DEVICE
  $index = 0
  while ($true) {
    $info.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [A11yDisplay.NativeMethods]::EnumDisplayDevices($Device, $index, [ref] $info, 0)) {
      break
    }
    $flags = '0x{0:X8}' -f $info.StateFlags
    $found += "context: $Label[$index] name='$($info.DeviceName)' adapter='$($info.DeviceString)' stateFlags=$flags (cb=$($info.cb))"
    $index++
  }
  $Lines.Value = $found
  return $found.Count
}

# Every display DEVICE this process can enumerate -- and, when that comes back empty, THE SAME API ASKED
# AGAIN WITH A NAME. Kept although nothing depends on it any more: it is the block that measures whether
# a nameless call works on this fleet, a question no reading has actually answered yet (every earlier one
# asked about `""`), and a future run where it starts answering is a real change this is the only thing
# that would show.
#
# THE CONTROL IS THE POINT, and it is reviewer-2's blocker on #1968. `EnumDisplayDevices(NULL, 0)`
# returning False at index 0 is TWO findings wearing one face -- "this desktop has no display adapters"
# and "this function refuses every nameless call here, exactly as EnumDisplaySettings does" -- and an
# empty population that cannot tell them apart is the shape this repository refuses everywhere else.
# `Screen.AllScreens` and the named `EnumDisplaySettingsW` are a DIFFERENT API answering a different
# question, so neither settles it. The control therefore has to be THIS function with a device name: if it
# answers, the empty NULL population is about the ARGUMENT; if it refuses too, the reading is about the
# function instead, and the script says so rather than claiming the stronger of the two.
#
# The two counts below are the ints `Get-EnumeratedDevices` returns, cast with `[int]` at the assignment:
# that cast is the thing that makes a stray extra output object fail LOUDLY here rather than turn the
# count into a collection again, which is how the count stopped being the count in the first place.
function Write-DisplayDevices {
  param($PrimaryDevice)
  $adapterLines = @()
  [int] $adapters = Get-EnumeratedDevices -Device ([NullString]::Value) -Label 'device' -Lines ([ref] $adapterLines)
  $adapterLines | ForEach-Object { Write-Output $_ }
  if ($adapters -gt 0) {
    Write-Output "context: EnumDisplayDevices(NULL) enumerated $adapters adapter(s)"
    return
  }
  if (-not $PrimaryDevice) {
    Write-Output ("context: EnumDisplayDevices(NULL, 0) enumerated NOTHING and no NAMED control could be run" +
      " (no primary device name), so this reading cannot tell an absent display from a refused nameless call")
    return
  }
  $monitorLines = @()
  [int] $monitors = Get-EnumeratedDevices -Device $PrimaryDevice -Label 'monitor' -Lines ([ref] $monitorLines)
  $monitorLines | ForEach-Object { Write-Output $_ }
  if ($monitors -gt 0) {
    Write-Output ("context: EnumDisplayDevices(NULL, 0) enumerated NOTHING while the same call NAMED" +
      " '$PrimaryDevice' enumerated $monitors monitor(s) -- the function answers here, and it is" +
      " the NULL device that is refused")
  } else {
    Write-Output ("context: EnumDisplayDevices enumerated NOTHING for NULL AND for the NAMED control" +
      " '$PrimaryDevice' -- the control refused too, so this says nothing about the NULL device in" +
      " particular (last Win32 $(Get-LastWin32Error) -- unreliable)")
  }
}

# What the SESSION's desktop itself thinks it has, read through a call that takes no device name at all.
# This is the line that separates "this desktop has no display" from "this desktop has one and the call
# refused": on 2026-09-22 it reported a real screen while the enumeration reported none, and that
# disagreement is what pointed at the argument rather than at the environment.
function Write-ScreenMetrics {
  $width = [A11yDisplay.NativeMethods]::GetSystemMetrics($SM_CXSCREEN)
  $height = [A11yDisplay.NativeMethods]::GetSystemMetrics($SM_CYSCREEN)
  $monitors = [A11yDisplay.NativeMethods]::GetSystemMetrics($SM_CMONITORS)
  Write-Output "context: GetSystemMetrics screen=${width}x${height} monitors=$monitors"
}

function Write-DisplayContext {
  param($PrimaryDevice)
  $process = [System.Diagnostics.Process]::GetCurrentProcess()
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  Write-Output "context: sessionId=$($process.SessionId) pid=$($process.Id) user=$($identity.Name)"
  $station = [A11yDisplay.NativeMethods]::GetProcessWindowStation()
  $threadId = [A11yDisplay.NativeMethods]::GetCurrentThreadId()
  $desktop = [A11yDisplay.NativeMethods]::GetThreadDesktop($threadId)
  Write-Output "context: windowStation='$(Get-UserObjectName $station)' desktop='$(Get-UserObjectName $desktop)'"
  Write-ScreenMetrics
  Write-DisplayDevices -PrimaryDevice $PrimaryDevice
}

# The name is resolved BEFORE the context block rather than after it, because the block's device
# enumeration needs it for its control. Resolution prints nothing of its own, so a failure here still
# reports through the same block below, in the same order, on a failing run and a passing one alike.
$nameRefusal = $null
$deviceName = Get-PrimaryDisplayName -Reason ([ref] $nameRefusal)
if ($nameRefusal) {
  Write-Output "context: $nameRefusal"
}
Write-DisplayContext -PrimaryDevice $deviceName

if (-not $deviceName) {
  Write-Output 'no primary display device could be named, so there is nothing to set the mode on'
  exit 1
}
Write-Output "context: primary display device='$deviceName' wanted=$Width x $Height"

$mode = New-Object A11yDisplay.DEVMODE
$mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mode)
if (-not [A11yDisplay.NativeMethods]::EnumDisplaySettings($deviceName, $ENUM_CURRENT_SETTINGS, [ref] $mode)) {
  Write-Output "EnumDisplaySettings could not read the current display mode of '$deviceName' (dmSize $($mode.dmSize), last Win32 $(Get-LastWin32Error) -- unreliable)"
  exit 1
}

Write-Output "context: current mode reads $($mode.dmPelsWidth) x $($mode.dmPelsHeight) on '$deviceName'"

if ($mode.dmPelsWidth -eq $Width -and $mode.dmPelsHeight -eq $Height) {
  Write-Output "already $Width x $Height"
  exit 0
}

$mode.dmPelsWidth = $Width
$mode.dmPelsHeight = $Height
$mode.dmFields = $DM_PELSWIDTH -bor $DM_PELSHEIGHT
$result = [A11yDisplay.NativeMethods]::ChangeDisplaySettingsEx(
  $deviceName, [ref] $mode, [IntPtr]::Zero, $CDS_UPDATEREGISTRY, [IntPtr]::Zero)
if ($result -ne $DISP_CHANGE_SUCCESSFUL) {
  Write-Output "ChangeDisplaySettingsEx returned $result (wanted $DISP_CHANGE_SUCCESSFUL) setting $Width x $Height on '$deviceName'"
  exit 1
}

# PROVE IT, IN THE SAME PROCESS THAT JUST WROTE IT -- the same "read back or it didn't happen" rule
# policy.yml's own trailing verify task follows.
$after = New-Object A11yDisplay.DEVMODE
$after.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($after)
[void][A11yDisplay.NativeMethods]::EnumDisplaySettings($deviceName, $ENUM_CURRENT_SETTINGS, [ref] $after)
if ($after.dmPelsWidth -ne $Width -or $after.dmPelsHeight -ne $Height) {
  Write-Output "ChangeDisplaySettingsEx reported success but the mode reads $($after.dmPelsWidth) x $($after.dmPelsHeight) back, not $Width x $Height"
  exit 1
}

Write-Output "set to $Width x $Height"
exit 0
