---
"@a11ign/screenreader-fleet": minor
---

`fleetConsistency` compares `windowsBuild` (`<build>.<ubr>`, what the worker reports on `/health`) in its `REPORTED_ONLY` channel, so two boxes one cumulative update apart are named as drifting even though they share a `windowsVersion`. It gates nothing: `consistent` is unchanged by it, and it reads `unreported` on every box until a worker that carries the field is released and deployed. It graduates to `MUST_MATCH` once the fleet reads one value (#4405).
