---
"@a11ign/screenreader-fleet": patch
---

The repository counts its `.js`/`.mjs`/`.cjs` source against a committed baseline (`mjs-ratchet.baseline.json`, the basenames of today's 32 files) with `@a11ign/toolchain/mjs-ratchet`, called from `mjs-ratchet.test.ts`: a new such file fails the existing `test` command and is named, a drop passes. `@a11ign/toolchain` is pinned at 0.1.4, the release that carries it. Nothing shipped changes.
