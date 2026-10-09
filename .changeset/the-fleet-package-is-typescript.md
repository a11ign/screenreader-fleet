---
"@a11ign/screenreader-fleet": patch
---

The package's source is TypeScript: its 32 `.mjs` (the 29 modules under `src/`, plus `eslint.config`, `rstest.config`, `rslib.config` and `isolation-smoke`) became `.ts` by the toolchain's `js-to-ts`, and the repository's `mjs-ratchet.baseline.json` is empty, so a new `.js`, `.mjs` or `.cjs` fails the ratchet. Published files, `exports` subpaths and `bin` commands are unchanged; the `types` condition of each subpath now names `./dist/<name>.d.ts` instead of `.d.mts`, because Rslib declares a `.ts` source as `.d.ts`. `@a11ign/toolchain` moves to 0.3.1 (its base tsconfig carries `erasableSyntaxOnly` and `rewriteRelativeImportExtensions`), and `jiti` (ESLint reads `eslint.config.ts` through it) and `tsx` (the tests that start a source file as a child process run it under `node --import`) are dev dependencies. The 68 `any` the script wrote where the JSDoc named no type are warnings in six files, not errors.
