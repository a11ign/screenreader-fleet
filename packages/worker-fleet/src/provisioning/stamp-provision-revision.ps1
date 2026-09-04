<#
.SYNOPSIS
  Write provision-revision.txt -- the stamp that keys the capture cache on what provisioning ACTUALLY did.

.DESCRIPTION
  ONE definition, called by both provisioning paths. It used to live inline at the end of
  provision-nvda-worker.ps1, which meant the Ansible role could not stamp at all: a box provisioned or
  RE-provisioned through `provision-role.yml` kept whatever stamp its first boot happened to write.

  Measured consequence on this fleet -- four boxes, functionally identical, reporting four different
  revisions purely because each first-booted at a different commit during one afternoon:

      .107 = 5d4b877-c9d43b025889b77c
      .59  = ae888e3-c9d43b025889b77c
      .175 = b8b5af4-c9d43b025889b77c
      .224 = 449a20c-c9d43b025889b77c

  `fleet:status` correctly called that INCONSISTENT, and no amount of re-provisioning could converge it,
  because nothing on the Ansible path wrote the file.

  ## What is hashed, and why the role's defaults are in the list

  The stamp exists so two guests with different NVDA/Edge configuration cannot share a cache entry. When
  it was written, provisioning was the PowerShell script, so hashing three of its files described the
  environment completely. It no longer does: `roles/worker/defaults/main.yml` is where the Edge policies,
  the NIC power values and the quiet-desktop settings are now DEFINED, and the role applies them.

  Leaving it out would have been the cosmetic version of this fix. Adding `ComponentUpdatesEnabled` to
  that file changes what Edge does during a capture and would NOT have moved the stamp -- so captures
  taken either side of it would have shared a cache key while describing different browsers. That is
  precisely the failure the stamp is here to prevent.

  Task files are deliberately NOT hashed. They change when the same settings are applied a different way
  -- batching four registry writes into one call is a refactor, not an environment change -- and keying on
  them would churn the cache for reasons that never reach a capture.

.NOTES
  Missing files THROW. The previous version filtered them out with `Where-Object { $_ }`, so when the repo
  was restructured into packages/ all three paths vanished at once and `$combined` silently fell back to
  'unknown' -- the stamp stopped describing anything and varied only by git SHA. A check that discards its
  own inputs cannot report that it found nothing.
#>
param(
    [Parameter(Mandatory = $true)][string] $RepoPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The single definition. Explicit paths rather than a filename search, because `main.yml` is not unique
# in this repo and a search would silently pick the wrong one.
$ENVIRONMENT_FILES = @(
    'packages/worker-fleet/src/provisioning/provision-nvda-worker.ps1'
    'packages/nvda-worker/src/run-server.cmd'
    'packages/worker-fleet/src/provisioning/apply-foreground-lock-timeout.ps1'
    'packages/control/ansible/roles/worker/defaults/main.yml'
)

# LINE ENDINGS ARE NORMALISED BEFORE HASHING, AND THE PREVIOUS VERSION'S OMISSION WAS A LATENT SPLIT.
#
# This used to be `Get-FileHash`, which hashes the file's BYTES -- so the stamp depended on how git had
# checked the file out. Windows git converts to CRLF by default and nothing in this repo pins that: there
# is no `.gitattributes`. Measured 2026-09-04, the same four blobs at one commit:
#
#     CRLF  dbb7d33409a9341d      <- what the whole fleet reported
#     LF    1052b80ca42398c7      <- what a checkout with core.autocrlf=false would report
#
# `provisionRevision` is a capture cache key AND a `fleet-consistency` MUST_MATCH field, compared for
# EQUALITY. So one box cloned with a different `core.autocrlf` would read INCONSISTENT for ever, block
# every capture run, and -- this is the part that makes it worth fixing rather than documenting --
# RE-PROVISIONING COULD NOT CONVERGE IT, because the box would faithfully recompute the same wrong hash.
# It is the one drift in this fleet with no remedy at the operator's disposal.
#
# The header above says what the stamp is for: "two guests with different NVDA/Edge configuration cannot
# share a cache entry". A line ending is not configuration, so hashing it is not merely risky, it is
# measuring the wrong thing -- the same argument that already excludes the git SHA and the task files.
#
# Normalising costs one stamp move, paid once, and it was bundled with a move happening anyway.
$hashes = foreach ($relative in $ENVIRONMENT_FILES) {
    $full = Join-Path $RepoPath ($relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full)) {
        throw "provision stamp: $relative is missing under $RepoPath. Refusing to write a stamp that " +
              "describes less than it claims -- fix the path or the checkout."
    }
    # ReadAllText also drops a UTF-8 BOM, which is the same class of difference arriving by another door:
    # a file re-saved by an editor that adds one would otherwise move the stamp for no reason.
    $text = [IO.File]::ReadAllText($full) -replace "`r`n", "`n"
    $sha  = [Security.Cryptography.SHA256]::Create()
    ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '')
}

$bytes = [Text.Encoding]::UTF8.GetBytes(($hashes -join ''))
$combined = ([BitConverter]::ToString(
    [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)) -replace '-', '').Substring(0, 16).ToLower()

# THE COMMIT IS RECORDED, AND IS DELIBERATELY NOT PART OF THE STAMP.
#
# It used to be: the stamp read `<short sha>-<content hash>`. That made an ordinary commit -- one touching
# none of the four files above, none of provisioning, nothing a capture can observe -- change a CAPTURE
# CACHE KEY and a `fleet-consistency` MUST_MATCH field. The consequences are not theoretical:
#
#   - re-provisioning a fleet after any commit invalidates every cached capture, so a full recapture
#     (~6 h) is the price of a documentation change that happened to land first;
#   - a box provisioned even minutes after its peers reads INCONSISTENT and blocks every capture run;
#   - measured 2026-08-25: a11y-worker-6 failed provisioning and could not simply be re-run, because by
#     then HEAD had moved and re-running would have stamped it differently from the four boxes that had
#     just succeeded. Four healthy machines faced re-provisioning for a SHA.
#
# This repo already made exactly this decision one field over, and wrote down why: `workerCode` is
# deliberately OUTSIDE the capture cache key because "it changes when a comment changes, and invalidating
# 1,061 pairs over a reworded comment is how a cache gets switched off". A git SHA changes for strictly
# more reasons than a code hash does.
#
# The content hash already answers the question the stamp exists to answer -- do two guests have different
# NVDA/Edge configuration? -- and it answers it by describing the configuration rather than by naming a
# moment. That is also why task files are excluded above: "batching four registry writes into one call is a
# refactor, not an environment change". The SHA contradicted that reasoning; removing it restores it.
#
# The commit is still worth having, for diagnosis rather than for keying, so it goes in its own file next
# to the stamp. `provisionRevision` is compared for EQUALITY and never parsed (capture-cache.mjs,
# fleet-consistency.mjs), so nothing downstream reads the two halves apart.
$gitSha = try { (git -C $RepoPath rev-parse --short HEAD 2>$null) } catch { $null }
$commitPath = Join-Path $RepoPath 'provision-commit.txt'
$(if ($gitSha) { $gitSha } else { 'nogit' }) | Out-File -LiteralPath $commitPath -Encoding ascii -NoNewline

$stamp = $combined

$stampPath = Join-Path $RepoPath 'provision-revision.txt'
$stamp | Out-File -LiteralPath $stampPath -Encoding ascii -NoNewline
$stamp
