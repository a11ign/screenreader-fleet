The fleet pins `@a11ign/screenreader-worker` at `0.13.2` (was `0.9.0`), the first release that ships `launcher/`. Worker 0.9.0 through 0.12.0 publish `dist` only, so `provision-stamp.ps1` hashed two files that the installed package did not contain and provisioning threw before it wrote a stamp (a11ign/screenreader-fleet#50). The pin, the lockfile and the regression test are the hand-off from `ceo` (branch `ceo/handoff-5513`, commit `50c5d94`), reviewed and applied unchanged apart from this commit's message. The test asserts that the installed worker contains both launcher files the stamp hashes, and that the list it reads is the list the stamp hashes.

Acceptance:

```bash
pnpm install --frozen-lockfile --ignore-scripts && test -f node_modules/@a11ign/screenreader-worker/launcher/run-server.cmd && test -f node_modules/@a11ign/screenreader-worker/launcher/apply-foreground-lock-timeout.ps1 && pnpm exec rstest run src/provision-stamp.test.ts
```

Evidence (measured in this worktree on this branch): the command exits 0 with `VERDICT pass: 4 tests in 1 file`. `pnpm run typecheck` prints no errors; `pnpm test` is `VERDICT pass: 398 tests in 55 files (5 skipped)`, none failed. `pnpm exec changeset status --since=origin/main` lists `@a11ign/screenreader-fleet` at patch. `npm pack @a11ign/screenreader-worker@0.13.2 --dry-run` lists `launcher/run-server.cmd` and `launcher/apply-foreground-lock-timeout.ps1`.

Mutation (both directions, against the new test):

- Launcher directory hidden (moved out of `node_modules/@a11ign/screenreader-worker/`): `VERDICT fail: 1 of 4`, and the failure message names `run-server.cmd` as absent. Directory moved back: `VERDICT pass: 4`.
- Always-fail (the stamp's existence check in the test changed to look for a path that cannot exist): `VERDICT fail: 1 of 4`. Test file restored byte-identical from a saved copy (`cmp` identical): `VERDICT pass: 4`.

Worker-change reading (what changes for the fleet between 0.9.0 and 0.13.2, from the worker's release notes for v0.10.0 to v0.13.2 and `compare v0.9.0...v0.13.2`, 44 commits, 48 files; not measured against a running box):

- Imports the fleet makes from the worker (`error-text`, `code-version`, `capture-faults`, `windows-trim`, and the `/health.code` readers): none of their source files changed, and the `exports` map and `dependencies` are identical between 0.9.0 and 0.13.2.
- `src/worker-files.ts` adds `screen-loop.ts`, `totp.ts` and `otpauth.ts` to `WORKER_FILES`. `codeVersion` iterates that list, so `/health.code` changes for every worker. Until every worker is re-provisioned, the fleet reads each one as stale. This is expected and is not a regression in this change.
- The worker added `edgeUpdaterGuard.state` to `/health` in 0.11.0; the fleet already lists that field in `REPORTED_ONLY` (`.acceptance/agent~the-fleet-reports-the-guard-state-5021.md`), so it starts receiving a value.
- Not touched by the fleet: auth-flow, screen-loop behaviour, edge-updater-guard logic, `server.ts`, the CI and auto-arm workflows, and the 0.13.1 and 0.13.2 screen-loop fixes.

Not done here: re-provisioning the boxes so they run the new stamp and the 0.13.2 worker is `fleet:deploy` / `fleet:provision` work, which belongs to a11ign/a11ign#5155 and is not run from this session.

Closes: a11ign/a11ign#5513
