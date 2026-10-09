`resolveExpectedWorkerCode` (behind `a11ign-worker-code` and every capture's `assertFleetRunsThisCheckout`) imported the layer clone's hasher as `code-version.mjs` unconditionally. `@a11ign/screenreader-worker` 0.9.0 ships `code-version.ts` only, so the check threw `Cannot find module …/packages/nvda-worker/src/code-version.mjs` on a core that lays that release (found by a11ign/a11ign#4516).

- **Fix:** the clone's hasher is resolved as `code-version.ts` first, then `code-version.mjs` (`cloneHasherPath`). A clone with neither is refused with an error naming both paths, never answered for by the installed copy.
- **Which fallback, as the row asked to be said:** the `.mjs` fallback is KEPT. `--layer-ref` deploys a guest at any layer sha, and one from before the worker moved to TypeScript has only the `.mjs`; the pin is `0.1.0` today and is still the `.mjs` form. Refusing it would turn a correctly deployed guest into a throwing check.
- **Comments** on the two lines the row named (the subpath-import note and `resolveExpectedWorkerCode`'s doc block) no longer say the hasher is `.mjs`.
- **Test:** new `src/worker-code-check.test.ts`, four fixtures, each a raw-`src` clone holding only the files its test names: `.ts` only (the 0.9.0 shape), `.mjs` only (the pre-move shape), both (the `.ts` wins), neither (refused naming both). Each hasher returns a distinct constant so a reading names the file that answered it.
- **No changes outside the Region** (`src/worker-code-check.ts`, `src/worker-code-check.test.ts`, `.changeset/`). Two comments elsewhere still name `code-version.mjs` as the worker's hasher (`src/control-plane-isolation.ts:19` and `:58`); they are outside the Region and are recorded on the row.
- **Not done here:** the fleet release and the core's lockfile bump (the row's Done-when 2; the bump is `product-manager`'s to file).

## Evidence (measured at this head, in the fleet worktree)

- Acceptance 1 prints nothing, exit 0. Acceptance 2 (`npx tsc --noEmit`) exit 0. Acceptance 3: `VERDICT pass: 4 tests in 1 file`.
- Whole suite `pnpm test`: `VERDICT pass: 230 tests in 36 files (4 skipped)`; `pnpm run typecheck` clean; `pnpm run lint` 0 errors (68 pre-existing warnings).
- **Real worker source, both lines:** `git archive` of `a11ign/screenreader-worker` `origin/main` `src/` (holds `code-version.ts`, no `.mjs`) laid as the clone of a checkout root. The new code answers `clone 25bb45d9b38d7a62`; the same call against `origin/main`'s `worker-code-check.ts` dies with `ERR_MODULE_NOT_FOUND … packages/nvda-worker/src/code-version.mjs`, the row's error.
- **Mutation, both directions** (file restored from a copy and `diff`ed identical): forcing the old always-`.mjs` choice fails 3 of the 10 tests in this file plus `worker-code-clone.test.ts` (the `.ts`-only, both-present and neither cases); forcing always-`.ts` fails 5 of 10 (the `.mjs`-only case and the `worker-code-clone.test.ts` clone cases, whose clone is `.mjs`). The restored file passes 10 of 10.
- **Limit:** the fixtures import a `.ts` file by `file:` URL, which needs type stripping (Node 24 here) or `tsx`; the check's own entry runs under `TSX_ARGS`, as before.

Acceptance: bash -c '! git grep -nE "code-version[.]mjs\"" -- src/worker-code-check.ts' && npx tsc --noEmit && npx rstest run src/worker-code-check.test.ts
