// @ts-check
/**
 * What the HOST was doing while a measurement ran: CPU, disk, memory.
 *
 * ## Why this exists
 *
 * Every performance conclusion in this project has been drawn from wall-clock time and phase marks,
 * and the causes were misattributed three times in one day — first to memory, then to the guests
 * themselves, then to contention in the abstract. The actual bottleneck was **disk I/O from Chromium
 * cold-starting on three guests at once**, and it was invisible because nothing ever measured it.
 *
 * A timing number without the foundations underneath it does not identify a cause; it only says
 * something got slower. These are the four things that were being guessed at:
 *
 *   CPU     load average and the guests' own share. Ruled contention in or out.
 *   DISK    transfers/s and MB/s. The one that mattered, and the one never sampled.
 *   MEMORY  RESIDENT bytes, not `phys_footprint`.
 *   PAGING  pageouts and compressor size — the difference between "tight" and "thrashing".
 *
 * ## phys_footprint is a charge, not occupancy — this is the mistake it caused
 *
 * `MEMORY_PER_WORKER_MB` was set three times (7,600 then 8,100 then 5,600) from `top`'s memory column,
 * which on macOS is `phys_footprint`: it counts compressed and swapped-out pages as though they were
 * resident. Three guests showing 5.8 GB each — 17.4 GB "used" — held **3.8 GB of actual RAM** between
 * them, with 7.8 GB sitting in the compressor. The capacity model reserved roughly four times what a
 * worker occupies and concluded the Mac could only run two. Resident size is reported here for exactly
 * that reason.
 *
 * **FOOTPRINT IS NOT REPORTED, and this header claimed it was.** The sentence used to end "footprint is
 * reported alongside it so the gap between them stays visible", and `parseProcessMemory`'s own docstring
 * promised "Resident size AND footprint per process". Neither is true: the source is
 * `ps -o pid=,rss=,comm=`, which has no footprint column, and the returned records carry only `residentMb`.
 * A documented remedy that was never implemented, vouched for by two comments.
 *
 * That matters because RSS is the reading that lies in the one state worth detecting: a starved guest
 * showed `rss=0.4 GB` while its `phys_footprint` was 8.1 GB, its pages being in swap. So `residentMbTotal`
 * FALLS as a host gets sicker — the same self-defeating shape as reading `vm_stat` for available memory.
 *
 * Do not read it alone. `compressorMb` and the pageout DELTA come from `vm_stat` in the same snapshot and
 * are not distorted that way: low resident WITH a large compressor is a host absorbing pressure, and a
 * non-zero pageout delta is one that is swapping. `compare-workers.mjs` prints all three together and
 * labels the RSS column "<- RSS, not phys_footprint", which is why the missing field never misled anyone.
 *
 * Adding footprint means `top -l 1 -o mem -stats mem`, which costs a second and a fragile parse; the
 * pairing above answers the same question from a snapshot already being taken. Recorded rather than done,
 * so the next reader is not told a field exists that does not.
 */
import { execFileSync } from "node:child_process";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Parse `vm_stat`. Pure — the arithmetic is where this goes wrong, not the shelling out.
 *
 * The page size is read from the output rather than assumed: it is 16 KB on Apple Silicon and 4 KB on
 * Intel, and hardcoding 4096 would understate every figure on this machine by a factor of four.
 *
 * @param {string} output
 */
export function parseVmStat(output) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(pageSize)) return null;
  const pages = (/** @type {string} */ label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(output)?.[1] ?? 0);
  const mb = (/** @type {string} */ label) => Math.round((pages(label) * pageSize) / BYTES_PER_MB);
  return {
    freeMb: mb("Pages free"),
    activeMb: mb("Pages active"),
    inactiveMb: mb("Pages inactive"),
    wiredMb: mb("Pages wired down"),
    // Compressed pages live in RAM. A large compressor with low `free` is a host absorbing pressure,
    // which is a different state from one that is swapping, and they need different responses.
    compressorMb: mb("Pages occupied by compressor"),
    pageins: pages("Pageins"),
    pageouts: pages("Pageouts"),
  };
}

/**
 * Parse `iostat -d -c 2` — the disk columns for each device.
 *
 * The FIRST sample from iostat is an average since boot and is meaningless for a measurement window;
 * callers must use the second. Getting that wrong reports a busy disk as idle and vice versa.
 *
 * @param {string} output
 * @returns {Array<{device: string, kbPerTransfer: number, transfersPerSecond: number, mbPerSecond: number}>}
 */
