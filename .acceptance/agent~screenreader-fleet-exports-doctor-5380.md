The package exports `./doctor` (`dist/doctor.mjs`, `dist/doctor.d.ts`), so control can restore its `#2034` same-words test against `fleetAgreementLine` without copying it. Row a11ign#5380, parent a11ign#5335.

Acceptance: `bash -c 'cd ~/repos/screenreader-fleet && git fetch -q origin && { git grep -q -E "\"\\./doctor\"" origin/main -- package.json || git grep -q -E "\"\\./doctor\"" origin/agent/screenreader-fleet-exports-doctor-5380 -- package.json; }'`

- **Fix:** one `exports` entry, `./doctor`, beside the sixteen existing ones. The `doctor` entry is already built as a bin entry in `rslib.config.ts`, so `dist/doctor.mjs` and `dist/doctor.d.ts` are emitted by the existing build and no config change is needed.
- **Import has no side effects on argv:** `refuseUnknownFlags` at the top of `src/doctor.ts` runs on import but returns early unless `doctor` is the command, so a consumer's flags are not inspected.
- **Changeset:** minor, since the release adds an export.

Mutation: removing the `./doctor` entry from `package.json` makes the grep exit 1; with the entry it exits 0.
