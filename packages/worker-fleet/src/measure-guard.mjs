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
import { requestJson } from "./worker-http.mjs";

/**
 * @param {string[]} workers
 * @param {{ what: string }} about  names the measurement, so a refusal says what was NOT measured
 * @returns {Promise<void>} resolves when every worker is free; throws naming the busy ones
 */
export async function refuseIfBusy(workers, { what }) {
  const states = await Promise.all(workers.map(async (worker) => {
    try {
      const { json } = await requestJson(`${worker.replace(/\/$/, "")}/health`, { timeoutMs: 10_000 });
      const health = /** @type {any} */ (json);
      // `ready` is the right field, not `ok`: `ok` only ever meant "the HTTP server is answering", and a
      // worker answered it while NVDA could not start. `ready` is false while a capture holds the box.
      return { worker, free: health?.ready === true, why: health?.reason ?? (health?.busy ? "busy" : "not ready") };
    } catch (error) {
      // UNREACHABLE IS NOT FREE. Measuring against a box that cannot answer /health produces exactly the
      // kind of plausible-looking nonsense this guard exists to prevent.
      return { worker, free: false, why: `unreachable: ${error instanceof Error ? error.message : error}` };
    }
  }));
  const busy = states.filter((s) => !s.free);
  if (!busy.length) return;
  throw new Error(`REFUSING to measure ${what}: ${busy.length} of ${workers.length} worker(s) are not free `
    + `— ${busy.map((b) => `${b.worker} (${b.why})`).join(", ")}. A measurement taken against a busy box `
    + "samples its 429s, not its behaviour, and returns a number that looks real. Wait, or pass a worker "
    + "that is free.");
}
