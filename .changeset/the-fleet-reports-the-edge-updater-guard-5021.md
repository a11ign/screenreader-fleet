---
"@a11ign/screenreader-fleet": minor
---

`fleetConsistency` compares `edgeUpdaterGuard.state` (`ok`, `drift`, `stale`, `absent` or `unknown`, what the worker reports on `/health`'s `environment` from the elevated guard task's record) in its `REPORTED_ONLY` channel, so a box whose Edge updater came back, or whose guard stopped or was never provisioned, is named as drifting from its peers even though the unelevated worker cannot read the updater's tasks itself. Only `state` is compared, because the record's `checkedAt` differs on every box. A field name may now be a dotted path into a block (`a.b`). It gates nothing: `consistent` is unchanged by it, and it reads `unreported` on every box until a worker that carries the field is released and deployed (#4405).
