`@a11ign/screenreader-worker` is pinned `0.1.0` -> `0.9.0` (the registry `latest`, read with `npm view @a11ign/screenreader-worker dist-tags` on 2026-10-09: `latest` is `0.9.0`), and `.github/dependabot.yml` gains `versioning-strategy: increase` on its `npm` entry. `pnpm-lock.yaml` regenerated; its diff touches only the worker's specifier, its package entry and its one dependency (`@guidepup/guidepup` 0.31.0).

- **The Dependabot cause is UNCONFIRMED.** `increase` is a candidate remedy, not a finding: the measured facts are on a11ign/a11ign#4443 (one Dependabot PR ever, on a caret spec; registry anonymous 200; no relevant `ignore`; the package is published, so Dependabot treats it as a library). Whether a bump pull request now opens for the three `@a11ign` exact pins is a11ign/a11ign#4650's reading, and the comment above the line in `dependabot.yml` says the same.
- This is the last of the three `@a11ign` pins at `0.1.0` in this repository: judge `0.5.1` and evidence `0.3.0` landed in #26 (a11ign/a11ign#4443); the worker waited on the fixture row (a11ign/a11ign#4648, closed) because 0.9.0 ships `dist/` only.

## Evidence (measured at this head, branched from `main` b1d9754)

- Acceptance, on `origin/main` (checked in a clean worktree before the edit): first command exit 1 (worker reads `0.1.0`), second exit 1 (no `versioning-strategy`). Here: both exit 0.
- `pnpm test`: `VERDICT pass: 230 tests in 36 files (4 skipped)` -- the same line at `origin/main`, so the four skips are not this change's. `pnpm run typecheck` exit 0. `pnpm run lint` exit 0, 68 warnings (0 errors).
- Limit: the suite passes on `origin/main` with the worker at `0.1.0` as well, so it does not by itself show the 0.9.0 pin is exercised; what it shows is that nothing that ran broke. The row's "230/230" reads here as 230 passed and 4 skipped, unchanged.

Acceptance: node -e "const p=require('./package.json'); const old=(v)=>v.replace('^','').startsWith('0.1.'); if(old(p.dependencies['@a11ign/judge'])||old(p.dependencies['@a11ign/screenreader-worker'])||old(p.devDependencies['@a11ign/evidence']))process.exit(1)" && grep -q "versioning-strategy: increase" .github/dependabot.yml && npx tsc --noEmit && npx rstest run

Mutation: none -- a dependency pin and a configuration key add no guard; the Acceptance is red on origin/main (worker `0.1.0`, no `versioning-strategy`) and green here.
