# RUN `set-display-mode.ps1`'s DEVICE-ENUMERATION PAIR, under a real PowerShell, against a stub of the
# one Windows API it calls -- and print what it actually wrote.
#
# ## Why this exists at all
#
# reviewer-2's blocker on #1968 at `a58c7e44`: the script's same-API positive control could be present in
# the file and never run. It was. `Get-EnumeratedDevices` returned `,$lines` and `Write-DisplayDevices`
# counted `@(...)`, so the count was 1 for EVERY population -- and no assertion over the script's TEXT can
# separate "the control is written" from "the control ran", which is the same distinction the first
# verdict named at `:204`. The only thing that can is a PowerShell interpreter.
#
# ## Why it can run off Windows
#
# The two functions under test call exactly one native function, `EnumDisplayDevices`, and nothing else
# Windows-only -- no `Process.SessionId`, no `WindowsIdentity`, both of which throw
# `PlatformNotSupportedException` under .NET on Linux and are why the script as a WHOLE cannot run here.
# So this harness defines its own `A11yDisplay.NativeMethods` with a stub of that one call, whose
# population is settable, and dot-sources the real functions beside it. The COUNTING is PowerShell's own
# language behaviour -- identical on Linux, macOS and Windows -- which is the behaviour the defect was in.
#
# The stubbed API answers a question the fleet readings cannot: what this code does when the enumeration
# is NON-empty. On every real worker measured so far it is empty, which is exactly the population that
# cannot tell a broken counter from a working one.
#
# ## Why the function text comes from the AST
#
# `Get-ModuleFunctionScriptBlock` is imported from the Ansible collection's own `TestHelpers.psm1` rather
# than retyped here: a second copy of a predicate drifts from the first, and this repo has a catalogue of
# that. It returns the named function's literal `Extent.Text` from the parsed real file, and the CALLER
# dot-sources it -- a `.` inside that helper would define the function in a scope that disappears on
# return. Both facts are load-bearing and both are that file's own, proven by its own mutation history.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $ScriptPath,
  [Parameter(Mandatory = $true)] [string] $HelperModule
)

$ErrorActionPreference = 'Stop'

Import-Module -Name $HelperModule -Force

# The DISPLAY_DEVICE layout is restated here because `Marshal.SizeOf` needs the marshalling attributes to
# size the struct at all -- the script's own copy lives inside its `Add-Type` block, which this harness
# deliberately does not run (it declares user32 P/Invokes that only Windows can bind). This is a STUB of
# the world, not a copy of the code under test: nothing asserted below reads it.
Add-Type -TypeDefinition '
  using System;
  using System.Runtime.InteropServices;
  namespace A11yDisplay {
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
      // How many devices the NULL call and the NAMED call each have to give. The distinction the whole
      // script turns on is NULL versus a name, so the stub branches on precisely that.
      public static int NullDevices = 0;
      public static int NamedDevices = 0;
      // WHAT THE API WAS ACTUALLY ASKED, one entry per call, at index 0. PowerShell binds `$null` to a
      // `string` parameter as `[string]::Empty`, so "the script passes NULL" is a claim about the
      // BINDING, not about the source text -- this records which of the two arrived, so the test can
      // assert it instead of inferring it from a count.
      public static System.Collections.Generic.List<string> AskedFor =
        new System.Collections.Generic.List<string>();
      public static bool EnumDisplayDevices(string device, int devNum, ref DISPLAY_DEVICE info, int flags) {
        if (devNum == 0) { AskedFor.Add(device == null ? "NULL" : "\"" + device + "\""); }
        int available = (device == null) ? NullDevices : NamedDevices;
        if (devNum >= available) { return false; }
        info.DeviceName = (device == null) ? "\\\\.\\DISPLAY" + (devNum + 1) : device + "\\Monitor" + devNum;
        info.DeviceString = "stub adapter " + devNum;
        info.StateFlags = 5;
        return true;
      }
    }
  }
'

. (Get-ModuleFunctionScriptBlock -Path $ScriptPath -Name 'Get-LastWin32Error')
. (Get-ModuleFunctionScriptBlock -Path $ScriptPath -Name 'Get-EnumeratedDevices')
. (Get-ModuleFunctionScriptBlock -Path $ScriptPath -Name 'Write-DisplayDevices')

# `primary = $null` is the case where the name lookup itself failed, so there is no control to run.
$scenarios = @(
  @{ name = 'nonEmptyNull'; nullDevices = 2; namedDevices = 1; primary = '\\.\DISPLAY1' }
  @{ name = 'emptyNullAnsweringControl'; nullDevices = 0; namedDevices = 1; primary = '\\.\DISPLAY1' }
  @{ name = 'emptyNullRefusingControl'; nullDevices = 0; namedDevices = 0; primary = '\\.\DISPLAY1' }
  @{ name = 'emptyNullNoControlPossible'; nullDevices = 0; namedDevices = 0; primary = $null }
)

$results = @()
foreach ($scenario in $scenarios) {
  [A11yDisplay.NativeMethods]::NullDevices = $scenario.nullDevices
  [A11yDisplay.NativeMethods]::NamedDevices = $scenario.namedDevices
  [A11yDisplay.NativeMethods]::AskedFor.Clear()
  $written = @(Write-DisplayDevices -PrimaryDevice $scenario.primary)
  $results += [pscustomobject]@{
    name = $scenario.name
    nullDevices = $scenario.nullDevices
    namedDevices = $scenario.namedDevices
    primary = $scenario.primary
    askedFor = @([A11yDisplay.NativeMethods]::AskedFor | ForEach-Object { [string] $_ })
    lines = @($written | ForEach-Object { [string] $_ })
  }
}

$results | ConvertTo-Json -Depth 5 -AsArray
