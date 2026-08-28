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
 * ## Two drifts that look identical and are not
 *
 * A hash mismatch means the two sides differ, not which one moved. If the local worker source is dirty
 * against HEAD then the CHECKOUT is the odd one out and deploying would ship uncommitted work; if it is
 * clean then the FLEET is behind and a deploy is exactly right. Reporting the second when it is the first
 * is how "redeploy" becomes advice that ships a `CAPTURE_PROTOCOL_VERSION` bump nobody meant to ship.
 */
import { execFileSync } from "node:child_process";

// BY PATH, never `@a11y-witness/nvda-worker`. The package index re-exports `capture-core.mjs`, which
// imports `@guidepup/guidepup`, which CONSTRUCTS A ScreenReader AT MODULE SCOPE and throws
// `No available supported screen readers` on any host without one. So importing the package name here put
// the win32-only capture driver on the import path of every capture CLIENT — and the lab is Linux, so both
// corpus runs died at import with a guidepup stack trace and no mention of this file.
//
// It passed every local check because macOS resolves VoiceOver and the throw never happens: `npm test`,
// `node -e "import(...)"` and `entry-points.test.ts` are all blind to it by platform. `worker-http.mjs`
// already states the rule — *"Deliberately NOT imported from @a11y-witness/nvda-worker: this package runs
// on macOS and Linux and must not depend on a win32-only one"* — and `no-win32-imports.test.ts` now
// enforces it instead of stating it.
//
// A SUBPATH export, not a deep relative path: `../../nvda-worker/src/...` drags those .mjs files into
// worker-fleet's tsc project and the build dies with TS5055 "would overwrite input file". The subpath is
// also the shape already in use for the same reason -- `@a11y-witness/worker-fleet/worker-http`.
// `code-version.mjs` imports nothing but node stdlib and `worker-files.mjs`, which is why it is safe and
// why it is its own module. Still the ONE hasher: the subpath is the same function.
import { codeVersion, workerSourceDir } from "@a11y-witness/nvda-worker/code-version";

/** How long a worker gets to answer `/health`. Matches `check-worker-code.mjs`: a cold Windows box needs it. */
const HEALTH_TIMEOUT_MS = 15_000;

/** The hash this checkout expects every worker to be serving. One hasher, shared with the guest. */
export const expectedWorkerCode = () => codeVersion(workerSourceDir());

/**
 * Split a set of `/health.code` readings into stale and unreachable. PURE.
 *
 * `null` is UNREACHABLE and is not a finding, matching `assertOneBrowserAcross`: a box that is asleep
 * contributes no evidence and no mismatch, and treating silence as a fault is how a check earns a
 * reputation for crying wolf. `"absent"` IS a finding — a worker predating `/health.code` is itself a
 * stale deploy.
 *
 * @param {string} expected
 * @param {Array<{worker: string, code: string|null|undefined}>} readings
 * @returns {{expected: string, stale: Array<{worker: string, serving: string}>, unreachable: string[]}}
 */
export function codeDrift(expected, readings) {
  const stale = [];
  const unreachable = [];
  for (const reading of readings ?? []) {
    const code = reading?.code;
    if (code === null || code === undefined) {
      unreachable.push(reading?.worker);
      continue;
    }
    if (code !== expected) stale.push({ worker: reading.worker, serving: String(code) });
  }
  return { expected, stale, unreachable };
}

/**
 * Name the deploy route that can actually reach these workers.
 *
 * There are two, they share no mechanism, and the wrong one wastes real time. `worker:deploy` is
 * `utmctl file push` plus a `utmctl` reboot: it takes a VM UUID and fails immediately off macOS, so it
 * cannot touch a physical box. Bare-metal workers are git-cloned and deploy by PULLING, through Ansible.
 *
 * This printed the utmctl advice unconditionally, including to a fleet of four mini PCs where none of it
 * applies — a tool confidently prescribing a remedy for a different kind of machine. Which kind a worker is
 * is not a guess: `inventory.yml` is the single source of truth for the bare-metal fleet (ADR 0012).
 *
 * PURE, and the bare-metal list is a parameter rather than a read, because a remedy that only appears when
 * something is already broken is one nobody sees until it matters. This repo has shipped an inert remedy
 * before (`refreshBrowseBuffer`, whose trigger was never set) and confirmed it by results it had no part in
 * producing. Returning lines makes both branches assertable with nothing stale and no fleet.
 *
 * @param {string[]} staleUrls
 * @param {string[]} bareMetalUrls
 * @returns {string[]}
 */
