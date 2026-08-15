#!powershell

# Stop Windows powering the network adapter down.
#
# The SECOND of two mechanisms, and fixing only one leaves the fault intermittent: the sleep timers put
# the whole machine away (see a11y_power_timeouts), while the NIC's own selective suspend powers the
# adapter down with the OS still running. That second one is what produced 48 consecutive EHOSTUNREACH
# failures on the first physical worker, followed by a successful curl thirty seconds later.
#
# Two routes, because `Set-NetAdapterPowerManagement` is not present on every SKU. The registry fallback
# writes the value that cmdlet would have written: PnPCapabilities 24 disables both power-down and
# wake-armed. Reading state first is what makes `changed` honest -- neither route reports it.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        interface = @{ type = 'str'; default = '*' }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$NIC_CLASS = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}'
$DISABLE_POWER_DOWN = 24

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
    try {
        $state = Get-NetAdapterPowerManagement -Name $a.Name -ErrorAction Stop
        $already = ($state.AllowComputerToTurnOffDevice -eq 'Disabled')
        if (-not $already -and -not $module.CheckMode) {
            Set-NetAdapterPowerManagement -Name $a.Name -AllowComputerToTurnOffDevice Disabled -ErrorAction Stop
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
        foreach ($k in $key) {
            $current = (Get-ItemProperty $k.PSPath -Name PnPCapabilities -ErrorAction SilentlyContinue).PnPCapabilities
            $already = ($current -eq $DISABLE_POWER_DOWN)
            if (-not $already -and -not $module.CheckMode) {
                Set-ItemProperty $k.PSPath -Name PnPCapabilities -Value $DISABLE_POWER_DOWN -Type DWord -Force
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
