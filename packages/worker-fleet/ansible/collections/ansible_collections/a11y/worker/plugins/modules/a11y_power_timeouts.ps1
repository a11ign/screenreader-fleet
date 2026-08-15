#!powershell

# Never sleep on AC. A worker that sleeps is a worker that has vanished.
#
# BARE-METAL ONLY in origin: VMs do not sleep, so this fleet ran for months without needing it. On the
# first physical box it presented as `EHOSTUNREACH REDACTED-INTERNAL-ADDRESS:8765` for every request in an
# evidence-check run -- 48 instant failures -- and then answered a curl thirty seconds later.
# Intermittent unreachability reads as a flaky network or a wedged worker; it was Windows power
# management doing exactly its job.
#
# AC only, deliberately: a laptop-class worker sleeping on battery is correct behaviour, not a fault.
#
# A module because `powercfg /change` is not idempotent-reporting -- it exits 0 whether or not anything
# moved. Reading the current value first is what makes `changed` mean something.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        standby_timeout_ac   = @{ type = 'int'; default = 0 }
        hibernate_timeout_ac = @{ type = 'int'; default = 0 }
        disk_timeout_ac      = @{ type = 'int'; default = 0 }
        hibernate            = @{ type = 'bool'; default = $false }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

# The active scheme's AC values, in MINUTES, read from powercfg's own query rather than guessed.
function Get-AcTimeout($subGuid, $settingGuid) {
    $scheme = (& powercfg.exe /getactivescheme) -replace '^.*GUID: ([0-9a-f-]+).*$', '$1'
    $raw = & powercfg.exe /query $scheme $subGuid $settingGuid 2>$null
    $line = $raw | Select-String -Pattern 'Current AC Power Setting Index:\s*(0x[0-9a-f]+)'
    if (-not $line) { return $null }
    return [Convert]::ToInt32($line.Matches[0].Groups[1].Value, 16) / 60
}

$SUB_SLEEP = '238C9FA8-0AAD-41ED-83F4-97BE242C8F20'
$SUB_DISK  = '0012EE47-9041-4B5D-9B77-535FBA8B1442'
$wanted = @(
    @{ name = 'standby-timeout-ac';   sub = $SUB_SLEEP; setting = '29F6C1DB-86DA-48C5-9FDB-F2B67B1F44DA'; value = $module.Params.standby_timeout_ac }
    @{ name = 'hibernate-timeout-ac'; sub = $SUB_SLEEP; setting = '9D7815A6-7EE4-497E-8888-515A05F02364'; value = $module.Params.hibernate_timeout_ac }
    @{ name = 'disk-timeout-ac';      sub = $SUB_DISK;  setting = '6738E2C4-E8A5-4A42-B16A-E040E769756E'; value = $module.Params.disk_timeout_ac }
)

$before = @{}
$changes = [System.Collections.Generic.List[string]]::new()
foreach ($w in $wanted) {
    $current = Get-AcTimeout $w.sub $w.setting
    $before[$w.name] = $current
    # A value we could not read is treated as "needs setting": refusing to act because a QUERY failed
    # would leave the machine asleep to protect a diagnostic.
    if ($null -eq $current -or $current -ne $w.value) { $changes.Add($w.name) }
}

if ($changes.Count -gt 0 -and -not $module.CheckMode) {
    foreach ($w in $wanted) {
        & powercfg.exe /change $w.name $w.value | Out-Null
        if ($LASTEXITCODE -ne 0) { $module.FailJson("powercfg /change $($w.name) $($w.value) failed (exit $LASTEXITCODE)") }
    }
}

# Hibernation off entirely also reclaims hiberfil.sys, which is RAM-sized on a disk that holds a browser
# profile and an NVDA install.
$hibernateOn = Test-Path (Join-Path $env:SystemDrive 'hiberfil.sys')
if ($hibernateOn -ne $module.Params.hibernate) {
    $changes.Add('hibernate')
    if (-not $module.CheckMode) {
        & powercfg.exe /hibernate $(if ($module.Params.hibernate) { 'on' } else { 'off' }) 2>&1 | Out-Null
    }
}

$module.Result.changed = $changes.Count -gt 0
$module.Result.changes = $changes.ToArray()
$module.Result.before = $before
if ($module.Diff) {
    $module.Diff.before = $before
    $module.Diff.after = @{
        'standby-timeout-ac' = $module.Params.standby_timeout_ac
        'hibernate-timeout-ac' = $module.Params.hibernate_timeout_ac
        'disk-timeout-ac' = $module.Params.disk_timeout_ac
    }
}
$module.ExitJson()
