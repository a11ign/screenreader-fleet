// Why is one worker slower than another? Run the same page on each and diff every phase.
//
//   npm run worker:compare -- <page-url> <worker-url> <worker-url> [...] [--rounds=6]
//
// This exists because I spent hours attributing a 2x difference between two guests to the wrong phase.
// `bench-capture.mjs` gives a phase table for ONE worker, so comparing two meant eyeballing two
// printouts, and I compared wall times instead — which said "worker 1 is faster" without saying where.
// The moment the phases were put side by side the answer was immediate: `windowsActivate` was identical
// (7.4s vs 7.3s, so Edge launch was never the difference) and the entire gap was in `sweep`.
//
// It also surfaces the per-sweep detail that capture-core already records and nothing displayed.
// `collectByType` marks every sweep with its type, elapsed ms and round-trip count in each direction,
// and the aggregate hid all of it. Six sweeps collapsed into one number cannot tell you whether a worker
// is doing MORE round trips or SLOWER ones — and those have different causes.
//
// Samples are INTERLEAVED round-robin and reported as medians with an interquartile range, never as
// means. Both choices are corrections to how this went wrong before:
//
//   - Sequential sampling (all of worker A, then all of worker B) charges any drift in the host during
//     those minutes to the difference between the workers. Round-robin makes drift common to all of them.
//   - A single mute-recovery outlier (~86s against a normal ~12s) moves a mean by 5s and makes a healthy
//     worker look broken. The median and IQR do not move.
//
// It also refuses to declare a difference the samples do not support -- see `./worker-stats.mjs`.
// "Not distinguishable" is a real answer, and it is the one that was missing.
import { writeFileSync, mkdirSync } from "node:fs";
import { compareWorkers, describe as summarise, recoveryRates } from "./worker-stats.mjs";
import { sampleHost, diffHost } from "./host-metrics.mjs";
import { resolve } from "node:path";

const CAPTURE_TIMEOUT_MS = 300_000;
const OUT = resolve(process.cwd(), "runs/worker-compare");
const MS_PER_S = 1000;

const args = process.argv.slice(2);
const runs = Number(args.find((a) => a.startsWith("--rounds="))?.slice("--rounds=".length)
  ?? args.find((a) => a.startsWith("--runs="))?.slice("--runs=".length) ?? 6);
const [page, ...workers] = args.filter((a) => !a.startsWith("--"));
if (!page || workers.length < 2) {
  process.stderr.write("usage: npm run worker:compare -- <page-url> <worker> <worker> [--rounds=6]\n");
  process.exit(2);
}

const short = (worker) => new URL(worker).hostname.split(".").pop();

async function capture(worker) {
  const response = await fetch(`${worker.replace(/\/$/, "")}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: page, probeForms: true }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 160)}`);
  return body;
}

