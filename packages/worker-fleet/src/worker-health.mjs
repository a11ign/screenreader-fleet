/**
 * Is a worker healthy, degraded, or unusable — from the vitals it reports.
 *
 * This exists because a guest whose NVDA was broken on **every single capture** sat in the pool at four
 * times the cost of its neighbours and nothing noticed. Measured, same page, same code, same moment:
 *
 *   worker 1   4 captures, 4 recoveries, 0 failures   nvdaStart 19.1s/capture   WALL 122.9s
 *   worker 2   9 captures, 0 recoveries, 0 failures   nvdaStart  0.0s/capture   WALL  40.6s
 *
 * Two things conspired to hide it. The worker's own retry absorbed every fault, so `failures` stayed 0
 * and the run's eviction rule — three consecutive FAILURES — could never fire. And wall-clock time only
 * said "slower", which I twice misattributed to Edge.
 *
 * So degradation is defined on the recovery RATE, not on failures. `recoveries` counts faults the worker
 * papered over for the caller, which makes it the one number that rises while everything still appears
 * to work.
 *
 * **Degraded workers keep taking work.** They are slow, not broken, and pulling one from a three-VM pool
 * costs more throughput than it saves. This mirrors the standard health-check split — a degraded service
 * returns 200 and is *surfaced* rather than restarted, because declaring degraded things unhealthy is how
 * you end up with nothing left to serve (Distributed Systems with Node.js, ch. 4).
 */

/** Below this many captures the rate is noise: one recovery out of one capture is not a pattern. */
const MIN_CAPTURES_TO_JUDGE = 4;

/** Above this share of captures needing a recovery, the guest is not merely unlucky. */
const DEGRADED_RECOVERY_SHARE = 0.5;

/**
 * @param {{ captures?: number, recoveries?: number, failures?: number } | null | undefined} vitals
 * @returns {{ degraded: boolean, reason: string | null, recoveryShare: number | null }}
 */
export function assessWorker(vitals) {
  const captures = vitals?.captures ?? 0;
  const recoveries = vitals?.recoveries ?? 0;
  // Recoveries are counted per capture served, so the share can exceed nothing sensible above 1.
  const attempted = captures + (vitals?.failures ?? 0);
  if (attempted < MIN_CAPTURES_TO_JUDGE) {
    return { degraded: false, reason: null, recoveryShare: null };
  }
  const recoveryShare = recoveries / attempted;
  if (recoveryShare <= DEGRADED_RECOVERY_SHARE) {
    return { degraded: false, reason: null, recoveryShare };
  }
  return {
    degraded: true,
    recoveryShare,
    reason: `${recoveries} of ${attempted} captures needed a screen-reader recovery ` +
      `(${Math.round(recoveryShare * 100)}%) — this guest's NVDA is failing and every capture pays for it. ` +
      "Reinstall NVDA or re-provision it (docs/nvda-worker-runbook.md); it is still serving, just slowly.",
  };
}
