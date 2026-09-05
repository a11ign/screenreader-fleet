# `@a11y-witness/worker-fleet`

Host-side lifecycle, health and capacity for a fleet of Windows NVDA capture workers. Runs on the machine that
*drives* the workers — no NVDA, no guidepup, no Windows.

```bash
npm install @a11y-witness/worker-fleet
npx a11y-doctor          # can I run right now? every check names its own fix
```

```js
import { leaseWorker } from "@a11y-witness/worker-fleet";

const lease = await leaseWorker({ after: "stop" });
try {
  // ... capture against lease.url
} finally {
  await lease.release();   // puts the VM back the way it was found
}
```

## A lease, not a lifecycle you own

`leaseWorker` decides what to capture against in priority order: an explicit worker you named, then
`inventory.yml`'s bare-metal fleet if one is declared, then a local UTM VM, then the historical
`http://localhost:8765` default. Only the VM case has a lifecycle to manage — a bare-metal box is
always on — so `release()` is a no-op for every other source. It starts what is missing and **puts a
VM back as it found it**: one that was already running is left running, a stopped one is stopped
again. A long run must not shut down something another run is using.

**Stopped worker VMs are the correct resting state.** `all stopped` is a READY state, not a fault — `a11y-doctor`
says so explicitly, because "go and start a worker" is the wrong instinct and costs time.

## Capacity is measured, never assumed

```js
import { availableHostMemoryMb, workersHostCanRun } from "@a11y-witness/worker-fleet/capacity";
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
import { assessWorker } from "@a11y-witness/worker-fleet/health";
```

The worst worker fault this fleet has had produced **zero failures**. One guest's NVDA went mute on 4 of 4
captures, the worker's own retry absorbed every one, so every capture succeeded and the eviction rule — three
consecutive *failures* — could never fire. The only symptom was 122.9 s per capture against a healthy peer's
40.6 s.

`vitals.recoveries` counts the faults a worker papered over. It is the number that rises while everything still
appears to work.

## The provisioning scripts ship with the package

```js
import { fleetScriptPaths } from "@a11y-witness/worker-fleet";
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