export function remedyLines(staleUrls, bareMetalUrls) {
  const bareMetal = new Set(bareMetalUrls);
  const physical = staleUrls.filter((u) => bareMetal.has(u));
  const vms = staleUrls.filter((u) => !bareMetal.has(u));
  const lines = [`\n${staleUrls.length} stale worker(s).`];

  if (physical.length) {
    lines.push(`\n  ${physical.length} in inventory.yml — bare metal, so they deploy by PULLING:`,
      "    npm run fleet:deploy",
      "  `npm run worker:deploy` cannot reach these: it is utmctl, keyed on a VM UUID.");
  }
  if (vms.length) {
    lines.push(`\n  ${vms.length} not in inventory.yml — local VM(s). A restart via \`utmctl exec\``,
      "  silently does nothing on some guests; rebooting always picks up a pushed file:",
      "    npm run worker:deploy");
  }
  return lines;
}

/**
 * The refusal text, or `null` when the fleet is running this checkout. PURE.
 *
 * Every number it reports carries what it was computed from, which is this file's parent rule: the hash,
 * which side is dirty, and how many boxes were silent rather than merely absent from the count.
 *
 * @param {{expected: string, stale: Array<{worker: string, serving: string}>, unreachable: string[]}} drift
 * @param {{when?: string, bareMetalUrls?: string[], sourceDirty?: string}} options
 * @returns {string|null}
 */
export function describeCodeDrift(drift, { when = "before the run", bareMetalUrls = [], sourceDirty = "" } = {}) {
  if (!drift?.stale?.length) return null;
  const lines = [
    `\nFLEET IS NOT RUNNING THIS CHECKOUT ${when}.`,
    `This checkout expects worker code ${drift.expected}; ${drift.stale.length} worker(s) serve something else:`,
    ...drift.stale.map(({ worker, serving }) => `  ${worker}  ${serving}`),
  ];
  if (drift.unreachable.length) {
    // Counted and named, because "3 of 4 agreed" and "3 of 4 answered" are different sentences and only
    // one of them is reassuring.
    lines.push(`  (${drift.unreachable.length} worker(s) did not answer and were not judged: `
      + `${drift.unreachable.join(", ")})`);
  }
  lines.push("", "A capture stamps the commit the LAB is at, and nothing downstream keys on the worker's code —",
    "`workerCode` is outside the cache key on purpose — so evidence taken by a stale worker is",
    "indistinguishable from current evidence for ever after.");

  if (sourceDirty) {
    // The odd one out is HERE, so the remedy is the opposite one. Getting this backwards ships
    // uncommitted work to twelve machines, and a CAPTURE_PROTOCOL_VERSION bump among it would invalidate
    // every cached capture — the trap `worker:code` already warns about, arriving through this door.
    lines.push("", "But the drift is on THIS side: the worker source in this checkout is modified against HEAD —",
      `  ${sourceDirty}`,
      "so the fleet may be perfectly current and deploying would ship uncommitted work. Commit or revert",
      "first, then re-check. Do not reach for the remedy below until this is clean.");
  }
  lines.push(...remedyLines(drift.stale.map((s) => s.worker), bareMetalUrls));
  lines.push("", "Or pass --allow-stale-workers if you know something this check does not; it will say so in",
    "the output rather than passing quietly.");
  return `${lines.join("\n")}\n`;
}

