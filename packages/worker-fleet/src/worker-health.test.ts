// The signal that a guest is quietly costing 4x. It has to fire on a rate, not on failures, because the
// worker's own retry keeps failures at zero — which is exactly how a 100%-broken NVDA hid in the pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessWorker } from "./worker-health.mjs";

test("the real degraded worker is caught: every capture needed a recovery, zero failures", () => {
  // Measured: 4 captures, 4 recoveries, nvdaStart 19.1s each, and the run saw no failures at all.
  const assessment = assessWorker({ captures: 4, recoveries: 4, failures: 0 });
  assert.equal(assessment.degraded, true);
  assert.match(assessment.reason!, /4 of 4 captures needed a screen-reader recovery \(100%\)/);
  assert.match(assessment.reason!, /still serving, just slowly/);
});

test("the healthy worker beside it is not flagged", () => {
  assert.equal(assessWorker({ captures: 9, recoveries: 0, failures: 0 }).degraded, false);
});

test("one recovery in a long healthy run is not degradation", () => {
  // NVDA dies occasionally on every guest; the retry exists for that. Only a RATE is a signal.
  assert.equal(assessWorker({ captures: 30, recoveries: 1, failures: 0 }).degraded, false);
});

test("a fresh worker is never judged — too few captures to tell", () => {
  // The first capture after a boot very often needs a recovery. Judging on it would evict every guest.
  const assessment = assessWorker({ captures: 1, recoveries: 1, failures: 0 });
  assert.equal(assessment.degraded, false);
  assert.equal(assessment.recoveryShare, null, "no rate should be claimed from one capture");
});

test("failures count towards the denominator, not against the signal", () => {
  // A worker that both fails and recovers is not thereby healthier.
  assert.equal(assessWorker({ captures: 2, recoveries: 3, failures: 2 }).degraded, true);
});

test("absent vitals are not degradation — an older worker reports none", () => {
  assert.equal(assessWorker(null).degraded, false);
  assert.equal(assessWorker(undefined).degraded, false);
  assert.equal(assessWorker({}).degraded, false);
});
