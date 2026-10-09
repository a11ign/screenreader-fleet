The fleet's `release.yml` called toolchain's `release-per-merge.yml` at `5ea3fc027eb0891d6329e6a02c2d4ed1c679178a`, 23 commits **behind** `d1693f3` (a11ign/a11ign#4121, "a package's base is the highest tag that can be its own"). The release #4651's merge (`7b8c0b6f`) should have shipped as 0.6.1 re-cut `v0.6.0`, published nothing and failed at the tag step: the repository holds both tag forms (`@a11ign/screenreader-fleet@0.5.2` and the lone `v0.5.3`, `v0.6.0`), the case #4121 fixes. The called workflow checks its tool out at the caller's pinned sha, so the fix reached nothing until the `uses:` line moved.

- **Change:** one line, `.github/workflows/release.yml`: the pin moves to `05c2418b142fbc5bb104f184f16a72b9f57a31b1`. The reusable workflow is not edited, and no input, permission or step of the caller changed.
- **Why `05c2418` and not toolchain's `main` (`ab60ac6`):** `05c2418` contains `d1693f3` (`git merge-base --is-ancestor`), and it is the sha toolchain's OWN `release.yml` pins today; toolchain's release run on `ab60ac6` (run 37974402787) ran `version`, `publish` and `tag` green through it. The only change to the release workflow after `05c2418` is the rename of its script `release-per-merge.mjs` to `.ts`, which brings no fix for this and makes the called job depend on Node running a `.ts` file. **The pin therefore trails toolchain's `main` on purpose**: a release that still does not publish after this merges is a NEW cause, not this row unfinished.
- **Inputs at the pin:** `kind`, `gate-check` and `node-version` are still inputs of the workflow at `05c2418`, which is what the caller passes (`kind: npm`, `gate-check: gate`).
- **Tag forms the repository holds:** `@a11ign/screenreader-fleet@0.5.2` (the named form) and `v0.5.3`, `v0.6.0` (the lone form).
- **Not done here:** the reading of the push run this merge starts (it carries #4651's unconsumed patch changeset) is a11ign/a11ign#4658's, which waits on the registry (`@a11ign/screenreader-fleet@latest >= 0.6.1`).

## Evidence (measured, in the fleet worktree)

- `gh api repos/a11ign/toolchain/compare/d1693f33...5ea3fc027eb0891d6329e6a02c2d4ed1c679178a --jq .status` answered `behind` (before); `...05c2418b142fbc5bb104f184f16a72b9f57a31b1` answers `ahead` (after).
- Fleet suite at this head: `pnpm test` `VERDICT pass: 230 tests in 36 files (4 skipped)`; `scripts/release-workflow.test.ts` 14 of 14 (its "calls the reusable per-merge workflow, pinned by full sha" property still holds); `pnpm run typecheck` clean; `pnpm run lint` 0 errors (68 warnings, unchanged).
- A workflow-only change: `src/` is the only releasable path, so no changeset and no `no-release:` line is needed.

Acceptance: bash -c 'gh api repos/a11ign/toolchain/compare/d1693f33...$(grep -o "release-per-merge.yml@[0-9a-f]*" .github/workflows/release.yml | cut -d@ -f2) --jq .status | grep -Eq "^(ahead|identical)$"'

Mutation: put the old pin `5ea3fc027` back: the status reads `behind` and the command exits 1; replaced the pin with `@main`: the compare is a 404 and the command fails. Each restored from a copy and diffed identical; restored, it exits 0.

Closes a11ign/a11ign#4666
