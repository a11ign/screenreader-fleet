`command-line-census.ts` imports `stripComments` from `@a11ign/toolchain/lib/source-text` (a runtime dependency) instead of `@a11ign/evidence/source-text` (a devDependency the core is removing, a11ign/a11ign#4589). The header comment moves with the import; a changeset is added. `@a11ign/evidence` stays in `package.json` as a devDependency: nothing else in `src` or `scripts` names it, but `package.json` is outside the row's Region, so dropping it is left to a follow-up.

## Evidence (measured at this head, branched from `origin/main` f05a0ce)

- `git grep -nE "@a11ign/evidence/source-text" -- src` exits 1 (no match) here; on `origin/main` it printed lines 24 and 30.
- `pnpm exec rstest run`: `VERDICT pass: 239 tests in 37 files (4 skipped)`. `pnpm run typecheck` exit 0. `pnpm run lint` exit 0, 68 warnings (0 errors).
- Limit: no test file imports `command-line-census`, so the suite shows nothing broke and `tsc` shows the new subpath resolves in the installed toolchain; it does not exercise `stripComments` through this module.

Acceptance: bash -c '! git grep -nE "@a11ign/evidence/source-text" -- src' && pnpm exec rstest run

Mutation: none -- an import specifier moves and no guard is added; the first command is red on `origin/main` (two matches) and green here.
