---
"@a11ign/screenreader-fleet": patch
---

`stamp-provision-revision.ps1` no longer reads `packages/control/layers.json`, a file the core stopped laying and no longer declares (a11ign/a11ign#5087). It hashes the five environment files from where the installed packages put them: the fleet's two scripts from `node_modules/@a11ign/screenreader-fleet/`, and the worker's published `run-server.cmd` from `node_modules/@a11ign/screenreader-worker/launcher/`. The two fleet scripts are byte-identical (after CRLF normalisation) to this package's own copies, so their hashes are unchanged. The launcher is not: the published `run-server.cmd` is what runs on the box and differs from the worker repository's source file, so `provisionRevision` moves once, for every box provisioned after this lands.
