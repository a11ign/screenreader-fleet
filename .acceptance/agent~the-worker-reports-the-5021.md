The fleet reports the Edge-updater guard's state (a11ign#5021, item 3 of a11ign#4405), the second pull request on the row: `fleetConsistency` lists `edgeUpdaterGuard.state` in `REPORTED_ONLY` beside `windowsBuild`, so `fleetStatus` hands it to `fleet-watch` in `reportedOnly` and a box whose updater came back (`drift`), whose guard stopped (`stale`) or was never provisioned (`absent`) is named against its peers. The worker's half is a11ign/screenreader-worker#45. Only the guard's `state` is compared (the record's `checkedAt` differs on every box), so `readField` now walks a dotted key (`a.b`); a missing, `null` or non-object segment reads as "not reported".

Acceptance:

```bash
git grep -q "edgeUpdaterGuard.state" -- src/fleet-consistency.ts
pnpm exec rstest run src/edge-updater-guard-field.test.ts
```

Evidence (measured in this worktree at the head of this branch): the rstest command exits 0 with 7 tests passing in `src/edge-updater-guard-field.test.ts`, which did not exist on `main`; `src/windows-build-field.test.ts` still passes beside it; `pnpm run lint` (0 errors) and `pnpm run typecheck` clean; `pnpm run build && pnpm exec rstest run` -> 250 tests in 38 files passed.

Mutation: each break turned its own test(s) red (5 mutations, each restored byte-identical and diffed): `readField` reading `block[key]` instead of walking the path (5 of 7 tests fail); the entry comparing the whole record instead of `state` (6); the entry dropped (6); the walk reading through a `null` segment (3); the entry's "NOT a gate yet" exit dropped (1). One first mutation survived, a `typeof` check on each segment that no real path could distinguish from `?.`, so it was deleted rather than kept as a guard that decides nothing.

Not verified here: a live fleet reading. The comparison is run for real over fixture guests; no worker carries the field until the worker's pull request is released and deployed, so every box reads `unreported` today. A uniform non-`ok` state across the whole fleet (every guard `absent`, say) is agreement and so is not named in `reportedOnly`: that is the drift report's reading to take from the values (the row after this one), not this channel's.

Closes a11ign/a11ign#5021