export function parseIostat(output) {
  const lines = String(output).trim().split(/\r?\n/);
  const header = lines.findIndex((l) => /^\s*disk/.test(l));
  if (header === -1) return [];
  const devices = lines[header].trim().split(/\s+/);
  const samples = lines.slice(header + 2).filter((l) => /\d/.test(l));
  const last = samples.at(-1);
  if (!last) return [];
  const numbers = last.trim().split(/\s+/).map(Number);
  return devices.map((device, i) => ({
    device,
    kbPerTransfer: numbers[i * 3] ?? 0,
    transfersPerSecond: numbers[i * 3 + 1] ?? 0,
    mbPerSecond: numbers[i * 3 + 2] ?? 0,
  })).filter((d) => Number.isFinite(d.mbPerSecond));
}

/**
 * Load averages, or null.
 * @param {string} output
 */
export function parseLoadAverage(output) {
  const m = /([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(String(output));
  return m ? { one: Number(m[1]), five: Number(m[2]), fifteen: Number(m[3]) } : null;
}

/**
 * RESIDENT size per process. Not footprint — `ps` has no such column; see this module's header for why
 * that is a deliberate limit rather than an oversight, and what to read beside it.
 *
 * @param {string} psOutput output of `ps -o pid=,rss=,comm=`
 * @param {string} match substring of the command to keep
 */
export function parseProcessMemory(psOutput, match) {
  // `flatMap` rather than map -> filter -> map. The old shape checked `m &&` and was correct at runtime,
  // but a filter cannot narrow a type for the two lines after it, so every field access read as a
  // possible null. Doing the match and the decision in one place needs no narrowing to explain.
  return String(psOutput).trim().split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!fields || !fields[3].includes(match)) return [];
    return [{ pid: Number(fields[1]), residentMb: Math.round(Number(fields[2]) / 1024), command: fields[3] }];
  });
}

const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
  } catch {
    return ""; // a missing tool must never break a measurement; the field just reads null
  }
};

/**
 * One snapshot of the foundations.
 *
 * `iostat -c 2 -w 1` deliberately takes two samples a second apart and uses the second, because the
 * first is a since-boot average. That makes this call cost ~1 s, which is why it is a snapshot taken
 * around a measurement rather than something polled continuously.
 *
 * @param {{ processMatch?: string }} options
 */
export function sampleHost({ processMatch = "QEMU" } = {}) {
  const memory = parseVmStat(run("vm_stat", []));
  return {
    at: new Date().toISOString(),
    memory,
    disk: parseIostat(run("iostat", ["-d", "-c", "2", "-w", "1"])),
    load: parseLoadAverage(run("sysctl", ["-n", "vm.loadavg"])),
    processes: parseProcessMemory(run("ps", ["-Ao", "pid=,rss=,comm="]), processMatch),
  };
}

/**
 * What changed between two snapshots.
 *
 * Paging is reported as a DELTA because the absolute counters are since-boot and therefore enormous
 * and useless: 6.6 GB of swap left over from an incident hours ago looks identical to a host swapping
 * right now. Only the delta distinguishes them, and that distinction was worth an afternoon.
 */
// Every `?.` and `??` is a branch, so six inlined reads of a possibly-absent snapshot pushed diffHost
// to a complexity of 21 against a limit of 15 -- without being any clearer than naming the read once.
/**
 * @typedef {{ memory?: Record<string, number>, processes?: { residentMb: number }[] }} HostSnapshot
 *
 * Named because the first attempt at annotating this called it `Record<string, number>` -- flat numbers,
 * which is what the CALL SITES read out of it and not what it is. A shape guessed from its uses is the
 * same defect as a type inferred from its defaults, one file over.
 */

/**
 * @param {HostSnapshot} snapshot
 * @param {string} field
 * @param {number | null} fallback
 * @returns {number | null}
 */
const reading = (snapshot, field, fallback) => snapshot?.memory?.[field] ?? fallback;

/**
 * @param {HostSnapshot} before
 * @param {HostSnapshot} after
 */
export function diffHost(before, after) {
  // `?? 0` at the call, so these two stay plain numbers: a delta of two absent readings is 0, which is
  // what "the host did not swap" has always meant here. `compressorMb` and `freeMb` below keep null,
  // because an ABSENT reading and a reading of zero are different facts about the host and this file's
  // whole purpose is that a number carries what it was computed from.
  const pageouts = (reading(after, "pageouts", 0) ?? 0) - (reading(before, "pageouts", 0) ?? 0);
  const pageins = (reading(after, "pageins", 0) ?? 0) - (reading(before, "pageins", 0) ?? 0);
  return {
    pageoutsDelta: pageouts,
    pageinsDelta: pageins,
    // The honest headline. Non-zero pageouts during a measurement means the host was swapping and the
    // timing describes a constrained machine, not the software under test.
    swappingDuringRun: pageouts > 0,
    compressorMb: reading(after, "compressorMb", null),
    freeMb: reading(after, "freeMb", null),
    residentMbTotal: (after?.processes ?? []).reduce((sum, p) => sum + p.residentMb, 0),
  };
}
