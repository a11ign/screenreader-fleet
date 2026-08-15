#!powershell

# Install NVDA through guidepup, and refuse a gutted one.
#
# Run FROM the repo: the installer reads the LOCAL @guidepup/guidepup manifest.json to decide which NVDA
# build to fetch, so that is what keeps the screen reader and its driver in lockstep. It caches to
# %LOCALAPPDATA%\guidepup -- NOT %TEMP%, which Windows cleanup empties.
#
# The integrity assertion is the reason this is a module and not a shell call. %TEMP% cleanup once
# deleted library.zip and left nvda.exe as a STUB that launches and dies, producing "Timed out waiting
# for NVDA to be running" and no nvda.log at all. A healthy install is ~1700+ files; anything under 500
# is a corpse. Those thresholds and the two named payload files are the knowledge here.
#
# Idempotent: if an intact install is already present it reports ok and installs nothing, which is what
# lets this run on every provision without paying for a download each time.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        repo_path  = @{ type = 'path'; required = $true }
        cache_root = @{ type = 'path' }
        min_files  = @{ type = 'int'; default = 500 }
        force      = @{ type = 'bool'; default = $false }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$cacheRoot = if ($module.Params.cache_root) { $module.Params.cache_root }
             elseif ($env:GUIDEPUP_SCREEN_READERS_PATH) { $env:GUIDEPUP_SCREEN_READERS_PATH }
             else { Join-Path $env:LOCALAPPDATA 'guidepup' }

function Get-NvdaState($root, $minFiles) {
    $exe = Get-ChildItem -LiteralPath (Join-Path $root 'nvda') -Recurse -Filter 'nvda.exe' -ErrorAction SilentlyContinue |
           Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $exe) { return @{ present = $false; reason = 'no nvda.exe' } }
    $dir = Split-Path $exe.FullName
    $count = @(Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue).Count
    $missing = @('library.zip', 'nvda_slave.exe') | Where-Object { -not (Test-Path (Join-Path $dir $_)) }
    return @{
        present = $true
        dir     = $dir
        files   = $count
        intact  = ($count -ge $minFiles -and $missing.Count -eq 0)
        missing = $missing
    }
}

$before = Get-NvdaState $cacheRoot $module.Params.min_files
$needsInstall = $module.Params.force -or -not $before.present -or -not $before.intact

$module.Result.installed_before = $before.present
$module.Result.intact_before = [bool]$before.intact

if (-not $needsInstall) {
    $module.Result.changed = $false
    $module.Result.path = $before.dir
    $module.Result.files = $before.files
    $module.ExitJson()
}

if ($module.CheckMode) {
    $module.Result.changed = $true
    $module.Result.path = $before.dir
    $module.ExitJson()
}

# npx.cmd, not npx.ps1 -- the .ps1 shim is blocked by execution policy on a default Windows install.
$npx = Join-Path $env:ProgramFiles 'nodejs\npx.cmd'
if (-not (Test-Path $npx)) { $npx = 'npx.cmd' }
$previous = Get-Location
Set-Location -LiteralPath $module.Params.repo_path
try {
    $output = & $npx --yes '@guidepup/setup' install nvda 2>&1
    $code = $LASTEXITCODE
} finally { Set-Location $previous }

if ($code -ne 0) {
    $module.FailJson("guidepup install nvda failed (exit $code): $(($output | Select-Object -Last 6) -join ' | ')")
}

$after = Get-NvdaState $cacheRoot $module.Params.min_files
if (-not $after.present) {
    $module.FailJson("guidepup reported success but no nvda.exe appeared under $cacheRoot")
}
if (-not $after.intact) {
    $module.FailJson("NVDA at $($after.dir) looks GUTTED: $($after.files) files (expect ~1700+, minimum " +
        "$($module.Params.min_files))$(if ($after.missing) { ", missing: $($after.missing -join ', ')" }). " +
        "It would launch and die with no nvda.log. Delete it and re-run.")
}

$module.Result.changed = $true
$module.Result.path = $after.dir
$module.Result.files = $after.files
$module.ExitJson()
