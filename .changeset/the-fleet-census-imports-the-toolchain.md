---
"@a11ign/screenreader-fleet": patch
---

`command-line-census` imports `stripComments` from `@a11ign/toolchain/lib/source-text`, which is a runtime dependency of this package, instead of from `@a11ign/evidence/source-text`, a devDependency that the core is removing (a11ign#4589). The census behaves the same.
