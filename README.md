# `@a11ign/screenreader-fleet`

Host-side lifecycle, health and capacity for a fleet of Windows NVDA capture workers. Runs on the machine that
*drives* the workers — no NVDA, no guidepup, no Windows.

```bash
npm install @a11ign/screenreader-fleet
npx a11ign-doctor          # can I run right now? every check names its own fix
```

```js
import { leaseWorker } from "@a11ign/screenreader-fleet";

const lease = await leaseWorker({ after: "stop" });
try {
  // ... capture against lease.url
} finally {
  await lease.release();   // puts the VM back the way it was found
}
```

## A lease, not a lifecycle you own

`leaseWorker` decides what to capture against in priority order: an explicit worker you named, then
`inventory.yml`'s bare-metal fleet if one is declared, then a **local UTM VM (deprecated — "The UTM is
deprecated, that was a testing thing," repository owner, 2026-09-05)**, then the historical
`http://localhost:8765` default. Reaching the UTM branch prints a warning naming `fleet:*` as the
replacement; it is not refused outright because some machines still only have a UTM guest to reach, and
deleting the ~2,460 lines that manage it is a separate decision from warning about it. Only the VM case
has a lifecycle to manage — a bare-metal box is always on — so `release()` is a no-op for every other
source. It starts what is missing and **puts a VM back as it found it**: one that was already running is
left running, a stopped one is stopped again. A long run must not shut down something another run is
using.

**Stopped worker VMs are the correct resting state.** `all stopped` is a READY state, not a fault — `a11ign-doctor`
says so explicitly, because "go and start a worker" is the wrong instinct and costs time.

**The local UTM VM is not how this project's own corpus is captured.** It is the DEPRECATED default for a
solo contributor with no bare-metal fleet, kept working precisely because it is still the right path for
that case — this repo's own corpus is captured on ten bare-metal workers driven by
`inventory.yml`, which `leaseWorker` checks first. If you are consuming this package standalone with your
own Windows box, the VM lifecycle below still applies to you exactly as written.

## Capacity is measured, never assumed

```js
import { availableHostMemoryMb, workersHostCanRun } from "@a11ign/screenreader-fleet/capacity";
```

A worker VM costs the host **~8 GB**, not the 4 GB it is configured with — QEMU's overhead on top of guest RAM
that Windows dirties and never returns. So three do not fit on a 36 GB Mac, and over-committing does not merely
slow a run: the same page took 44.5 s with three guests up and 27.4 s with one, and the starved guests produced
"NVDA is running but not speaking" failures and `/health` blackouts. From outside that reads as *the workers are
degrading*, which is how it was misdiagnosed for a day.

Two rules follow, both learned the hard way:

- **Never `os.freemem()`.** It reported 402 MB on a host with ~12 GB to give, because macOS counts compressed
  and inactive pages as used. The reading comes from `vm_stat`.
- **`vm_stat` is distorted by the very condition it must detect** — a swapped-out guest's pages count as
  available, so the estimate *rises* as the host gets sicker; it advertised 13.7 GB free while two guests were
  starving. The cap is therefore the lower of that estimate and a ceiling derived from physical RAM, which no
  feedback loop can move.

## Health: watch `recoveries`, not failures

```js
import { assessWorker } from "@a11ign/screenreader-fleet/health";
```

The worst worker fault this fleet has had produced **zero failures**. One guest's NVDA went mute on 4 of 4
captures, the worker's own retry absorbed every one, so every capture succeeded and the eviction rule — three
consecutive *failures* — could never fire. The only symptom was 122.9 s per capture against a healthy peer's
40.6 s.

`vitals.recoveries` counts the faults a worker papered over. It is the number that rises while everything still
appears to work.

## The provisioning scripts ship with the package

```js
import { fleetScriptPaths } from "@a11ign/screenreader-fleet";
fleetScriptPaths().workerCtl;   // absolute path to worker-ctl.sh
```

They are shell, so a consumer spawns them, and they are resolved from the module rather than the cwd — a
cwd-relative path is right exactly when the cwd is the repo root. Getting that wrong is not subtle: during this
extraction `doctor` reported "no local VM tooling here" on a host with three registered VMs.

**macOS + UTM** is what the VM lifecycle assumes. `utmctl` needs the UTM app running, or a perfectly healthy VM
reports its state as `unknown`; and UTM cannot suspend a guest with an emulated NVMe device, so stop/start is
the only real lifecycle — a cold boot to ready is 15–45 s, which is fine.

Not exported: `host-metrics`, `worker-stats`, `fleet-consistency`. They are measurement internals whose shapes
change every time something new gets measured.

## Working here

This repository is the package: `package.json`, `src/` and this README sit at the root, and the README is the npm page. It moved here from
[`a11ign/a11ign`](https://github.com/a11ign/a11ign) with its history. It depends on
[`@a11ign/screenreader-worker`](https://github.com/a11ign/screenreader-worker) and `@a11ign/judge` **by name, from the registry**.

**The fleet drives workers that have no authentication.** Anyone who can reach a worker's port can drive the browser and the screen
reader on that machine (`SECURITY.md` in `a11ign/a11ign` says what else somebody must know first). Run it only on a network you control.

```bash
pnpm install --frozen-lockfile
pnpm test        # what the `gate` check runs on every pull request and merge-queue entry, with lint, typecheck and layout-check
```

`main` takes pull requests only, each with one approving review, through the merge queue. `pnpm exec layout-check` is the repository-layout
check from `@a11ign/toolchain`: it fails a workspace of one package, a directory not named for its package, a second README and a leftover
`lerna.json`.

### What did not come across: 27 tests

The package's test directory was written for the monorepo, and 27 of its 53 test files read something that is not in this repository:
`packages/control`'s playbooks and inventories, `packages/lab`'s capture clients, the private `guards` package, or the root's
`scripts/`. Run here, they fail on a file they cannot find, so they were **not** carried into this repository; they stay in
`a11ign/a11ign`, beside what they read, until its row #3504 relocates them. Their names are the `COUPLED` list in
`packages/lab/src/packaging/screenreader-fleet-extraction.test.ts` there. The other 26 run here and are what `gate` runs, with
`scripts/package-boundary.test.ts` holding the package to its own directory.

### Releasing

This repository releases on its own, not with `a11ign/a11ign`. A change that should reach npm carries a changeset
(`pnpm exec changeset`), and **merging it to `main` is the release**: `.github/workflows/release.yml` calls the one
reusable per-merge workflow in `a11ign/toolchain`, which versions the merge on a detached commit, publishes, tags and
releases it. There is no version pull request and nothing is written to `main`, so its `package.json` version and
`CHANGELOG.md` lag the last tag (`.changeset/README.md`). The publish uses npm trusted publishing over OIDC with
provenance and no stored token. The first release, 0.1.0, was published before this workflow existed;
no git tag names it, so the first per-merge release bases on `main`'s 0.1.0.
