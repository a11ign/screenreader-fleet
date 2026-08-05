/**
 * How many worker VMs will actually fit on this Mac?
 *
 * The pool used to start every VM it found. On a 36 GB host that meant three guests, and measurement
 * says three do not fit: with all three up a capture took 44.5 s, and with one up it took 27.4 s of
 * the same page on the same worker — a 1.6x penalty paid by every capture in the run. The guests were
 * being swapped out from under NVDA, which also produced "NVDA is running but not speaking" failures
 * and blackouts on /health. More workers were making the run slower AND less reliable.
 *
 * So capacity is a property of the host, not a count of the VMs that happen to be registered.
 *
 * `.mjs` rather than `.ts` because `npm run doctor` runs under plain node — it is the first thing an
 * agent runs and must not depend on a transpiler — while the pool lease is TypeScript. Same reason
 * capture-decisions.mjs is .mjs.
 */
import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";

/**
 * What one worker VM costs the host.
 *
 * Measured with `top -o mem`, which agrees with phys_footprint. Host cost tracks the guest's CONFIGURED
 * RAM at ~1.8x, not its usage:
 *
 *   4096 MB configured -> 8,048-8,127 MB host
 *   3072 MB configured -> 5,494 MB host          <- what the guests now run at
 *   2560 MB configured -> 4,952 MB host          <- measured, and too small: the guest pages
 *
 * 3072 MB is the setting because it is the smallest that does not page. The guest commits ~1,859 MB, so
 * 2560 leaves too little above it: capture phases went from a 12.1 s median (IQR 0.4, 0 recoveries in
 * 10) to 36.6 s (IQR 38, 4 recoveries in 10). Less RAM stopped being cheaper the moment Windows started
 * swapping, and four cramped workers measured worse than three comfortable ones.
 *
 * The ~1.8x multiplier is QEMU's own overhead on top of guest RAM that Windows dirties and never gives
 * back (there is no balloon driver). That is why the CONFIGURED size is the lever and the guest's usage
 * is not: Windows expands to fill whatever ceiling it is given.
 *
 * This constant has been wrong twice, in the same direction. 7,600 was an underestimate from a short
 * sample; 8,100 was right for 4096 MB guests and became wrong the moment they were re-sized. Re-measure
 * it whenever guest RAM changes -- it is a property of the configuration, not of the software.
 *
 * Deliberately the high end of the range. Under-committing costs a little parallelism; over-committing
 * costs correctness, because a swapped-out guest fails captures rather than merely slowing them.
 */
const MEMORY_PER_WORKER_MB = 5_600;

/**
 * What the host's own software needs, beyond the run.
 *
 * Measured on this Mac while it was doing nothing unusual: Wispr Flow 2.3 GB, tessl 2.0 GB, stable
 * 1.3 GB, mds_stores 1.1 GB, WindowServer 1.1 GB, Codex 0.9 GB and the rest — about 11 GB before a
 * single guest starts. This module only ever runs on macOS (see availableHostMemoryMb), so it is
 * always somebody's desktop, never a dedicated hypervisor.
 */
const HOST_APPS_RESERVE_MB = 12_000;

/**
 * Memory left for the host itself.
 *
 * The Mac is somebody's desktop, not a dedicated hypervisor — Chrome, Spotify and the editor were all
 * resident during the measurements above. Taking the last of the available memory pushes the HOST into
 * swap, which slows every guest at once.
 */
const HOST_HEADROOM_MB = 3_000;

/**
 * Available memory on macOS, in MB, or null if it cannot be read.
 *
 * `os.freemem()` is useless here: it reported 402 MB on a host that comfortably had ~12 GB to give,
 * because macOS counts compressed and inactive pages as used. The pages that can actually be handed
 * out without swapping are free + inactive + speculative + purgeable, which is what `vm_stat` reports.
 *
 * Returns null rather than throwing on any surprise — a capacity check that cannot read the host must
 * not stop a run. This codebase already applies that rule to foregroundLockTimeout(): a broken
 * diagnostic taking the pool offline is worse than the fault it looks for.
 */
