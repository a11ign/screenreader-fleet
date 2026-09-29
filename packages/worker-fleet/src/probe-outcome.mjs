// @ts-check
/**
 * WHAT ONE `/health` PROBE CAN SAY, for the entries that reach a worker from the PUBLISHED side and by hand
 * (`witness`, `worker:compare`, `auth:leak-check`, #2683 of #2655).
 *
 * Imports `worker-http` and nothing else: no `control` (this package is published and `@a11ign/control` never
 * is, `worker-fleet-does-not-read-control.test.ts`) and no corpus reader, so a test may import it without
 * pulling the corpus closure in. These entries do NOT wake a box (ADR 0012, product-manager 2026-09-26): they
 * say it did not answer, and name the command that wakes one. `packages/control/src/fleet-wake.mjs` keeps its
 * own `probeWorker` with the same five outcomes because it is the unpublished side of that line.
 *
 * The outcomes, and the one distinction that matters (an unanswered probe is UNKNOWN, never "down"):
 *
 *   ready       the box's own report, `ready: true`
 *   busy        the box's own report, `busy: true`: a capture is running. Up, and not free
 *   not-ready   it answered and its own `ready:false` says why, or it answered a non-2xx status. UP
 *   refused     the connection was refused, so something answered the TCP handshake with a reset: the BOX IS UP
 *               and the worker is not listening. UP
 *   no-answer   nothing came back inside the timeout (`timedOut`), or the transport failed some other way
 *               (unreachable, reset). One silent probe cannot separate "off" from "slow" from "the path dropped
 *               it", so it is never called down
 *
 * `health` is the body the box sent, on the three outcomes where one arrived, because "usable" is a different
 * question in different entries (`workerIsUsable` counts a worker predating the `ready` field as usable; the
 * measurement guard wants `ready: true`) and this module does not choose for them.
 *
 * @typedef {{ outcome: "ready", health: any } | { outcome: "busy", health: any }
 *   | { outcome: "not-ready", reason: string, health: any }
 *   | { outcome: "refused", message: string }
 *   | { outcome: "no-answer", message: string, timedOut: boolean }} Probe
 */
import { requestJson } from "./worker-http.mjs";

/** @typedef {typeof requestJson} ProbeRequest */

/**
 * THE PER-PROBE TIMEOUT, WITH ITS READING. A probe that outlives it is UNKNOWN, never "down", so this number
 * decides how much slowness a healthy box is allowed.
 *
 * All of it READ by others on the real fleet (`orchestrator`, #2671) and none measured by this row, whose
 * engineer is barred from probing it:
 *   - the slowest HEALTHY box: 2.80 to 3.09 s on a11y-worker-13, -14 and -16, twelve others 0.53 to 0.76 s;
 *   - that is the FIRST answer after the box has been quiet more than 5 s, because the worker rebuilds its
 *     environment block with two synchronous `powershell.exe` calls when it is older than that, so a probe made
 *     by hand is nearly always the slow case;
 *   - a LOADED box (one that has just stopped a capture) can take up to about 10 s: each of the two calls is
 *     bounded at 5 s and they stop the worker's event loop for the whole time.
 * 12 s is that loaded ceiling plus 2 s, the number `fleet-wake.mjs` `HEALTH_TIMEOUT_MS` states for the same
 * reading. Before #2683 these entries used 5 s (`witness`, 1.91 s over the 3.09 s box and none over a loaded
 * one), 8 s (`auth:leak-check`) and 10 s (`worker:compare`'s busy guard), read at `d119fb0f2`. Cost of the
 * generosity: a box that really is off costs one 12 s wait before the message. A refusal costs nothing, it comes
 * back at once.
 */
export const WORKER_PROBE_TIMEOUT_MS = 12_000;

/**
 * @param {string} worker the worker's base URL
 * @param {{ timeoutMs?: number, request?: ProbeRequest }} [options]
 * @returns {Promise<Probe>}
 */
export async function probeHealth(worker, { timeoutMs = WORKER_PROBE_TIMEOUT_MS, request = requestJson } = {}) {
  let response;
  try {
    response = await request(`${worker.replace(/\/$/, "")}/health`, { timeoutMs });
  } catch (error) {
    const { code, message } = /** @type {NodeJS.ErrnoException} */ (error);
    // `message` is EMPTY for a raw ECONNREFUSED on this Node version, so it falls back to the code.
    if (code === "ECONNREFUSED") return { outcome: "refused", message: message || code };
    return { outcome: "no-answer", timedOut: code === "ETIMEDOUT",
      message: `${code ? `${code}: ` : ""}${message}` };
  }
  const health = response.json;
  if (!response.ok) return { outcome: "not-ready", reason: `/health answered HTTP ${response.status}`, health };
  if (health?.busy === true) return { outcome: "busy", health };
  if (health?.ready === true) return { outcome: "ready", health };
  return { outcome: "not-ready", health,
    reason: response.json?.reason ?? "/health answered without `ready: true` and without a reason" };
}

/** How to wake a box from a checkout of this repo. The published entries do not do it themselves. */
export const WAKE_HINT = "If it is a fleet box that has gone to sleep, wake it from a checkout of the a11ign repo with "
  + "`npm run fleet:wake -- <name>` (<name> is its entry in inventory.yml).";

/**
 * One sentence per outcome, in the words of what was OBSERVED. Only `refused`, `not-ready` and `busy` say the box is
 * up, because only those are things the box itself said; a silent probe says "did not answer" and never "down".
 *
 * @param {Probe} probe
 * @param {{ worker: string, timeoutMs?: number }} about
 * @returns {string}
 */
export function describeProbe(probe, { worker, timeoutMs = WORKER_PROBE_TIMEOUT_MS }) {
  switch (probe.outcome) {
    case "ready": return `${worker} answered and is ready.`;
    case "busy": return `${worker} is up and busy with a capture.`;
    case "not-ready": return `${worker} is up and answered, but it says it is not ready: ${probe.reason}.`;
    case "refused": return `${worker} refused the connection (${probe.message}): the machine is up and the worker `
      + "is not listening. Waking it will not help; start the worker on it.";
    case "no-answer": return `${worker} did not answer${probe.timedOut ? ` within ${timeoutMs / 1000} s` : ""} `
      + `(${probe.message}). That does not say it is off: it may be asleep, slow, or not reachable from here. ${WAKE_HINT}`;
    default: throw new Error(`unknown probe outcome: ${JSON.stringify(probe)}`);
  }
}