async function diagnostics(worker) {
  try {
    const response = await fetch(`${worker.replace(/\/$/, "")}/diagnostics`, { signal: AbortSignal.timeout(180_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null; // an older worker has no /diagnostics; the phase comparison still works
  }
}

/**
 * Phase costs from one capture's diagnostics.
 *
 * Diagnostics carry a cumulative `atMs`, so a phase's own cost is the gap from the previous mark — the
 * same arithmetic bench-capture does. Repeated events (there are six `sweep` marks) accumulate, which is
 * what makes `sweep` look like one large phase.
 */
function phaseCosts(entries) {
  const costs = {};
  let previous = 0;
  for (const entry of entries ?? []) {
    if (typeof entry.atMs !== "number") continue;
    costs[entry.event] = (costs[entry.event] ?? 0) + (entry.atMs - previous);
    previous = entry.atMs;
  }
  return costs;
}

/** Per-sweep detail, keyed by sweep type, which the aggregate throws away. */
function sweepDetail(entries) {
  const byType = {};
  for (const entry of entries ?? []) {
    if (entry.event !== "sweep" || !entry.type) continue;
    const to = byType[entry.type] ??= { found: 0, ms: 0, trips: 0, n: 0 };
    to.found += entry.found ?? 0;
    to.ms += (entry.prevMs ?? 0) + (entry.nextMs ?? 0);
    to.trips += (entry.prevTrips ?? 0) + (entry.nextTrips ?? 0);
    to.n += 1;
  }
  return byType;
}

const results = Object.fromEntries(workers.map((w) => [w, { phases: [], sweeps: [], walls: [], diagnostics: null }]));
const vitalsBefore = {}, vitalsAfter = {};

async function vitals(worker) {
  try {
    const response = await fetch(`${worker.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(20_000) });
    return response.ok ? (await response.json()).vitals ?? null : null;
  } catch {
    return null;
  }
}

for (const worker of workers) vitalsBefore[worker] = await vitals(worker);

// The foundations, sampled around the run. Timings alone say something got slower; they never say
// which resource ran out. Not sampling disk I/O is why three guests contending on one SSD was
// misdiagnosed as a memory problem, then as a guest problem, before anyone looked at the disk.
const hostBefore = sampleHost();

// INTERLEAVED, round-robin. Measuring one worker for five minutes and then the next attributes any drift
// in the host during those ten minutes to the difference between the workers -- which is how a shared
// Mac running builds and browsers produces a confident wrong answer. Round-robin makes drift common.
process.stdout.write(`\nInterleaving ${runs} round(s) across ${workers.length} worker(s)\n`);
for (let round = 1; round <= runs; round++) {
  for (const worker of workers) {
    try {
      const started = Date.now();
      const result = await capture(worker);
      const wall = Date.now() - started;
      results[worker].walls.push(wall);
      results[worker].phases.push(phaseCosts(result.diagnostics));
      results[worker].sweeps.push(sweepDetail(result.diagnostics));
      process.stdout.write(`  round ${round} ${short(worker)}: ${(wall / MS_PER_S).toFixed(1)}s ` +
        `${result.transcript?.length ?? 0} phrases\n`);
    } catch (error) {
      process.stdout.write(`  round ${round} ${short(worker)}: FAILED ${error.message}\n`);
    }
  }
}
for (const worker of workers) {
  vitalsAfter[worker] = await vitals(worker);
  results[worker].diagnostics = await diagnostics(worker);
}

// --- the comparison ---------------------------------------------------------

const allPhases = [...new Set(Object.values(results).flatMap((r) => r.phases.flatMap(Object.keys)))];
const phaseSamples = (worker, phase) => results[worker].phases.map((p) => (p[phase] ?? 0) / MS_PER_S);

// Wall time first, with the verdict, because that is the question being asked.
const wallSeconds = Object.fromEntries(workers.map((w) => [short(w), results[w].walls.map((v) => v / MS_PER_S)]));
const verdict = compareWorkers(wallSeconds);

process.stdout.write(`\n\nWALL TIME (seconds), ${runs} interleaved round(s)\n`);
process.stdout.write(`  ${"worker".padEnd(10)}${"n".padStart(4)}${"median".padStart(9)}${"IQR".padStart(9)}` +
  `${"min".padStart(8)}${"max".padStart(8)}   recoveries\n`);
const deltas = Object.fromEntries(workers.map((w) => [short(w), {
  recoveries: (vitalsAfter[w]?.recoveries ?? 0) - (vitalsBefore[w]?.recoveries ?? 0),
  captures: (vitalsAfter[w]?.captures ?? 0) - (vitalsBefore[w]?.captures ?? 0),
}]));
const rates = recoveryRates(deltas);
for (const w of workers) {
  const name = short(w), d = summarise(wallSeconds[name]);
  if (!d) continue;
  const rate = rates[name] === null ? "n/a" : `${deltas[name].recoveries}/${deltas[name].captures}`;
  process.stdout.write(`  ${name.padEnd(10)}${String(d.n).padStart(4)}${d.median.toFixed(1).padStart(9)}` +
    `${d.iqr.toFixed(1).padStart(9)}${d.min.toFixed(1).padStart(8)}${d.max.toFixed(1).padStart(8)}   ${rate}\n`);
}
process.stdout.write(`\n  ${verdict.verdict}\n`);

// Per-phase medians, so a real difference can be located rather than guessed at.
process.stdout.write(`\nPHASE MEDIANS (seconds)\n`);
process.stdout.write(`  ${"phase".padEnd(20)}${workers.map((w) => short(w).padStart(9)).join("")}    spread\n`);
const rows = allPhases
  .map((phase) => {
    const medians = workers.map((w) => summarise(phaseSamples(w, phase))?.median ?? 0);
    return { phase, medians, spread: Math.max(...medians) - Math.min(...medians) };
  })
  .filter((row) => row.medians.some((v) => v >= 0.05))
  .sort((a, b) => b.spread - a.spread);
for (const { phase, medians, spread } of rows) {
  process.stdout.write(`  ${phase.padEnd(20)}${medians.map((v) => v.toFixed(1).padStart(9)).join("")}` +
    `${spread.toFixed(1).padStart(10)}${spread >= 1 ? "  <-- diverges" : ""}\n`);
}

// The per-sweep view. `found` and `trips` separate "doing more work" from "doing work more slowly",
// which is the distinction the aggregate destroys and the one that identifies a cause.
const sweepTypes = [...new Set(Object.values(results).flatMap((r) => r.sweeps.flatMap(Object.keys)))];
if (sweepTypes.length) {
  process.stdout.write("\nSWEEP DETAIL (mean ms / round trips / elements found)\n");
  for (const type of sweepTypes) {
    process.stdout.write(`  ${type.padEnd(14)}`);
    for (const w of workers) {
      const runsWith = results[w].sweeps.map((s) => s[type]).filter(Boolean);
      // Medians here too: one mute recovery inside a sweep skews a mean the same way it skews wall time.
      const ms = (summarise(runsWith.map((x) => x.ms))?.median ?? 0).toFixed(0);
      const trips = (summarise(runsWith.map((x) => x.trips))?.median ?? 0).toFixed(1);
      const found = (summarise(runsWith.map((x) => x.found))?.median ?? 0).toFixed(1);
      process.stdout.write(`${short(w)}: ${ms}ms/${trips}t/${found}f   `);
    }
    process.stdout.write("\n");
  }
  process.stdout.write("\n  ms up but trips flat => each round trip is slower (the guest or NVDA is the cause).\n");
  process.stdout.write("  trips up            => the sweep is genuinely walking more (the page or dedupe differs).\n");
}

for (const w of workers) {
  const d = results[w].diagnostics;
  if (!d) continue;
  process.stdout.write(`\n  ${short(w)} guest: profile=${d.edgeProfile?.megabytes}MB ` +
    `policy=${JSON.stringify(d.edgePolicy)} procs=${JSON.stringify(d.processes)}\n`);
}

mkdirSync(OUT, { recursive: true });
const hostAfter = sampleHost();
const foundations = diffHost(hostBefore, hostAfter);

process.stdout.write("\nFOUNDATIONS (the host, during this run)\n");
process.stdout.write(`  load             ${hostAfter.load?.one ?? "?"} (1m), ` +
  `${hostAfter.load?.five ?? "?"} (5m)\n`);
const busiest = [...(hostAfter.disk ?? [])].sort((a, b) => b.mbPerSecond - a.mbPerSecond)[0];
process.stdout.write(`  disk             ${busiest ? `${busiest.device} ${busiest.mbPerSecond} MB/s, ` +
  `${busiest.transfersPerSecond} tps` : "unavailable"}\n`);
process.stdout.write(`  guest resident   ${foundations.residentMbTotal} MB across ` +
  `${hostAfter.processes.length} process(es)   <- RSS, not phys_footprint\n`);
process.stdout.write(`  free / compressed ${foundations.freeMb} MB free, ` +
  `${foundations.compressorMb} MB compressed\n`);
process.stdout.write(`  paging           ${foundations.pageoutsDelta} pageouts during the run` +
  `${foundations.swappingDuringRun ? "  <-- THE HOST WAS SWAPPING; these timings describe a constrained machine" : " (none)"}\n`);

writeFileSync(resolve(OUT, "compare.json"),
  JSON.stringify({ page, rounds: runs, results, verdict, recoveryDeltas: deltas,
                   foundations, hostBefore, hostAfter }, null, 2) + "\n", "utf8");
process.stdout.write(`\nReport: ${resolve(OUT, "compare.json")}\n`);
