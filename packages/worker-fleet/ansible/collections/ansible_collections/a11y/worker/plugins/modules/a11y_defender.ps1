#!powershell

# Windows Defender real-time monitoring, and an honest refusal when it cannot be changed.
#
# There is no Defender module in ansible.windows or community.windows -- the only one is a lone
# third-party repo, and depending on that for something in the capture path is worse than owning it.
#
# The important behaviour is the REFUSAL. Tamper Protection silently reverts `Set-MpPreference`: the call
# succeeds, the setting appears to change, and Defender puts it back. A module that reported `changed`
# there would be lying every run. So Tamper Protection is checked FIRST and reported rather than fought,
# which is what provisioning already did and is the only honest answer on a running system.
#
# Defender is disabled here for capture cost, not for security theatre: it is ~242 MB of a memory budget
# that decides how many workers fit on a host, and that trade should be made on the number.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        realtime_monitoring = @{ type = 'bool'; default = $false }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$status = $null
try { $status = Get-MpComputerStatus -ErrorAction Stop } catch { }

if (-not $status) {
    # Not an error: a trimmed image may have no Defender at all, which is the desired end state anyway.
    $module.Result.changed = $false
    $module.Result.present = $false
    $module.Result.msg = 'Defender is not present on this image'
    $module.ExitJson()
}

$module.Result.present = $true
$module.Result.tamper_protected = [bool]$status.IsTamperProtected
$module.Result.realtime_before = -not $status.RealTimeProtectionEnabled -eq $false

$wantEnabled = $module.Params.realtime_monitoring
$isEnabled = [bool]$status.RealTimeProtectionEnabled

if ($isEnabled -eq $wantEnabled) {
    $module.Result.changed = $false
    $module.ExitJson()
}

if ($status.IsTamperProtected) {
    # Reported, not fought, and NOT failed: the box is still a usable worker, it just costs more memory.
    # Failing here would block provisioning over an optimisation.
    $module.Result.changed = $false
    $module.Result.msg = 'Tamper Protection is ON, so Set-MpPreference would be silently reverted. ' +
        'Left as it is. To reclaim the memory, disable Tamper Protection in the image ' +
        '(build-lean-worker-image.ps1 does it offline, which is the only place it works).'
    $module.ExitJson()
}

if (-not $module.CheckMode) {
    Set-MpPreference -DisableRealtimeMonitoring (-not $wantEnabled) -ErrorAction Stop
    # Verified by re-reading, because this is exactly the setting known to revert.
    $after = Get-MpComputerStatus
    if ([bool]$after.RealTimeProtectionEnabled -ne $wantEnabled) {
        $module.FailJson('Set-MpPreference was accepted but the setting did not stick, and Tamper ' +
            'Protection is reported OFF. Something else is managing Defender on this box.')
    }
}

$module.Result.changed = $true
$module.ExitJson()
