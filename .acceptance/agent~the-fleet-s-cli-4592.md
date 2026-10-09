The fleet's `src/cli-flags.ts` becomes five named re-exports from `@a11ign/toolchain/lib/cli-flags` (phase 3 of #4425). The published subpath `@a11ign/screenreader-fleet/cli-flags` and its names (`didYouMean`, `flagValue`, `nameOf`, `refuseUnknownFlags`, `unknownFlags`) are unchanged; `dist/cli-flags.mjs` exports exactly those five.

- `@a11ign/toolchain` moves from `devDependencies` (0.3.1) to `dependencies` (0.5.0, the first release exporting `./lib/cli-flags`). **For `ceo`:** every consumer of the fleet now installs the toolchain at run time, and it declares `node >=22.15.0` against this package's `>=20`. I left `engines` alone (outside the row's Region).
- **Named, not `export *`:** the first attempt used `export *`; Rslib turned it into an empty namespace object and `dist/fleet-env.mjs` failed with "refuseUnknownFlags is not a function" (1 of 230 tests failed). Named re-exports fix it, and the file's comment says why.
- Changeset: minor.

Evidence (measured at this head, in the fleet worktree): the row's three commands all exit 0; `pnpm run build` ok; `pnpm run typecheck` clean; `pnpm run lint` 0 errors (68 pre-existing warnings); `pnpm test` -> `VERDICT pass: 230 tests in 35 files`.

Acceptance: bash -c '! grep -q "export function" src/cli-flags.ts && grep -q "@a11ign/toolchain/lib/cli-flags" src/cli-flags.ts && node -p "Object.keys(require(\"./package.json\").dependencies).includes(\"@a11ign/toolchain\")" | grep -qx true'

Closes a11ign/a11ign#4592

🤖 Generated with [Claude Code](https://claude.com/claude-code)
