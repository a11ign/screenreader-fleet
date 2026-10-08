---
"@a11ign/screenreader-fleet": patch
---

The package is the repository root: `package.json`, `src/`, `README.md` and `rslib.config.mjs` moved up from `packages/worker-fleet/`, and the `repository.directory` field is gone. The published files are the same (`dist`, `src/local-worker`, `src/provisioning`, `README.md`, `LICENSE`) and no export, bin or `exports` path changed; `a11ign-doctor`'s DEGRADED advice now prints the absolute path of `provision-nvda-worker.ps1` instead of a monorepo-relative one, and `stamp-provision-revision.ps1` reads this layer's path from `layers.json` like the worker layer's.
