#!powershell

# Evict OneDrive, properly.
#
# Policy alone (DisableFileSyncNGSC) stops it STARTING again. It does not remove the per-user Run entry
# that relaunches it at logon, and it does not dismiss a toast already on screen -- observed on the
# guest, with the policy applied cleanly and "Turn On Windows Backup" still sitting over the desktop.
#
# That matters because a capture works by forcing the browser to the front and reading what NVDA
# announces. A notification that steals focus mid-capture corrupts the evidence, and one that merely
# sits over the page does it silently.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        state = @{ type = 'str'; choices = @('absent'); default = 'absent' }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$RUN_KEY = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$actions = [System.Collections.Generic.List[string]]::new()

$running = @(Get-Process OneDrive -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    $actions.Add('stopped')
    if (-not $module.CheckMode) { $running | Stop-Process -Force -ErrorAction SilentlyContinue }
}

foreach ($name in @('OneDrive', 'OneDriveSetup')) {
    $present = (Get-ItemProperty -LiteralPath $RUN_KEY -Name $name -ErrorAction SilentlyContinue)
    if ($present) {
        $actions.Add("run-entry:$name")
        if (-not $module.CheckMode) {
            Remove-ItemProperty -LiteralPath $RUN_KEY -Name $name -ErrorAction SilentlyContinue
        }
    }
}

# SysWOW64 first, System32 second -- which one exists depends on the image.
$setup = Join-Path $env:SystemRoot 'SysWOW64\OneDriveSetup.exe'
if (-not (Test-Path $setup)) { $setup = Join-Path $env:SystemRoot 'System32\OneDriveSetup.exe' }
if (Test-Path $setup) {
    $actions.Add('uninstalled')
    if (-not $module.CheckMode) {
        Start-Process $setup -ArgumentList '/uninstall' -Wait -ErrorAction SilentlyContinue
    }
}

$module.Result.changed = $actions.Count -gt 0
$module.Result.actions = $actions.ToArray()
$module.ExitJson()
