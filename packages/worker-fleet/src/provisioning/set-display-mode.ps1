# Pin the display mode (width x height) the fleet's capture window holds, and prove it landed.
#
# #1567/#1819: originally a `win_powershell` task, run directly over the SSH connection Ansible uses.
# EnumDisplaySettings failed there -- `ok=0` even as the console-session `witness` account, not only under
# `become`/SYSTEM -- because an OpenSSH-spawned PowerShell child does not attach to the interactive window
# station the console session's desktop uses, the same "SSH has no interactive desktop" fact
# `tasks/run-interactive.yml`'s header already names for `SystemParametersInfo` and guidepup. GDI's
# EnumDisplaySettings/ChangeDisplaySettings need that same attached desktop, so this script exists to be
# called through that mechanism (a scheduled task with `logon_type: interactive_token`) instead of directly.
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
    namespace A11yDisplay {
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
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
      public class NativeMethods {
        [DllImport("user32.dll")]
        public static extern int EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
        [DllImport("user32.dll")]
        public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);
      }
    }
  '
}

$ENUM_CURRENT_SETTINGS = -1
$DM_PELSWIDTH = 0x00080000
$DM_PELSHEIGHT = 0x00100000
$CDS_UPDATEREGISTRY = 0x01
$DISP_CHANGE_SUCCESSFUL = 0

$mode = New-Object A11yDisplay.DEVMODE
$mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mode)
if (-not [A11yDisplay.NativeMethods]::EnumDisplaySettings($null, $ENUM_CURRENT_SETTINGS, [ref] $mode)) {
  Write-Output 'EnumDisplaySettings could not read the current display mode'
  exit 1
}

if ($mode.dmPelsWidth -eq $Width -and $mode.dmPelsHeight -eq $Height) {
  Write-Output "already $Width x $Height"
  exit 0
}

$mode.dmPelsWidth = $Width
$mode.dmPelsHeight = $Height
$mode.dmFields = $DM_PELSWIDTH -bor $DM_PELSHEIGHT
$result = [A11yDisplay.NativeMethods]::ChangeDisplaySettings([ref] $mode, $CDS_UPDATEREGISTRY)
if ($result -ne $DISP_CHANGE_SUCCESSFUL) {
  Write-Output "ChangeDisplaySettings returned $result (wanted $DISP_CHANGE_SUCCESSFUL) setting $Width x $Height"
  exit 1
}

# PROVE IT, IN THE SAME PROCESS THAT JUST WROTE IT -- the same "read back or it didn't happen" rule
# policy.yml's own trailing verify task follows.
$after = New-Object A11yDisplay.DEVMODE
$after.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($after)
[void][A11yDisplay.NativeMethods]::EnumDisplaySettings($null, $ENUM_CURRENT_SETTINGS, [ref] $after)
if ($after.dmPelsWidth -ne $Width -or $after.dmPelsHeight -ne $Height) {
  Write-Output "ChangeDisplaySettings reported success but the mode reads $($after.dmPelsWidth) x $($after.dmPelsHeight) back, not $Width x $Height"
  exit 1
}

Write-Output "set to $Width x $Height"
exit 0
