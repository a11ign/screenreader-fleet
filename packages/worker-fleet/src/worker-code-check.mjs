// @ts-check
/**
 * Is the fleet running the code this checkout expects — asked BEFORE a capture run, not after it.
 *
 * ## The hole this closes
 *
 * `run-job.yml` refuses to run at a commit other than the one asked for, and the comment above that
 * refusal says why: *"a job that quietly runs four commits behind reports success for code you did not
 * ask for."* That guard covers the LAB. It says nothing about the twelve machines that actually take the
 * captures, and those are a second checkout, deployed by a separate command nobody is forced to run.
 *
 * So a capture run could be dispatched at the right commit, on a lab that proved it was at the right
 * commit, and still capture with the PREVIOUS release of `capture-core.mjs`. Measured on 2026-08-25: after
 * `MAX_TAB_STOPS` went 12 -> 150 and `collectByType` started recording `prevCount`, the real-page corpus
 * held both populations at once, and the only way to read it was to bucket captures by whether they
 * carried the new diagnostic mark at all. The evidence was mixed, the run reported success, and the
 * separation had to be done by hand afterwards.
 *
 * `npm run worker:code` has answered this question correctly the whole time. It is a separate command a
 * human must remember, which is this repo's own definition of a check that does not happen — and it was
 * remembered by hand four times in one day before this existed.
 *
 * ## Why a REFUSAL, and why on any difference at all
 *
 * `workerCode` is deliberately outside the capture cache key ("it changes when a comment changes, and
 * invalidating 1,061 pairs over a reworded comment is how a cache gets switched off") and deliberately
 * outside `fleet-consistency.mjs`'s `MUST_MATCH` for the same reason. Both of those are the right call for
 * the questions they answer — *is this evidence still valid* and *are these guests interchangeable*.
 *
 * This is a third question with a different answer: *am I about to capture with the code I asked for*. A
 * comment-only drift is a false alarm here and it costs one `fleet:deploy`; a real drift costs a corpus and
 * is invisible, because nothing downstream keys on `workerCode`. That asymmetry is the whole argument.
 *
 * It is a PRECONDITION and never a key: nothing here invalidates a cached capture.
 *
 * ## The comparison itself lives in `code-drift.mjs`, and this file is the reason for the split
 *
 * `expectedWorkerCode` below needs `codeVersion`/`workerSourceDir`, reached through a SUBPATH export
 * (`@a11y-witness/nvda-worker/code-version`) rather than a relative path — a relative one drags
 * `nvda-worker`'s `.mjs` files into this package's own tsc project and the build dies with TS5055 ("would
 * overwrite input file"). That subpath resolves through `node_modules`, which is exactly what
 * `packages/control` does not have (ADR 0012) — so when `lab-job.mjs` needed this same comparison BEFORE
 * dispatching to the lab, it could not import this file. `code-drift.mjs` is the part of this file with no
 * opinion about what "expected" means: it takes the hash as a parameter, imports nothing but
 * `node:child_process`, and is safe from both places. This file supplies the one thing only it can compute.
 */
import { codeDrift, describeCodeDrift, describeEmptyPool, readWorkerCode, remedyLines,
  workerSourceDirty, assertWorkersServe } from "./code-drift.mjs";

// A SUBPATH export, not a deep relative path: `../../nvda-worker/src/...` drags those .mjs files into
// worker-fleet's tsc project and the build dies with TS5055 "would overwrite input file". The subpath is
// also the shape already in use for the same reason -- `@a11y-witness/worker-fleet/worker-http`.
// `code-version.mjs` imports nothing but node stdlib and `worker-files.mjs`, which is why it is safe and
// why it is its own module. Still the ONE hasher: the subpath is the same function.
import { codeVersion, workerSourceDir } from "@a11y-witness/nvda-worker/code-version";

/** The hash this checkout expects every worker to be serving. One hasher, shared with the guest. */
export const expectedWorkerCode = () => codeVersion(workerSourceDir());

// Re-exported rather than duplicated: existing callers (`capture-real-pages.mjs`,
// `capture-screenreader-dataset.mjs`, and this module's own test) import these from here, and moving their
// implementation to `code-drift.mjs` must not become a second place either has to be found.
export { codeDrift, describeCodeDrift, describeEmptyPool, readWorkerCode, remedyLines, workerSourceDirty };

/**
 * Refuse to capture with a fleet that is not running this checkout.
 *
 * Called at the boundary of every capture entry point, for the reason `assertWorkerUrl` is: the
 * alternative is discovering it in the evidence weeks later, where a stale worker looks like a page that
 * changed. **Both entry points, not one** — a remedy that reaches one of several paths is the shape this
 * repo has paid for three times over (`anchorToTop`, `ensureSpeechChannel`, `waitForAnnouncement`), and
 * `capture-preflight.test.ts` pins that both call it.
 *
 * A thin wrapper over `assertWorkersServe`, supplying the one thing only this file can compute: the hash.
 *
 * @param {string[]} workers
 * @param {{when?: string, allow?: boolean, read?: (url: string) => Promise<string|null>, bareMetalUrls?: string[]}} options
 */
export async function assertFleetRunsThisCheckout(workers, options = {}) {
  return assertWorkersServe(expectedWorkerCode(), workers, options);
}