/** What a single worker is serving, or `null` when it did not answer. */
/** @param {string} url */
export async function readWorkerCode(url) {
  try {
    const response = await fetch(`${String(url).replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    // "absent" rather than null: a worker that answers without a code field predates `/health.code`,
    // which is a stale deploy and must not be filed under "did not answer".
    return (await response.json()).code ?? "absent";
  } catch {
    return null;
  }
}

/**
 * Is the worker source in this checkout modified against HEAD?
 *
 * Guarded, exactly like `protocolBumpNote`: outside a git checkout there is simply nothing to add, and a
 * precondition that throws because `git` is missing is worse than the drift it was checking for.
 */
export function workerSourceDirty() {
  try {
    return execFileSync("git", ["status", "--porcelain", "--", "packages/nvda-worker/src"],
      { encoding: "utf8" }).trim().split("\n").filter(Boolean).join("; ");
  } catch {
    return "";
  }
}

/**
 * AN EMPTY POOL IS NOT A CLEAN FLEET — the refusal, as a value, so it can be tested without exiting.
 *
 * `assertFleetRunsThisCheckout([])` used to print "Fleet runs this checkout (worker code …, 0 worker(s)
 * checked)" and return: an affirmative claim about a fleet it had not looked at. The count sitting in the
 * sentence is the only reason that was ever arguable, and "0 worker(s) checked" under a heading saying the
 * fleet is fine is precisely how "verified" comes to mean "unexamined".
 *
 * REFUSED, not reported-and-continued. The pre-push hook's loud skip is right for `runs/`, whose absence is
 * legitimate; an empty pool at a capture boundary never is. Both callers pass a pool a capture is about to
 * dispatch to, so failing here with a named cause beats failing later as "0 captured".
 *
 * Returned rather than written, and that split is this file's own convention: the classification and the
 * message are pure and driven directly by the tests, because a function that calls `process.exit` cannot be
 * asserted on without stubbing the runtime out from under it.
 *
 * @param {string[] | undefined} workers
 * @param {string} expected
 * @returns {string | null} the refusal, or null when there is a pool to check
 */
export function describeEmptyPool(workers, expected) {
  if (workers?.length) return null;
  return "REFUSING to vouch for the fleet: no workers were given, so nothing was compared against this "
    + `checkout (${expected}). A capture dispatches to workers, so an empty pool is a broken invocation `
    + "rather than a clean fleet — check A11Y_WORKER(S), the local pool, or inventory.yml.\n";
}

/**
 * Refuse to capture with a fleet that is not running this checkout.
 *
 * Called at the boundary of every capture entry point, for the reason `assertWorkerUrl` is: the
 * alternative is discovering it in the evidence weeks later, where a stale worker looks like a page that
 * changed. **Both entry points, not one** — a remedy that reaches one of several paths is the shape this
 * repo has paid for three times over (`anchorToTop`, `ensureSpeechChannel`, `waitForAnnouncement`), and
 * `capture-preflight.test.ts` pins that both call it.
 *
 * Exits 3, matching `assertOneBrowserAcross`: a precondition the operator must act on, distinct from 1
 * (captures failed) and 2 (the request was malformed).
 *
 * @param {string[]} workers
 * @param {{when?: string, allow?: boolean, read?: (url: string) => Promise<string|null>, bareMetalUrls?: string[]}} options
 */
export async function assertFleetRunsThisCheckout(workers, options = {}) {
  const { when = "before the run", allow = false, read = readWorkerCode, bareMetalUrls = [] } = options;
  if (allow) {
    process.stdout.write("--allow-stale-workers: NOT checking that the fleet runs this checkout.\n");
    return;
  }
  const expected = expectedWorkerCode();
  const empty = describeEmptyPool(workers, expected);
  if (empty) {
    process.stderr.write(empty);
    process.exit(3);
  }
  const readings = await Promise.all(workers.map(async (worker) =>
    ({ worker, code: await read(worker) })));
  const drift = codeDrift(expected, readings);
  const refusal = describeCodeDrift(drift, { when, bareMetalUrls, sourceDirty: workerSourceDirty() });
  if (!refusal) {
    // Says it CHECKED, not merely that nothing was wrong. A silent pass and a check that never ran look
    // identical from the outside, which is the `refreshBrowseBuffer` lesson applied to a precondition.
    process.stdout.write(`Fleet runs this checkout (worker code ${expected}, `
      + `${drift.unreachable.length ? `${readings.length - drift.unreachable.length} of ` : ""}`
      + `${readings.length} worker(s) checked).\n`);
    return;
  }
  process.stderr.write(refusal);
  process.exit(3);
}