export function availableHostMemoryMb() {
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync("vm_stat", { encoding: "utf8", timeout: 5_000 });
    const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
    if (!Number.isFinite(pageSize)) return null;
    const pagesFor = (label) =>
      Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(output)?.[1] ?? 0);
    const pages = pagesFor("free") + pagesFor("inactive") + pagesFor("speculative") + pagesFor("purgeable");
    return Math.round((pages * pageSize) / (1024 * 1024));
  } catch {
    return null;
  }
}

/** Physical RAM in MB. Unlike `os.freemem()` this cannot lie — it is a property of the machine. */
export function totalHostMemoryMb() {
  return Math.round(totalmem() / (1024 * 1024));
}

/**
 * The most workers this machine can EVER hold, from physical RAM alone.
 *
 * This exists because the dynamic estimate below is computed from `vm_stat`, and `vm_stat` is
 * distorted by exactly the situation it needs to detect. Once guests are swapped out, their pages are
 * counted as compressed/inactive — which `availableHostMemoryMb` reports as *available* — so a host
 * three guests deep in swap advertised 13.7 GB free while two of the three could not answer an HTTP
 * health check within 75 seconds. Total RAM is immune to that feedback loop.
 *
 * @returns {number} workers, from physical memory
 */
export function workerCeilingFromTotalRam(totalMb = totalHostMemoryMb()) {
  return Math.floor((totalMb - HOST_APPS_RESERVE_MB - HOST_HEADROOM_MB) / MEMORY_PER_WORKER_MB);
}

/**
 * How many workers may be RUNNING at once, given what the host has spare.
 *
 * **A running worker is not automatically an affordable one.** This used to return
 * `alreadyRunning + canStart` on the reasoning that guests already up had "paid for" their memory and
 * `availableMb` was what remained after them. That is true of a healthy host and false of the one case
 * that matters: when the host is in swap, the running guests are being paid for out of disk, and adding
 * their count back ratifies the very over-commitment that is breaking the run. The result could never
 * be lower than the number of VMs already up, so the cap was structurally unable to hold back a pool
 * somebody had already started — which is how three guests came to share a 36 GB Mac, drive 6.6 GB of
 * swap, and black out two of the three workers mid-run.
 *
 * So the answer is the lower of the dynamic estimate and the physical-RAM ceiling, and it is allowed to
 * come out below `alreadyRunning`. The run then dispatches to fewer workers than are up, which is the
 * conservative direction: the extra guest wastes memory but no longer takes work.
 *
 * Never returns less than one: a run with no workers is a worse outcome than a slow one.
 *
 * @param {{ availableMb: number | null, alreadyRunning: number, totalMb?: number }} host
 * @returns {number}
 */
export function workersHostCanRun({ availableMb, alreadyRunning, totalMb = totalHostMemoryMb() }) {
  if (availableMb === null) return Number.POSITIVE_INFINITY; // unreadable: do not constrain the run
  const spareMb = availableMb - HOST_HEADROOM_MB;
  const dynamic = alreadyRunning + Math.max(0, Math.floor(spareMb / MEMORY_PER_WORKER_MB));
  return Math.max(1, Math.min(dynamic, workerCeilingFromTotalRam(totalMb)));
}

/**
 * Why the pool was capped, in words a human can act on. Null when nothing was held back.
 *
 * @param {{ limit: number, wanted: number, availableMb: number | null }} cap
 * @returns {string | null}
 */
export function capacityReason({ limit, wanted, availableMb }) {
  if (!Number.isFinite(limit) || limit >= wanted) return null;
  return `host has ${totalHostMemoryMb()} MB of RAM and ~${availableMb} MB available, and each worker ` +
    `costs ~${MEMORY_PER_WORKER_MB} MB, so ${limit} of ${wanted} local workers will be used. ` +
    "Measured: an over-committed host made every capture 1.6x slower, caused mute-NVDA failures, and " +
    "once starved two of three guests until they stopped answering /health at all. " +
    "Override with A11Y_MAX_WORKERS if you know better.";
}
