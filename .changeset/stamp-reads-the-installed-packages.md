---
"@a11ign/screenreader-fleet": patch
---

`stamp-provision-revision.ps1` no longer reads `packages/control/layers.json` to find its files. The fleet's two scripts are read from the installed `node_modules/@a11ign/screenreader-fleet/`, and the worker's published `run-server.cmd` from `node_modules/@a11ign/screenreader-worker/launcher/`. The two Ansible files stay under `packages/control`, where the core lays its pinned control layer. The two fleet scripts are byte-identical (after CRLF normalisation) to this package's own copies, so their hashes are unchanged. The launcher is not: the published `run-server.cmd` is what runs on the box and differs from the worker repository's source file, so `provisionRevision` moves once, for every box provisioned after this lands.
