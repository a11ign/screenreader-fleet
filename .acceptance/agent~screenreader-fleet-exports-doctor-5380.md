The package exports `./doctor` (`dist/doctor.mjs`, `dist/doctor.d.ts`), so control can restore its `#2034` same-words test against `fleetAgreementLine` without copying it. Row a11ign#5380, parent a11ign#5335.

- **Fix:** one `exports` entry, `./doctor`, beside the sixteen existing ones. The `doctor` entry is already built as a bin entry in `rslib.config.ts`, so `dist/doctor.mjs` and `dist/doctor.d.ts` are emitted by the existing build and no config change is needed.
- **Import has no side effects on argv:** `refuseUnknownFlags` at the top of `src/doctor.ts` runs on import but returns early unless `doctor` is the command, so a consumer's flags are not inspected. Checked by importing `dist/doctor.mjs` with `--role=calibration --bogus` and getting a clean exit.
- **Changeset:** minor, since the release adds an export.

Mutation: the `./doctor` entry removed from a copy of `package.json` makes the grep exit 1; the branch's manifest exits 0.

Acceptance: bash -c 'cd ~/repos/screenreader-fleet && git fetch -q origin && git grep -q -E "\"\\./doctor\"" origin/main -- package.json'
