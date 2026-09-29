// @ts-check
/**
 * REFUSE TO MEASURE A BOX THAT IS BUSY — because the rule alone does not work.
 *
 * "Do not measure while something else is running" is written in `capture-protocol-plan.md`, by the person
 * who then broke it FOUR times in two days:
 *
 *   a page-status audit        against :5050 while `capture:check` held it with a different root -> 4 false 404s
 *   a transport probe          against a box running a gate -> 12 consecutive 429s read as timings
 *   an idle-reap measurement   that timed `keepAliveTimeout` instead of the capture case
 *   a capture-reap measurement against a busy fleet -> "responses" at 0.0-1.6 s, which are 429s
 *
 * Every one produced a NUMBER, which is what makes it dangerous: a measurement that fails loudly is
 * harmless, and one that returns a plausible wrong figure gets believed. Three of the four were caught only
 * because the number looked odd afterwards.
 *
 * So this is the repo's own housekeeping rule applied to measurement: anything a human has to remember is
 * something that does not happen. A measurement script asks the box whether it is free FIRST, and refuses
 * with the reason rather than sampling whatever a busy worker happens to say.
 */
import { describeProbe, probeHealth, WORKER_PROBE_TIMEOUT_MS } from "./probe-outcome.mjs";

/**
 * @param {string[]} workers
 * @param {{ what: string, timeoutMs?: number, request?: import("./probe-outcome.mjs").ProbeRequest }} about
 *   `what` names the measurement, so a refusal says what was NOT measured; `timeoutMs` and `request` are injectable
 * @returns {Promise<void>} resolves when every worker is free; throws naming the busy ones
 */
export async function refuseIfBusy(workers, { what, timeoutMs = WORKER_PROBE_TIMEOUT_MS, request }) {
  const states = await Promise.all(workers.map(async (worker) => {
    const probe = await probeHealth(worker, { timeoutMs, request });
    // `ready` is the right field, not `ok`: `ok` only ever meant "the HTTP server is answering", and a
    // worker answered it while NVDA could not start. `ready` is false while a capture holds the box.
    if (probe.outcome === "ready") return { worker, free: true, why: "" };
    // NOT ANSWERING IS NOT FREE, AND IT IS NOT "DOWN" EITHER. Measuring against a box that cannot answer /health
    // produces exactly the kind of plausible-looking nonsense this guard exists to prevent, so it refuses; but
    // what it says is the observed thing (#2683), one sentence per outcome from `describeProbe`.
    return { worker, free: false, why: describeProbe(probe, { worker, timeoutMs }) };
  }));
  const busy = states.filter((s) => !s.free);
  if (!busy.length) return;
  throw new Error(`REFUSING to measure ${what}: ${busy.length} of ${workers.length} worker(s) are not free `
    + `— ${busy.map((b) => b.why).join(" ")} A measurement taken against a busy box `
    + "samples its 429s, not its behaviour, and returns a number that looks real. Wait, or pass a worker "
    + "that is free.");
}

/**
 * THE VITALS PROBE'S TIMEOUT, WITH ITS READING (#2683). `worker:compare` reads `vitals` before the rounds and again
 * straight AFTER the last capture, so the second read is the LOADED case: a box that has just finished one can take
 * up to about 10 s to answer (#2671, the reading beside `WORKER_PROBE_TIMEOUT_MS`), against 3.09 s for the slowest
 * healthy first-after-idle answer. 20 s is that ceiling twice over, kept from before #2683 because it already clears
 * both. A vitals sample that times out costs the run one column, so there is no reason to give it less.
 */
export const VITALS_TIMEOUT_MS = 20_000;

/**
 * A worker's `/health` `vitals`, or `null` when there are none to be had, and SAYS WHY through `warn`: a box that did
 * not answer, one that refused, and one that answered without vitals are three different reasons for the same empty
 * column in the report, and the run used to print none of them.
 *
 * @param {string} worker
 * @param {{ timeoutMs?: number, request?: import("./probe-outcome.mjs").ProbeRequest, warn?: (line: string) => void }} [options]
 * @returns {Promise<any>}
 */
export async function sampleVitals(worker, { timeoutMs = VITALS_TIMEOUT_MS, request, warn = () => {} } = {}) {
  const probe = await probeHealth(worker, { timeoutMs, request });
  if (probe.outcome === "refused" || probe.outcome === "no-answer") {
    warn(`  no vitals sampled: ${describeProbe(probe, { worker, timeoutMs })}\n`);
    return null;
  }
  return probe.health?.vitals ?? null;
}
