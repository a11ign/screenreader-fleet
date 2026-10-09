---
"@a11ign/screenreader-fleet": patch
---

`a11ign-worker-code` and every capture's `assertFleetRunsThisCheckout` no longer throw on a layer clone laid at `@a11ign/screenreader-worker` 0.9.0 or later. The expected hash is the clone's own hasher over the clone's `src/`, and the hasher is `code-version.ts` there: the check imported `code-version.mjs` unconditionally, so it died with `Cannot find module …/packages/nvda-worker/src/code-version.mjs`. It now asks `code-version.ts` first and falls back to `code-version.mjs`, because `--layer-ref` can still deploy a guest at a layer sha from before the move to TypeScript. A clone holding neither is refused naming both files, never answered for by the installed copy.
