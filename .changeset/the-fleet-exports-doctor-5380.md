---
"@a11ign/screenreader-fleet": minor
---

The package exports `./doctor`, so `control` can import `fleetAgreementLine` and `missingExportTargets` by subpath instead of copying them. The subpath is built to `dist/doctor.mjs` and `dist/doctor.d.ts` beside the existing entries, and it is additive: the `a11ign-doctor` bin still runs the same file. Importing it runs nothing: the entry guard inspects argv only when `doctor` is the command.
