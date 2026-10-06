---
"@a11ign/screenreader-fleet": minor
---

`a11ign-worker-deploy` is removed. It pushed each worker file from `workerSourceDir()`, which is `dist/` in the built `@a11ign/screenreader-worker` and holds no `capture-core.mjs`, so against an installed package it threw ENOENT; a guest runs the raw `src/*.mjs` (ADR 0031), so the fix could not be to read `dist` either. It was already the UTM path `warnUtmDeprecated` warns about, no fleet box was reachable by it, and nothing in the package or the core ran it: the fleet deploys by Ansible (`fleet:deploy`). `a11ign-worker-code`'s remedy for a stale worker outside `inventory.yml` says no command deploys to it, where it named the removed one.
