The fleet's copy of `apply-foreground-lock-timeout.ps1` is deleted (ADR 0045 cut 5 of 9, fleet side, a11ign/a11ign#5148). The script is read from the installed `@a11ign/screenreader-worker` package's `launcher/`, by both consumers: `provision-nvda-worker.ps1` runs `<RepoPath>\node_modules\@a11ign\screenreader-worker\launcher\apply-foreground-lock-timeout.ps1` (it was a `$PSScriptRoot` sibling), and `stamp-provision-revision.ps1` hashes that same path, so the bytes that run are the bytes the stamp describes.

## The row's own Acceptance (hand-run)

The row's command reads `main` of `a11ign/screenreader-fleet`, which carries no change until this PR merges. It was run twice:

- Before, on `main` (2026-10-12): `["src/provisioning/apply-foreground-lock-timeout.ps1"]`.
- On this branch, the same command with the ref `agent/screenreader-fleet-s-copy-5148` in place of `main`: see `## Hand-run output` in the PR body. It must print `[]`; re-running it with `main` after the merge is the closing reading.

Passes when the output is `[]`, so the second branch of the row's pass condition (a re-export whose sha256 equals the launcher's) does not apply: there is no re-export.

## Provision-stamp consequence (Done-when 3), measured per file

The stamp hashes each file's CRLF-normalised UTF-8 text (leading BOM dropped), SHA-256, then the first 16 hex characters of the digest of the concatenation. `@a11ign/screenreader-worker@0.13.0` from the registry (`npm pack`), `a11ign/control` at `v0.5.3` for the two Ansible files, the fleet's scripts from `origin/main` (before) and this branch (after):

| file | before | after |
|---|---|---|
| `provision-nvda-worker.ps1` | `30430BBD4903824A` | `02CAAD03529E82C1` **moves** (the `$fltScript` line and its comment) |
| `run-server.cmd` | `B5E86DFA02221C60` | `B5E86DFA02221C60` |
| `apply-foreground-lock-timeout.ps1` | `FB7EC648519EF212` (fleet copy) | `1907969A83B52402` **moves** (the worker's copy; one comment line differs: `see src/provisioning/diagnose-nvda-worker.ps1` against `see packages/worker-fleet/src/provisioning/diagnose-nvda-worker.ps1`) |
| `main.yml`, `a11y_speech_viewer.ps1` | `900AC4C25AA0A3E0`, `870648FD2B1CC1EC` | unchanged |

`pwsh -NoProfile -NonInteractive -File .../stamp-provision-revision.ps1 -RepoPath <tree>` wrote `c0e755a714af51ee` before (the value a11ign/screenreader-fleet#39 measured, so the tree is the production shape) and **`b945ffc027d4aea0` after**. An independent Python replication over the same bytes gives the same two values. `provisionRevision` therefore changes once.

**Who re-provisions:** every box provisioned before this lands keeps `c0e755a714af51ee` and reads `fleet-consistency` INCONSISTENT against one provisioned after, and the capture cache is keyed on it, so the fleet is re-provisioned once, by `orchestrator` (first reader for fleet questions, and the only session that may run `fleet:provision`). This worker ran nothing that reaches the fleet or the lab.

## Evidence (this branch)

- `pwsh` parses both edited scripts with no errors (`System.Management.Automation.Language.Parser`).
- `pnpm test`: `VERDICT pass: 252 tests in 39 files (4 skipped)`, exit 0. `pnpm run typecheck`: exit 0. `pnpm run lint`: 0 errors, 68 warnings.
- **Not measured:** a real provision on a Windows box. `provision-nvda-worker.ps1` was parse-checked, not run. The one thing that run would settle is that `node_modules\@a11ign\screenreader-worker\launcher\` exists at Step 3 of the script: the stamp at Step 7 already throws on a missing launcher file, and `$fltScript` keeps its `Test-Path` guard and WARN, so a missing file is not silent.

## Consumers outside this repository, found and not changed

`a11ign/a11ign` reads the removed path: `action.yml:575` (`./node_modules/@a11ign/screenreader-fleet/src/provisioning/apply-foreground-lock-timeout.ps1`) and `.github/workflows/registry-consumer-gate.yml:182` (tries `screenreader-fleet`, then `worker-fleet`, under `src/provisioning/`). Both stop finding a script once the core installs a fleet release carrying this change. They are core files, outside this row's Region, and the core's pinned fleet version is `0.9.0`, which still carries the file, so nothing breaks until the pin moves.

Acceptance: bash -c '! git ls-files -co --exclude-standard | grep -q "apply-foreground-lock-timeout.ps1" && git grep -qF "launcher\apply-foreground-lock-timeout.ps1" -- src/provisioning/provision-nvda-worker.ps1 && git grep -qF "WORKER_LAUNCHER/apply-foreground-lock-timeout.ps1" -- src/provisioning/stamp-provision-revision.ps1'

Mutation: three ways to break it, one clean reading, restored from copies and diffed byte-identical (`mutate.sh` in the session scratchpad). The clean tree exits 0. Putting the fleet copy back makes it exit 1. Reverting `$fltScript` to `Join-Path $PSScriptRoot 'apply-foreground-lock-timeout.ps1'` makes it exit 1. Pointing `$FOREGROUND_LOCK` back at `$FLEET_PACKAGE/src/provisioning/...` makes it exit 1. Each mutation fails its own clause and the unmutated tree passes the other two.
