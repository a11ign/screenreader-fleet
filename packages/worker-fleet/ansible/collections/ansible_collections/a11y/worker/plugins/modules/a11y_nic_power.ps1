#!powershell

# Stop Windows powering the network adapter down -- WITHOUT stopping it waking the machine.
#
# The SECOND of two mechanisms, and fixing only one leaves the fault intermittent: the sleep timers put
# the whole machine away (see a11y_power_timeouts), while the NIC's own selective suspend powers the
# adapter down with the OS still running. That second one is what produced 48 consecutive EHOSTUNREACH
# failures on the first physical worker, followed by a successful curl thirty seconds later.
#
# ## Those are TWO checkboxes, and conflating them breaks Wake-on-LAN
#
# The adapter's power page has two independent settings: "allow the computer to turn off this device"
# and "allow this device to wake the computer". This fleet wants the first OFF and the second ON -- the
# NIC must stay up while the machine runs, and must still be able to wake it, because the boxes are
# meant to be powered down between runs.
#
# The registry fallback originally wrote PnPCapabilities = 24, which Microsoft documents as preventing
# Windows from turning the adapter off *or letting it wake the computer from standby*. That is BOTH
# checkboxes, so on any box where the cmdlet was missing it would have made Wake-on-LAN impossible while
# reporting success. 8 disables power-down alone and leaves wake armed.
#
# The cmdlet route is preferred precisely because it can express the two independently; the registry
# fallback cannot say "magic packet only", which is recorded rather than hidden.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        interface   = @{ type = 'str'; default = '*' }
        wake_on_lan = @{ type = 'bool'; default = $true }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$NIC_CLASS = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}'
# 8  = "allow the computer to turn off this device" unchecked; wake still armed.
# 24 = that PLUS "allow this device to wake the computer" unchecked, which kills Wake-on-LAN.
$DISABLE_POWER_DOWN = 8
$DISABLE_POWER_DOWN_AND_WAKE = 24

$adapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'Up' -and ($module.Params.interface -eq '*' -or $_.Name -like $module.Params.interface) })

# No adapter Up is a FINDING, not a no-op: this module exists because the network vanishes, and reporting
# ok having adjusted nothing is how that goes unnoticed.
if ($adapters.Count -eq 0) {
    $module.FailJson("no physical network adapter is Up matching '$($module.Params.interface)' -- " +
        "NIC power saving was NOT adjusted, and this box is the kind that goes unreachable")
}

$changed = [System.Collections.Generic.List[string]]::new()
$byRegistry = [System.Collections.Generic.List[string]]::new()

foreach ($a in $adapters) {
    $already = $false
    $wantWake = if ($module.Params.wake_on_lan) { 'Enabled' } else { 'Disabled' }
    try {
        $state = Get-NetAdapterPowerManagement -Name $a.Name -ErrorAction Stop
        # Both settings, checked independently -- the whole reason the cmdlet route is preferred.
        $already = ($state.AllowComputerToTurnOffDevice -eq 'Disabled' -and $state.WakeOnMagicPacket -eq $wantWake)
        if (-not $already -and -not $module.CheckMode) {
            Set-NetAdapterPowerManagement -Name $a.Name -AllowComputerToTurnOffDevice Disabled -WakeOnMagicPacket $wantWake -ErrorAction Stop
            # Pattern wake would bring the box up for ordinary broadcast traffic, which on a fleet meant
            # to be off between runs is the difference between "asleep" and "always on".
            if ($module.Params.wake_on_lan) {
                Set-NetAdapterPowerManagement -Name $a.Name -WakeOnPattern Disabled -ErrorAction SilentlyContinue
            }
        }
    } catch {
        # This SKU has no power-management cmdlet. Fall back to the registry value it would have written.
        $byRegistry.Add($a.Name)
        $key = Get-ChildItem $NIC_CLASS -ErrorAction SilentlyContinue | Where-Object {
            (Get-ItemProperty $_.PSPath -Name DriverDesc -ErrorAction SilentlyContinue).DriverDesc -eq $a.InterfaceDescription
        }
        if (-not $key) {
            $module.FailJson("adapter '$($a.Name)' has no power-management cmdlet AND no matching registry " +
                "key under the network class -- neither mechanism is available, so it WILL power down")
        }
        $want = if ($module.Params.wake_on_lan) { $DISABLE_POWER_DOWN } else { $DISABLE_POWER_DOWN_AND_WAKE }
        foreach ($k in $key) {
            $current = (Get-ItemProperty $k.PSPath -Name PnPCapabilities -ErrorAction SilentlyContinue).PnPCapabilities
            $already = ($current -eq $want)
            if (-not $already -and -not $module.CheckMode) {
                Set-ItemProperty $k.PSPath -Name PnPCapabilities -Value $want -Type DWord -Force
            }
        }
    }
    if (-not $already) { $changed.Add($a.Name) }
}

$module.Result.changed = $changed.Count -gt 0
$module.Result.adjusted = $changed.ToArray()
$module.Result.adapters = @($adapters | ForEach-Object { $_.Name })
$module.Result.via_registry = $byRegistry.ToArray()
$module.ExitJson()
