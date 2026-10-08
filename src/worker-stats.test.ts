// The guard against the mistake that produced every wrong conclusion in this project's worst session:
// calling a difference real on the strength of one measurement, or of a mean an outlier had moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareWorkers, describe as summarise, quantile, recoveryRates } from "./worker-stats.mjs";

const rounds = (n: number, value: number) => Array.from({ length: n }, () => value);

test("one bad run does not move the median, though it wrecks the mean", () => {
  // Real numbers: eight runs of a healthy worker with a single mute-recovery outlier. The mean says 18s
  // and the median says 12s; the median is what a capture actually costs.
  const values = [12, 11, 12, 13, 12, 11, 63, 12];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(mean > 17, `the mean is dragged to ${mean.toFixed(1)}`);
  assert.equal(summarise(values)!.median, 12);
});

test("two workers with overlapping spread are NOT called different", () => {
  // This is the refusal that matters. Medians differ, but the samples do not support the claim.
  const result = compareWorkers({
    w1: [11, 12, 13, 25, 12, 14, 11],
    w2: [12, 13, 14, 26, 13, 15, 12],
  });
  assert.equal(result.distinguishable, false);
  assert.match(result.verdict, /NOT DISTINGUISHABLE/);
});

test("a genuine, consistent difference IS reported", () => {
  const result = compareWorkers({ fast: rounds(6, 12), slow: rounds(6, 26) });
  assert.equal(result.distinguishable, true);
  assert.equal(result.slowest, "slow");
  assert.equal(result.fastest, "fast");
  assert.match(result.verdict, /slower than fast by 14\.0/);
});

test("too few rounds refuses to draw any conclusion, however different the numbers", () => {
  // n=1 is where every wrong answer in this session came from.
  const result = compareWorkers({ a: [12], b: [40] });
  assert.equal(result.distinguishable, false);
  assert.match(result.verdict, /too few to claim anything/);
});

test("quantiles interpolate rather than rounding to a sample", () => {
  assert.equal(quantile([10, 20], 0.5), 15);
  assert.equal(quantile([], 0.5), null);
});

test("recovery rate is separate from speed — a fast worker can be the unreliable one", () => {
  const rates = recoveryRates({
    fast: { recoveries: 4, captures: 4 },
    slow: { recoveries: 0, captures: 8 },
  });
  assert.equal(rates.fast, 1);
  assert.equal(rates.slow, 0);
});

test("a worker that captured nothing has no rate, rather than a rate of zero", () => {
  // Zero would read as "perfectly reliable", which is the opposite of "we have no idea".
  assert.equal(recoveryRates({ w: { recoveries: 0, captures: 0 } }).w, null);
});
