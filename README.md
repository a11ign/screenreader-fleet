# screenreader-fleet

Host-side lifecycle, health and capacity for a fleet of Windows NVDA capture workers: lease one, judge whether it is degrading, and
know how many the host can afford. Moved here from [`a11ign/a11ign`](https://github.com/a11ign/a11ign) with its history
(`packages/worker-fleet`).

| | |
|---|---|
| [`packages/worker-fleet`](packages/worker-fleet) | `@a11ign/screenreader-fleet`, **AGPL-3.0-or-later**. See its README. |

The root [`LICENSE`](LICENSE) is the package's, byte for byte. It depends on [`@a11ign/screenreader-worker`](https://github.com/a11ign/screenreader-worker)
and `@a11ign/judge` **by name, from the registry**.

**The fleet drives workers that have no authentication.** Anyone who can reach a worker's port can drive the browser and the screen
reader on that machine (`SECURITY.md` in `a11ign/a11ign` says what else somebody must know first). Run it only on a network you control.

## Working here

```bash
pnpm install --frozen-lockfile
pnpm test        # what the `gate` check runs on every pull request and merge-queue entry
```

`main` takes pull requests only, each with one approving review, through the merge queue.

## What did not come across: 27 tests

The package's test directory was written for the monorepo, and 27 of its 53 test files read something that is not in this repository:
`packages/control`'s playbooks and inventories, `packages/lab`'s capture clients, the private `guards` package, or the root's
`scripts/`. Run here, they fail on a file they cannot find, so they were **not** carried into this repository; they stay in
`a11ign/a11ign`, beside what they read, until its row #3504 relocates them. Their names are the `COUPLED` list in
`packages/lab/src/packaging/screenreader-fleet-extraction.test.ts` there. The other 26 run here and are what `gate` runs, with
`scripts/package-boundary.test.ts` holding the package to its own directory.

## Releasing

This repository releases on its own, not with `a11ign/a11ign`. A change that should reach npm carries a changeset
(`pnpm exec changeset`); its merge opens the **Version packages** pull request, and **merging that is the release**
(`.github/workflows/release.yml`, `.changeset/README.md`). The publish uses npm trusted publishing over OIDC with
provenance and no stored token. The first release, 0.1.0, is the merge of the pull request that added the workflow: the
registry holds only the reservation `0.0.0-reserved.0`, so the manifest is ahead of it and no changeset is pending.
