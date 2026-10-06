---
"@a11ign/screenreader-fleet": patch
---

`a11ign-doctor` no longer reads the monorepo layout from its own module location in four more checks. The `primary checkout`, `isolation`, `dist-resolution` and `dist-freshness` checks took `../../../` as the repo root, which from an installed package is `node_modules`, so each reported on a directory that is not the machine's checkout (`…/node_modules/packages/judge/tsconfig.json`); outside a checkout they now report `n/a: installed package` as an advisory naming the directory, and inside one nothing changes. The `judge` check read the scorer's weights from `../../scorer/models/…`, so it said "present" or "missing" by where a package manager had put `@a11ign/scorer`; it now asks `@a11ign/scorer`'s own `scorerPaths()`, reached through `@a11ign/judge` (its peer), and says so when the scorer cannot be resolved.
