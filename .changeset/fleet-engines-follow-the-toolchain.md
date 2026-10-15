---
"@a11ign/screenreader-fleet": minor
---

`engines.node` is `>=22.15.0`, the floor of `@a11ign/toolchain` 0.9.0, which the fleet ships as a runtime `dependencies` entry (it moved there at 0.5.0). `engines` said `>=20` while a production dependency needed `>=22.15.0`, so a Node 20 consumer could install a dependency whose declared engine it does not satisfy. `ci.yml` runs Node 22, so `>=22.15.0` is the floor the repository tests; Node 20 is out of maintenance. `src/engines-floor.test.ts` pins that no runtime dependency's floor is above `engines.node`.
