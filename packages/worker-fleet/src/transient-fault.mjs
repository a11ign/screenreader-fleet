// @ts-check
/**
 * Is a capture-worker failure recoverable, or the end of this case?
 *
 * MOVED HERE from `packages/lab/src/training/capture-decisions.mjs` — architecture-audit.md §5, item 3:
 * "the protocol version and fault codes are reached by scraping" because no shared, dependency-free home
 * existed for classification that both the lab AND anything else speaking to a worker over HTTP need. This
 * package already exists for exactly that ("host-side lifecycle, health and capacity for a fleet of
 * Windows NVDA capture workers"), and `capture-client.mjs` — which needs this to decide whether a lost
 * response is worth reconciling rather than failing outright — moved here alongside it for the same
 * reason: `packages/cli` can depend on `@a11y-witness/worker-fleet` (it already does, for `requestJson`)
 * but must never depend on `@a11y-witness/lab`, which is private and never published.
 *
 * `capture-decisions.mjs` re-exports `isTransient` from here so every existing lab-side importer is
 * unchanged.
 */
// BY CODE, from the module that defines them — architecture-audit.md §5, item 3 and item 4: "fault codes
// are copied as string literals... because no ./capture-faults subpath is exported". `capture-faults.mjs`
// has no imports of its own, so it was always safe to expose; the subpath just did not exist. Reading the
// actual codes here means a renamed fault cannot silently stop being recognised as recoverable.
import { FAULT } from "@a11y-witness/nvda-worker/capture-faults";

/**
 * Recoverable, or the end of this case?
 *
 * Everything here heals on its own, which is why waiting beats failing. The connection errors are
 * here because the first full dataset run lost its last four cases to one guest bugchecking — it came
 * back by itself, but the run had already recorded four permanent failures.
 *
 * `running but not speaking` and `hard timeout` are the subtle ones: both make the worker STOP its
 * screen reader, so the next capture cold-starts a fresh one. They are self-healing by construction,
 * and classifying them fatal cost a case in the run that proved it.
 */
const TRANSIENT = new RegExp([
  "fetch failed", "ECONNREFUSED", "ECONNRESET", "socket hang up", "timed out", "aborted",
  "HTTP 429.*capture is already in progress",
  "running but not speaking",
  "hard timeout",
].join("|"), "i");

/**
 * Faults the WORKER named for us, which never need matching against prose.
 *
 * Both self-heal: the worker stops NVDA on any failed capture, so the next attempt cold-starts a clean
 * one. The worker now retries these itself before answering, so seeing one here means even its retry
 * did not clear it — still worth reissuing the case rather than recording a permanent failure.
 */
const TRANSIENT_FAULTS = new Set([FAULT.SCREEN_READER_MUTE, FAULT.SCREEN_READER_START_FAILED]);

/**
 * Network failures that heal on their own, by CODE rather than by wording.
 *
 * These became visible when the capture clients moved off `fetch` to `node:http` (see
 * `worker-fleet/src/worker-http.mjs` for why they had to). `fetch` collapsed every network failure into
 * `TypeError: fetch failed`, which the regex above matched — so the whole class was transient by accident,
 * through a wrapper's wording rather than through anything we had decided.
 *
 * `EHOSTUNREACH` is the one that would have bitten. It is how a bare-metal worker presents while its NIC
 * wakes from selective suspend, recorded in provision-nvda-worker.ps1: 48 instant failures in one
 * evidence-check run, and the box answered a curl thirty seconds later. Under the real code, and without
 * this set, that would now be classified FATAL and fail 48 cases permanently.
 *
 * `ETIMEDOUT` covers both a dead peer and our own deadline in `requestJson`, which is deliberate: a
 * capture that outran its budget is exactly the case the worker recovers from by cold-starting NVDA.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN",
  "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

/**
 * @param {unknown} error  anything a failed request threw — a node:http Error, an undici one, a string
 * @returns {boolean}
 */
export function isTransient(error) {
  const failure = /** @type {{ code?: string, cause?: { code?: string }, message?: string }} */ (error);
  // Prefer the code. The regex below is the fallback for older workers and for host-side failures
  // (a dropped socket has no fault code), but a message is prose and prose gets reworded — see
  // packages/nvda-worker/src/capture-faults.mjs for what that cost.
  if (TRANSIENT_FAULTS.has(failure?.code ?? "")) return true;
  if (TRANSIENT_NETWORK_CODES.has(failure?.code ?? "")) return true;
  // A node:http error carries its code on the error itself; an undici one hides it on `cause`. Checking
  // both means the classification does not depend on which client the caller happened to use.
  if (TRANSIENT_NETWORK_CODES.has(failure?.cause?.code ?? "")) return true;
  return TRANSIENT.test(String(failure?.message ?? error ?? ""));
}
