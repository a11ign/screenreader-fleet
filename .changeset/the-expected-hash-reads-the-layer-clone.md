---
"@a11ign/screenreader-fleet": minor
---

The hash `a11ign-worker-code` and every capture's `assertFleetRunsThisCheckout` expect is the layer CLONE's, the one `fleet:deploy` and the lab already ask for (`layerCodeVersion("nvda-worker")`): the clone's own `code-version.mjs` over the clone's `src/`. It read the installed `@a11ign/screenreader-worker` before, so the first guest deployed at a layer sha whose `.mjs` differed from the release (what `--layer-ref` is for) made every worker read STALE, with a remedy ("redeploy") that could not clear it. With no clone it falls back to the installed package and the output says so. The clone is found from the checkout root's `packages/control/layers.json`, the root being the cwd or the new `checkoutRoot` option; a clone that is there and cannot hash is refused, never answered for by the installed copy. With a clone, the dirty-tree note reads the clone's git tree again.

**Breaking:** `expectedWorkerCode()` is replaced by `resolveExpectedWorkerCode({ checkoutRoot })`, which is ASYNC (the clone's hasher can only be imported dynamically) and returns `{ code, source, sourceDir, note }`. The one caller outside the package is the core's own `worker-code-check.test.ts`, which moves with the bump.
