A11-205 step 5 of 5. The bootstrap holds no Edge or Node version, URL or hash: it reads them from control's pins manifest, which `serve-bootstrap.sh` now serves beside it (as a symlink, so an edit reaches the next box) and `autounattend.xml` fetches to `C:\a11y\deploy-pins.json`. With neither the manifest nor an `A11Y_*` override the bootstrap stops and names what to give it.

Acceptance:
```bash
f=src/provisioning/bootstrap-windows-worker.ps1
! grep -vE '^\s*#' "$f" | grep -qE '\b[0-9]{3}\.0\.[0-9]{4}\.[0-9]+\b|\bv[0-9]+\.[0-9]+\.[0-9]+\b|\b[0-9a-f]{64}\b|delivery\.mp\.microsoft\.com' \
  && grep -q "Get-Pin 'A11Y_EDGE_VERSION' \$pins.edge.version" "$f" \
  && grep -q "deploy-pins.json" src/provisioning/bare-metal/autounattend.xml \
  && pnpm exec rstest run src/edge-pin-parity.test.ts
```

Mutation: the Edge version line was put back to a literal, and then `autounattend.xml` stopped fetching the manifest; each time the matching test went red (`the bootstrap holds no Edge or Node version...`, `the media fetches the manifest...`) and the suite passed again when restored. `serve-bootstrap.sh` was changed to copy the manifest instead of linking it: `serves an edit made after it started` went red.

Consumer-declaration: `serve-bootstrap.sh`'s arguments change from `<key> [port]` to `<key> <pins> [port]`; its callers are `a11y-bootstrap.service` (updated here) and the bare-metal README (updated). Control's `edge-pin-parity.test.ts` and `node-pin-parity.test.ts` read the bootstrap's literals; they keep reading the previously released bootstrap until control takes this release, which waits on the core's fleet pin (A11-183's follow-up).
