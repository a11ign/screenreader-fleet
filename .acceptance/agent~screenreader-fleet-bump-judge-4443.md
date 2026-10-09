`@a11ign/judge` is bumped `0.1.0` -> `0.5.1` and `@a11ign/evidence` `0.1.0` -> `0.3.0` (registry `latest` read anonymously 2026-10-09; judge's `latest` has since moved only as far as the row recorded, 0.5.1 is what was verified). `pnpm-lock.yaml` regenerated; its diff touches only these two.

- **Not in this PR:** `@a11ign/screenreader-worker` stays `0.1.0`. 0.9.0 ships `dist/` only and the clone fixture needed a rewrite (a11ign/a11ign#4648, closed); the worker pin and `versioning-strategy: increase` are a11ign/a11ign#4649, and whether Dependabot then opens an exact-pin bump is #4650.
- **Dependabot finding (a11ign/a11ign#4443):** cause NOT determined. Measured: one Dependabot PR has ever existed here (#16, caret `^8.71.1`); every exact pin was skipped; registry reachable anonymously; no `.npmrc`; the only `ignore` is `@a11ign/screenreader-fleet`. Candidate, unconfirmed: `versioning-strategy: increase`, shipped with #4649.

## Evidence (measured at this head, rebased on `main` 7b8c0b6)

- Acceptance: exit 0 (red on `origin/main`, where both read `0.1.0`).
- `pnpm test`: `VERDICT pass: 234 tests in 36 files`. `pnpm run typecheck` clean. `pnpm run lint` 0 errors (68 warnings, same count as base).
- Limit: this is a pin bump, so there is no guard to mutate; the suite passing against judge 0.5.1 and evidence 0.3.0 is the whole claim.

Acceptance: node -e "const p=require('./package.json'); const old=(v)=>v.replace('^','').startsWith('0.1.'); if(old(p.dependencies['@a11ign/judge'])||old(p.devDependencies['@a11ign/evidence']))process.exit(1)" && pnpm run typecheck && pnpm test

Mutation: none -- a dependency pin change adds no guard; the Acceptance is red on origin/main (both pins 0.1.0) and green here.
