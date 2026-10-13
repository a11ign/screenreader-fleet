The package exports `./doctor` (`dist/doctor.mjs`, `dist/doctor.d.ts`), so control can restore its `#2034` same-words test against `fleetAgreementLine` without copying it. Row a11ign#5380, parent a11ign#5335.

- **Fix:** one `exports` entry, `./doctor`, beside the sixteen existing ones. The `doctor` entry is already built as a bin entry in `rslib.config.ts`, so `dist/doctor.mjs` and `dist/doctor.d.ts` are emitted by the existing build and no config change is needed.
- **Import has no side effects on argv:** `refuseUnknownFlags` at the top of `src/doctor.ts` runs on import but returns early unless `doctor` is the command, so a consumer's flags are not inspected. Checked by importing `dist/doctor.mjs` with `--role=calibration --bogus` and getting a clean exit.
- **Changeset:** minor, since the release adds an export.

Mutation: removing the `./doctor` entry from `package.json` makes the grep exit 1; with the entry it exits 0.

Hand-run: the row's Acceptance reads `origin/main` in the screenreader-fleet checkout, so it cannot pass before this merges. The session that closes row a11ign#5380 runs it after the merge and pastes the run on the row (the row's Done-when 1). Its pre-merge reading is below.

## Hand-run output

Pre-merge, at the PR's branch and at `origin/main` (`3ad6c2f`):

```
$ cd ~/repos/screenreader-fleet && git fetch -q origin && git grep -q -E '"\./doctor"' origin/main -- package.json; echo "exit $?"
exit 1
$ git grep -q -E '"\./doctor"' HEAD -- package.json; echo "exit $?"   # branch HEAD 069411a
exit 0
```
