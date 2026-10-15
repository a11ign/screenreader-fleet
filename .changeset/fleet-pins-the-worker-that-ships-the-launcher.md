---
"@a11ign/screenreader-fleet": patch
---

`@a11ign/screenreader-worker` is pinned at 0.13.2, which publishes `launcher/run-server.cmd` and `launcher/apply-foreground-lock-timeout.ps1`. Releases 0.9.0 to 0.12.0 publish `dist` only, and `stamp-provision-revision.ps1` throws when either hashed path is absent, so a consumer taking the fleet's own pin failed at provisioning before it wrote its stamp. `src/provision-stamp.test.ts` now asserts both files exist in the installed worker package.
