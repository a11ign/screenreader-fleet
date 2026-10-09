---
"@a11ign/screenreader-fleet": minor
---

`@a11ign/screenreader-fleet/cli-flags` re-exports `@a11ign/toolchain/lib/cli-flags` instead of carrying its own copy of `refuseUnknownFlags`, `unknownFlags`, `didYouMean`, `flagValue` and `nameOf`, so the guard has one source (#4425). The subpath and its five names are unchanged for the lab and control. `@a11ign/toolchain` (0.5.0) moves from `devDependencies` to `dependencies`: a consumer of `cli-flags` now installs it at run time, and it declares `node >=22.15.0`.
