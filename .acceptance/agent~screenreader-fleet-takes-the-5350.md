The fleet-owned half of control's `src/fleet-layer/` tests moves here (a11ign#5345 step 2a, row #5350). Five whole files, and the fleet-owned half of ten split files, now live under `src/` and import this package's own modules. Control's copies are not deleted in this row.

## Whole files (Done-when 1)

- `src/npm-cli-executable.test.ts`, `src/git-safe-env.test.ts`, `src/fleet-scripts.test.ts`, `src/provision-stamp.test.ts`, `src/worker-fleet-does-not-read-control.test.ts`.
- They import `@a11ign/toolchain/lib/npm-cli-executable` and `@a11ign/toolchain/lib/git-env` (toolchain 0.5.0, the fleet's own dependency) beside the fleet's copies, and pin behaviour, not text.
- `provision-stamp.test.ts` cannot call core's `stampEnvironmentFiles`: it lives in `scripts/test-support`, which is not in this package. It parses the `$ENVIRONMENT_FILES` array locally. Its expectation is the parsed list, not the existence of `launcher/`, because installed `@a11ign/screenreader-worker` 0.9.0 ships no `launcher/` directory.
- `worker-fleet-does-not-read-control.test.ts` walks the published surface (`exports` and `bin`) and fails on any file reference that leaves the package. Its one exemption, `fleet-env.ts:134`, is read back by the test: that line must still mention `control`.

## Split files, fleet half (Done-when 2)

Mapped by file name, not yet confirmed line by line: each control file's fleet-owned half moved under the name shown.

- `cli-flags`, `display-mode`, `doctor`, `edge-pin-parity`, `fleet-consistency`, `worker-http-client-owner`, `worker-url`, `protocol-guard`: moved under the same name.
- `fleet-env.test.ts` to `fleet-env-inventory.test.ts`; `worker-code-check.test.ts` to `worker-code-check-drift.test.ts`.

## Evidence

- `pnpm exec rstest run` on the five whole files: 5 files, 20 tests, all passed.
- `pnpm test` in this worktree: 54 files, 394 passed, 4 skipped. The skips are in the tracked `src/built-package.test.ts`, which skips when the package is unbuilt.
- `pnpm run typecheck`: clean.
- `pnpm exec eslint` on the 15 new files: exit 0.
- Mutations, each followed by a `git diff --quiet` on the mutated tracked file to confirm it was restored:
  - `src/git-safe-env.ts` GIT_ prefix changed: 3 of 4 tests in `git-safe-env.test.ts` fail.
  - `src/fleet-scripts.ts` asset path changed: 1 of 2 tests fail.
  - `stamp-provision-revision.ps1` CRLF normalisation removed: 1 of 3 tests fail.
  - `stamp-provision-revision.ps1` throw replaced with a warning: 1 of 3 tests fail.
  - `src/fleet-env.ts:134` `"control"` renamed: the EXEMPT read-back test fails.
  - A planted `new URL("../../outside-leak.txt", …)` in a reachable module: the outside-reference guard fails and names the line.

## Not verified here

- **Toolchain gap:** `@a11ign/toolchain` 0.5.0 has no `lib/tree-wide-guard` and no `lib/local-import-closure`, which core's pinned `^0.1.7` line and `packages/` guards use. Those guards cannot be moved until the toolchain ships them. Named on the row.
- **`git-safe-env` byte equality:** not determined. The toolchain ships compiled output, so its TypeScript source cannot be compared to ours. The test pins behaviour instead.

Acceptance: git ls-files --error-unmatch src/npm-cli-executable.test.ts src/git-safe-env.test.ts src/fleet-scripts.test.ts src/provision-stamp.test.ts src/worker-fleet-does-not-read-control.test.ts
