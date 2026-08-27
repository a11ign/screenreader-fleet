// @ts-check
/**
 * Robust statistics for comparing workers, and an explicit refusal to call a difference real when the
 * samples do not support it.
 *
 * This module exists because of a specific, repeated mistake: concluding from one measurement. Over one
 * session a 2x difference between two guests was attributed, in turn, to the display being blanked, to
 * in-memory accumulation, to background CPU, to Edge's launch, to the Edge profile, to the sweep, and to
 * Edge's startup boost. Every one of those was a single measurement, and every one was wrong.
 *
 * Two things caused that, and both are fixed here rather than in a comment.
 *
 * **Means lied.** One 63 s outlier in an eight-run sample moved the mean by 5 s and made a healthy
 * worker look broken. Capture time has a long right tail by nature — a mute screen reader costs ~86 s
 * against a normal ~12 s — so the mean measures how often the tail was hit, not what a capture costs.
 * The median and the interquartile range do not move when one run goes bad.
 *
 * **Sequential sampling confounded.** Measuring worker A for five minutes and then worker B for five
 * minutes attributes any drift in the host during those ten minutes to the difference between the
 * workers. Interleaving round-robin makes drift common to all of them.
 */

/**
 * One worker's samples, summarised.
 *
 * Named as a typedef rather than repeated inline because four functions pass it around, and this module's
 * whole purpose is refusing to claim a difference the samples do not support — so `q1`, `q3` and `iqr`
 * travelling together, as one thing with one name, is the point rather than a formality.
 *
 * @typedef {{n: number, median: number, q1: number, q3: number, iqr: number,
 *            min: number, max: number}} Summary
 */

/** Below this many rounds, report the numbers but never claim a difference. */
const MIN_ROUNDS_FOR_A_VERDICT = 5;

/** @param {number[]} values @returns {number[]} */
const sorted = (values) => [...values].sort((a, b) => a - b);

/** Linear-interpolated quantile. Fine for the sample sizes here and has no dependencies. */
/** @param {number[]} values @param {number} q @returns {number|null} */
export function quantile(values, q) {
  if (!values.length) return null;
  const s = sorted(values);
  const position = (s.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return low === high ? s[low] : s[low] + (s[high] - s[low]) * (position - low);
}

/**
 * The shape of one worker's samples.
 *
 * `iqr` is the spread that matters: half the runs fall inside it, so two workers whose IQRs overlap are
 * not distinguishable by these samples however different their medians look.
 */
/**
 * @param {number[]} values
 * @returns {Summary|null}
 */
export function describe(values) {
  if (!values.length) return null;
  // Non-null by construction: `quantile` returns null only for an empty list, and the guard above has
  // already excluded that. Written as a local rather than an assertion so the reason is stated once.
  const q1 = /** @type {number} */ (quantile(values, 0.25));
  const q3 = /** @type {number} */ (quantile(values, 0.75));
  return {
    n: values.length,
    median: /** @type {number} */ (quantile(values, 0.5)),
    q1, q3, iqr: q3 - q1,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Do two interquartile ranges overlap at all? @param {Summary} a @param {Summary} b */
function overlaps(a, b) {
  return a.q1 <= b.q3 && b.q1 <= a.q3;
}

/**
 * Compare workers and say, conservatively, whether a difference is supported.
 *
 * The bar is deliberately crude and deliberately strict: medians must differ by more than the wider
 * worker's IQR, and the two IQRs must not overlap. That is a weaker claim than a significance test and a
 * much stronger one than "the mean was higher", which is what produced every wrong conclusion this
 * module was written after. When the samples do not clear it, the verdict is "not distinguishable" —
 * which is a real answer, not a failure to find one.
 *
 * @param {Record<string, number[]>} samplesByWorker
 * @returns {{ stats: Record<string, Summary>, slowest: string|null, fastest: string|null,
 *             distinguishable: boolean, verdict: string }}
 */
export function compareWorkers(samplesByWorker) {
  /** @type {Record<string, Summary>} */
  const stats = {};
  for (const [worker, values] of Object.entries(samplesByWorker)) {
    const description = describe(values);
    if (description) stats[worker] = description;
  }
  const names = Object.keys(stats);
  if (names.length < 2) {
    return { stats, slowest: null, fastest: null, distinguishable: false, verdict: "need at least two workers with samples" };
  }
  const rounds = Math.min(...names.map((n) => stats[n].n));
  const byMedian = [...names].sort((a, b) => stats[a].median - stats[b].median);
  const fastest = byMedian[0], slowest = byMedian[byMedian.length - 1];
  const gap = stats[slowest].median - stats[fastest].median;
  const widest = Math.max(stats[fastest].iqr, stats[slowest].iqr);

  if (rounds < MIN_ROUNDS_FOR_A_VERDICT) {
    return {
      stats, slowest, fastest, distinguishable: false,
      verdict: `only ${rounds} round(s) — too few to claim anything. Run at least ${MIN_ROUNDS_FOR_A_VERDICT}.`,
    };
  }
  if (gap <= widest || overlaps(stats[fastest], stats[slowest])) {
    return {
      stats, slowest, fastest, distinguishable: false,
      verdict: `NOT DISTINGUISHABLE: medians differ by ${gap.toFixed(1)} but the spread is ${widest.toFixed(1)} ` +
        "and the interquartile ranges overlap. These samples do not support a difference between the workers.",
    };
  }
  return {
    stats, slowest, fastest, distinguishable: true,
    verdict: `${slowest} is slower than ${fastest} by ${gap.toFixed(1)} (medians), ` +
      `with non-overlapping interquartile ranges over ${rounds} interleaved rounds.`,
  };
}

/**
 * Recovery rate per worker — the reliability statistic, as opposed to the speed one.
 *
 * Counted from the worker's own `vitals.recoveries` across the run, because a guest whose screen reader
 * keeps dying still returns evidence and still records zero failures. Speed and reliability are separate
 * questions and a fast worker can be the unreliable one.
 *
 * @param {Record<string, {recoveries: number, captures: number}>} deltas
 * @returns {Record<string, number | null>} null where the worker captured nothing — "no idea", which
 *   must not be confused with a rate of zero ("perfectly reliable").
 */
export function recoveryRates(deltas) {
  /** @type {Record<string, number | null>} */
  const rates = {};
  for (const [worker, d] of Object.entries(deltas)) {
    rates[worker] = d.captures > 0 ? d.recoveries / d.captures : null;
  }
  return rates;
}
