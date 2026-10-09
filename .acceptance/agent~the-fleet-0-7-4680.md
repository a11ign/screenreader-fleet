`fleet-env.ts` no longer imports `./cli-flags.ts`, so nothing `control` reaches names `@a11ign/toolchain`: it reads `--inventory=`/`--group-vars=` with an in-file `flagValue` and runs the unknown-flag refusal from `main()` (the CLI-entry path) instead of at module top. The published `./cli-flags` subpath stays the toolchain re-export (the row's ruling), so no second copy of the shared guard is added to it.

- **Deviation from the row's Acceptance line 1, for `product-manager`:** the row greps `src/cli-flags.ts` as well, and that file IS the re-export the ruling says to keep, so the literal command still prints one hit (`src/cli-flags.ts:6`). `fleet-env.ts` and `worker-http.ts`, the files `control` reaches, print none, and that is what the Acceptance below runs. Nothing in `control` reaches `cli-flags.ts` any more; if the literal line is wanted, the choice is a self-contained `cli-flags.ts` (a second copy of the guard, against #4425), which is the row's to rule.
- **Test:** new `src/fleet-env.test.ts`: loads `fleet-env.ts` and its relative closure from a temp directory with no `node_modules` above it (fails on `origin/main` with `ERR_MODULE_NOT_FOUND … '@a11ign/toolchain' imported from …/cli-flags.ts`), a positive control that the toolchain re-export fails in that directory, the library import never refusing, the CLI refusing `--lisst` with exit 2, and agreement with the toolchain's `unknownFlags`/`flagValue` on 12 flag shapes and the value shapes.
- **No second guard in a published subpath:** the in-file check does not suggest the nearest flag (`did you mean`), which the toolchain's does; the decision and exit code are pinned equal, the suggestion text is not.
- Changeset: patch (release as 0.7.1 or later; the core's pin bump is a11ign/a11ign#4681).

## Evidence (measured at this head, in the fleet worktree)

- Acceptance 1 (scoped as above) prints nothing, exit 0; the row's literal form prints `src/cli-flags.ts:6`. Acceptance 2 (`npx tsc --noEmit`) exit 0. Acceptance 3: `VERDICT pass: 6 tests in 1 file`.
- Whole suite `pnpm test`: `VERDICT pass: 240 tests in 37 files`; `pnpm run lint` 0 errors (68 pre-existing warnings); `pnpm run build` ok and `dist/fleet-env.mjs` loads.
- **Mutation** (`fleet-env.ts` restored from a copy and `diff`ed identical each time): `origin/main`'s `fleet-env.ts` fails 3 of 6 (the bare load, the library import, the agreement test); the guard never firing fails 1 (the CLI refusal); the guard firing on import fails 1 (the library import); the single-dash rule dropped fails 1 (the agreement test). Restored: 6 of 6.

Acceptance: bash -c '! git grep -nE "from \"@a11ign/" -- src/fleet-env.ts src/worker-http.ts' && npx tsc --noEmit && npx rstest run src/fleet-env.test.ts

Mutation: origin/main's fleet-env.ts fails 3 of 6 (bare-directory load, library import, flag-shape agreement); the guard never firing fails the CLI refusal; the guard firing on import fails the library import; dropping the single-dash rule fails the agreement test; restored file diffed identical, 6 of 6 pass.
