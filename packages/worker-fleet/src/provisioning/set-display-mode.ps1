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
# The fault is THE NULL DEVICE NAME. Measured on the same box, in the same interactive task, seconds apart:
#
#     EnumDisplaySettingsW($null,         ENUM_CURRENT_SETTINGS) -> False,  mode 0x0
#     EnumDisplaySettingsW('\\.\DISPLAY1', ENUM_CURRENT_SETTINGS) -> True,   mode 1024x768
#     EnumDisplayDevicesA($null, 0) -> False        EnumDisplayDevicesW($null, 0) -> False
#     GetDC(null) + GetDeviceCaps      -> HORZRES=1024 VERTRES=768 BITSPIXEL=32
#     Screen.AllScreens                -> '\\.\DISPLAY1' 1024x768 primary
#
# Every call that NAMES the device answers; every call that passes NULL and asks the system to pick the
# default device refuses, ANSI and Unicode alike. So the adapter, the monitor, the driver, the struct
# layout (`dmSize` 156 ANSI / 188 Unicode, `cb` 424 -- all correct) and the session were never the defect,
# and each of those was the cheaper explanation that had to be ruled out first.
#
# THE FIX IS THEREFORE TO STOP ASKING FOR "the default device" AND TO NAME ONE. The primary display's
# device name comes from `MonitorFromPoint` + `GetMonitorInfoW`, which is the path that works here, and it
# is passed to `EnumDisplaySettingsW` and `ChangeDisplaySettingsExW`. `ChangeDisplaySettings` (no `Ex`)
# cannot take a device name at all, which is why it is gone.
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
function Get-PrimaryDisplayName {
  $origin = New-Object A11yDisplay.POINT
  $origin.x = 0
  $origin.y = 0
  $monitor = [A11yDisplay.NativeMethods]::MonitorFromPoint($origin, $MONITOR_DEFAULTTOPRIMARY)
  if ($monitor -eq [IntPtr]::Zero) {
    Write-Output "context: MonitorFromPoint found no primary monitor, last Win32 $(Get-LastWin32Error)"
    return $null
  }
  $info = New-Object A11yDisplay.MONITORINFOEX
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [A11yDisplay.NativeMethods]::GetMonitorInfo($monitor, [ref] $info)) {
    Write-Output "context: GetMonitorInfo refused for monitor $monitor, last Win32 $(Get-LastWin32Error)"
    return $null
  }
  return $info.szDevice
}

# Every display DEVICE this process can enumerate. Kept although nothing depends on it any more: it is the
# measurement that named the defect, and a future run where it starts answering is a real change in the
# fleet that this block is the only thing that would show.
function Write-DisplayDevices {
  $device = New-Object A11yDisplay.DISPLAY_DEVICE
  $index = 0
  while ($true) {
    $device.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($device)
    if (-not [A11yDisplay.NativeMethods]::EnumDisplayDevices($null, $index, [ref] $device, 0)) {
      break
    }
    $flags = '0x{0:X8}' -f $device.StateFlags
    Write-Output "context: device[$index] name='$($device.DeviceName)' adapter='$($device.DeviceString)' stateFlags=$flags"
    $index++
  }
  if ($index -eq 0) {
    Write-Output "context: EnumDisplayDevices(null, 0) enumerated NOTHING (cb=$($device.cb), last Win32 $(Get-LastWin32Error) -- unreliable)"
  } else {
    Write-Output "context: EnumDisplayDevices enumerated $index device(s) (cb=$($device.cb))"
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
  $process = [System.Diagnostics.Process]::GetCurrentProcess()
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  Write-Output "context: sessionId=$($process.SessionId) pid=$($process.Id) user=$($identity.Name)"
  $station = [A11yDisplay.NativeMethods]::GetProcessWindowStation()
  $threadId = [A11yDisplay.NativeMethods]::GetCurrentThreadId()
  $desktop = [A11yDisplay.NativeMethods]::GetThreadDesktop($threadId)
  Write-Output "context: windowStation='$(Get-UserObjectName $station)' desktop='$(Get-UserObjectName $desktop)'"
  Write-ScreenMetrics
  Write-DisplayDevices
}

Write-DisplayContext

$deviceName = Get-PrimaryDisplayName
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
