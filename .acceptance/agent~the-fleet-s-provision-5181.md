`stamp-provision-revision.ps1` stops reading `packages/control/layers.json`, which the core no longer lays or declares (a11ign/a11ign#5087, ADR 0045 cut 9). Each of the five hashed paths now resolves from where the installed package puts its files: `node_modules/@a11ign/screenreader-fleet/src/provisioning/` for the fleet's two scripts, and `node_modules/@a11ign/screenreader-worker/launcher/run-server.cmd` for the launcher (ADR 0045 cut 6, a11ign#5084). The `Get-LayerFile` and `Get-DeclaredReach` helpers are removed, along with the `src/launcher-reach.cmd` read they did.

## What moves, measured per file

The stamp hashes each file's CRLF-normalised UTF-8 text (a leading BOM dropped), SHA-256, first 16 hex characters of the combined digest. Replicated in Python over the same bytes:

- `provision-nvda-worker.ps1`: package `30430BBD4903824A`, repo copy `30430BBD4903824A`. Unchanged.
- `apply-foreground-lock-timeout.ps1`: package `FB7EC648519EF212`, repo copy `FB7EC648519EF212`. Unchanged.
- `run-server.cmd`: worker repository source `D7643CD1DFD1DA63`, published launcher `B5E86DFA02221C60`. **Moves.** The published file differs from the source file in content (it derives `SERVER` and `FLT` from `%~dp0`), and the box runs the published one.

So `provisionRevision` changes once, for boxes provisioned from this change onward. Boxes provisioned before it keep the old value and read `fleet-consistency` INCONSISTENT until re-provisioned. That is the orchestrator's VERIFY (Done-when 2), not this row's.

## Evidence (this branch, after the edit)

- `pwsh` parses the file with no errors (`System.Management.Automation.Language.Parser`).
- `pnpm test`: `VERDICT pass: 252 tests in 39 files (4 skipped)`, exit 0.
- `pnpm run typecheck`: exit 0.
- `pnpm run lint`: exit 0, 68 warnings, 0 errors. The base count was not measured; the edit is a `.ps1` file that ESLint does not read.
- Limit: no test in this repo runs the PowerShell stamp, and this checkout has no `packages/control`, so the stamp cannot run end to end here (it would throw on the missing ansible paths, which is the existing behaviour on a checkout without control). The per-file replication above is the measurement; the full stamp runs only on a worker.

Acceptance: bash -c '! git grep -q "layers.json" -- src/provisioning/stamp-provision-revision.ps1'

Mutation: the row's own Acceptance is the guard. Put `layers.json` back into the script (a comment on the `$FLEET_PACKAGE` line naming it) and the acceptance exits 1; removing it exits 0. Both were run in this worktree. A reading of the path only (no `layers.json` in the file) is what the guard checks, so a regression that reintroduces the read is caught, and a regression that reads a different missing file is not caught by it. That second case is what the `throw` on a missing file is for, and it is not exercised here.
