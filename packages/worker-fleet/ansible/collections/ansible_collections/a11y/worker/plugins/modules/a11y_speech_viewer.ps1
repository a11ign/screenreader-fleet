#!powershell

# Turn NVDA's Speech Viewer off, across every nvda.ini in an install, and prove it took.
#
# This is the highest-value setting on a capture worker and the one that fails most quietly.
# guidepup's bundled config ships the Speech Viewer ON. That window's focus event is ANNOUNCED, so it
# lands in the spokenPhraseLog delta captured right after activating a control: every interaction probe
# returns "NVDA Speech Viewer" instead of the page's response, which makes an accessible page and an
# inaccessible one INDISTINGUISHABLE.
#
# It fails silently by construction -- capture-check asserts that the probe fired, not what it heard --
# so the re-read at the end is not belt and braces, it is the only thing that can catch it.
#
# Reinstalling NVDA resets this, which is why it is idempotent and run after every install rather than
# once. A module rather than inline script so that `--check` can say what it WOULD do without doing it,
# and so a run reports a diff of the actual lines it changed.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        path    = @{ type = 'path'; required = $true }
        enabled = @{ type = 'bool'; default = $false }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$root = $module.Params.path
$want = if ($module.Params.enabled) { 'True' } else { 'False' }
$unwanted = if ($module.Params.enabled) { 'False' } else { 'True' }

if (-not (Test-Path -LiteralPath $root)) {
    $module.FailJson("no NVDA install at $root")
}

$inis = @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'nvda.ini' -ErrorAction SilentlyContinue)
# Zero ini files is not "nothing to do" -- it means we were pointed at something that is not an NVDA
# install, and reporting ok would be reporting success having examined nothing.
if ($inis.Count -eq 0) {
    $module.FailJson("no nvda.ini under $root -- this does not look like an NVDA install")
}

$patched = [System.Collections.Generic.List[string]]::new()
foreach ($ini in $inis) {
    $body = Get-Content -LiteralPath $ini.FullName -Raw
    $new = $body -replace "showSpeechViewerAtStartup = $unwanted", "showSpeechViewerAtStartup = $want"
    if ($new -ne $body) {
        $patched.Add($ini.FullName)
        if (-not $module.CheckMode) {
            Set-Content -LiteralPath $ini.FullName -Value $new -NoNewline
        }
    }
}

$module.Result.changed = $patched.Count -gt 0
$module.Result.patched = $patched.ToArray()
$module.Result.examined = $inis.Count

# The diff is the point of doing this as a module: it says WHICH files moved, not just that something did.
if ($module.Diff) {
    $module.Diff.before = @{ showSpeechViewerAtStartup = $unwanted; files = $patched.ToArray() }
    $module.Diff.after = @{ showSpeechViewerAtStartup = $want; files = $patched.ToArray() }
}

# Verified by RE-READING, never by assuming the replace worked. In check mode there is nothing to verify
# because nothing was written, and claiming otherwise would be the check-mode equivalent of a guard that
# reports success having examined nothing.
if (-not $module.CheckMode -and -not $module.Params.enabled) {
    $stillOn = @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'nvda.ini' -ErrorAction SilentlyContinue |
        Select-String -Pattern 'showSpeechViewerAtStartup = True')
    if ($stillOn.Count -gt 0) {
        $module.FailJson("Speech Viewer is STILL enabled in $($stillOn.Count) file(s) after patching; " +
            "interaction probes would be unusable and every one would look like a page failure.")
    }
}

$module.ExitJson()
