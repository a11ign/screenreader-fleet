`@a11ign/screenreader-fleet` now carries the two programs the core ran from this repository's source: `bin` gains `a11ign-guest-run` (`./dist/guest-run.mjs`) and `a11ign-normalise-fleet` (`./dist/normalise-fleet.mjs`), `rslib.config.ts` builds both beside the existing three, and `files` gains `src/guest`, the `.cmd` the normaliser sends to each guest.

## What a host sees

- **The guest script path moved only in the BUILT file.** From `src/normalise-fleet.ts` the script is `src/guest/normalise-fleet.cmd`, as it was; from `dist/normalise-fleet.mjs` it is now `../src/guest/normalise-fleet.cmd`, which is the same file one level up. The source layout is unchanged and **no guest-side file changed** (`git diff --stat` below names none under `src/guest`).
- The normaliser runs its sibling by THIS module's extension: `src/guest-run.ts` from `src`, `dist/guest-run.mjs` once built. `node src/normalise-fleet.ts` still works.
- **A defect found on the way, and fixed in the same two files:** both programs guarded `main` with `import.meta.url === pathToFileURL(process.argv[1])`, which reads false when npm reaches a bin through its `.bin` symlink (`import.meta.url` is realpath'd and `argv[1]` is not), so a published `a11ign-guest-run` would have loaded, done nothing and exited 0. `check-worker-code.ts` already carries the fix; both now use its form. `normalise-fleet`'s guard is changed by the same line and is NOT exercised through a symlink by a test, because running its `main` shells out to `utmctl` and drives DISM on a real guest on a host that has UTM.

## Evidence (measured at this head, Node and pnpm as in CI)

- `pnpm exec rstest run src/bins-published.test.ts`: 5 passed, 0 skipped. `pnpm test`: 256 tests in 39 files pass. `pnpm run lint`: 0 errors. `pnpm run typecheck`: clean. `pnpm run build` emits `dist/guest-run.mjs` and `dist/normalise-fleet.mjs`, and no `.cmd` or stray asset under `dist`.
- **Positive control:** `npm pack --dry-run --json` lists `dist/guest-run.mjs`, `dist/normalise-fleet.mjs` and `src/guest/normalise-fleet.cmd`. **Negative control:** a copy of the package with `src/guest` removed from `files` lists none of the `.cmd` while still listing `dist/guest-run.mjs` (and the unmodified copy lists it, so the control is not the copy losing it).

Acceptance: pnpm exec rstest run src/bins-published.test.ts

Mutation: each break was made with `cp` before and `cp` + `diff` after (byte-identical), `pnpm run build` rerun, and `src/bins-published.test.ts` run.
- `src/guest` removed from `files`: red, three cases (the manifest, the packed list, the negative control's unmodified-copy assertion). Restored: green.
- `normalise-fleet.ts` pointed back at `./guest/normalise-fleet.cmd`: red, one case, "the BUILT normalise-fleet finds the guest script and guest-run from `dist`". Restored: green.
- `GUEST_RUN` pointed back at `./guest-run.ts`: red, the same one case (the built sibling would be a `.ts` the tarball does not hold). Restored: green.
- `guest-run.ts`'s guard without `realpathSync`: red, one case, the symlink run exits 0 where the real path exits 2. Restored: green.
- Not done: the guard "always fires" direction, because the guard has one condition and the real-path run in the same test is its positive control.

Not in this row: a release tag, or the core's `package.json` (row 4, which waits on the published version).
