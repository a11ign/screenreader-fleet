---
"@a11ign/screenreader-fleet": minor
---

The package publishes `guest-run` and `normalise-fleet` as `bin` commands, `a11ign-guest-run` and `a11ign-normalise-fleet`, so a consumer runs them from the installed package and never from this repository's source (a11ign/a11ign#5081, ADR 0045). `files` gains `src/guest`, the `.cmd` the normaliser sends to each guest; the built `normalise-fleet` finds it as `../src/guest/` and runs the built `guest-run.mjs` beside it, where it ran a `.ts` that does not ship. Both commands' entry guards now compare the REAL path of `argv[1]`, so a bin reached through npm's `.bin` symlink runs instead of loading and exiting 0. `normalise-fleet` also exports `guestPaths()`, which the pack test reads from `src` and from `dist`.
