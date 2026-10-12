`stamp-provision-revision.ps1` stops reading `packages/control/layers.json` to find its files. The fleet's two scripts resolve from `node_modules/@a11ign/screenreader-fleet/src/provisioning/` and the launcher from `node_modules/@a11ign/screenreader-worker/launcher/run-server.cmd` (ADR 0045 cut 6, a11ign#5084). The two Ansible files stay under `packages/control/ansible/`, where the core lays its pinned control layer (root `layers.json`: `control` pinned at v0.5.3, `lays: ansible`). The `Get-LayerFile` and `Get-DeclaredReach` helpers are removed, along with the `src/launcher-reach.cmd` read they did.

**Correction (2026-10-12).** The first version of this file said the core "no longer lays or declares" `packages/control/layers.json`. That was wrong: the root `layers.json` still declares `control` and the bootstrap reads the laid copy. Removing the read is a design choice (the stamp reads what the installed packages hold), not something the core forced.

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
- **End to end (2026-10-12), in a production-shaped RepoPath.** `provision-nvda-worker.ps1` passes its own `$RepoPath` (default `%USERPROFILE%\a11y-witness`, the core checkout) to the stamp, so the paths are resolved against the core's layout. That tree was built from the pinned bytes: the fleet's two scripts and `run-server.cmd` from the core's `node_modules` (`@a11ign/screenreader-fleet` 0.9.0, `@a11ign/screenreader-worker` 0.13.0, the versions the core pins), and the two Ansible files from `a11ign/control` at `v0.5.3` (the root `layers.json` pin). `pwsh -NoProfile -NonInteractive -File src/provisioning/stamp-provision-revision.ps1 -RepoPath <that tree>` exits 0 and writes `c0e755a714af51ee`; an independent Python replication over the same bytes gives `c0e755a714af51ee`.
- **The reviewer's invocation** (`-RepoPath "$PWD"` in this fleet checkout) throws at line 122, because this checkout is not a core layout and holds neither `node_modules/@a11ign/screenreader-fleet` nor the Ansible files. That is the missing-file guard working, not the production path; production never passes the fleet checkout as `RepoPath`.
- The fleet's own devDependency pins worker 0.9.0, which has no `launcher/`. The core pins 0.13.0, which has it. The stamp runs against the core's installed tree, so the 0.13.0 launcher is the one measured.
- The per-file replication above is still the measurement of what moves; the e2e run above is the check that the paths resolve and the stamp is written.

Acceptance: bash -c '! git grep -q "layers.json" -- src/provisioning/stamp-provision-revision.ps1'

Mutation: the row's own Acceptance is the guard. Put `layers.json` back into the script (a comment on the `$FLEET_PACKAGE` line naming it) and the acceptance exits 1; removing it exits 0. Both were run in this worktree. A reading of the path only (no `layers.json` in the file) is what the guard checks, so a regression that reintroduces the read is caught, and a regression that reads a different missing file is not caught by it. That second case is what the `throw` on a missing file is for, and it is not exercised here.
