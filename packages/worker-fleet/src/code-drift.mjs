// @ts-check
/**
 * Compare a fleet's `/health.code` readings against an EXPECTED hash, and describe the result — the half
 * of `worker-code-check.mjs` that has no opinion about what "expected" means.
 *
 * Split out on 2026-09-05 so a SECOND caller could reach it. `worker-code-check.mjs`'s `expectedWorkerCode`
 * imports `codeVersion`/`workerSourceDir` through a SUBPATH export (`@a11y-witness/nvda-worker/code-version`)
 * rather than a relative path, because a relative one drags `nvda-worker`'s `.mjs` files into
 * `worker-fleet`'s own tsc project and the build dies with TS5055 ("would overwrite input file"). That
 * subpath resolves through `node_modules` — fine for `worker-fleet`, which is a normal installed package,
 * and fatal for `packages/control`, which runs from a raw git checkout with none (ADR 0012):
 * `control-has-no-dependencies.test.ts` walks every import reachable from there and refuses exactly this
 * shape. So the two constraints — no TS5055 here, no `node_modules` there — cannot both be satisfied by one
 * import line in one file, and this file exists to be the copy neither constraint touches: every function
 * below takes `expected` as a plain string, computed by whichever caller can safely reach a hasher, and
 * imports nothing but `node:child_process` and `node:child_process`'s `fetch` (a global, not an import).
 *
 * `lab-job.mjs` is that second caller — it needs this BEFORE dispatching to the lab at all, from
 * `packages/control`, which cannot import `worker-code-check.mjs` directly for the reason above.
 */
import { execFileSync } from "node:child_process";

/** How long a worker gets to answer `/health`. Matches `check-worker-code.mjs`: a cold Windows box needs it. */
const HEALTH_TIMEOUT_MS = 15_000;

/**
 * Split a set of `/health.code` readings into stale and unreachable. PURE.
 *
 * `null` is UNREACHABLE and is not a finding, matching `assertOneBrowserAcross`: a box that is asleep
 * contributes no evidence and no mismatch, and treating silence as a fault is how a check earns a
 * reputation for crying wolf. `"absent"` IS a finding — a worker predating `/health.code` is itself a
 * stale deploy.
 *
 * `answered` is returned rather than left to be inferred from the two lists, because "nothing was wrong"
 * and "nothing was examined" produce the SAME empty `stale` — and a caller with only the lists cannot
 * distinguish 3 clean workers from 3 silent ones. Every number carrying what it was computed from is this
 * file's parent rule; this is the one number that was missing.
 *
 * @param {string} expected
 * @param {Array<{worker: string, code: string|null|undefined}>} readings
 * @returns {{expected: string, stale: Array<{worker: string, serving: string}>, unreachable: string[],
 *            answered: number}}
 */
export function codeDrift(expected, readings) {
  const stale = [];
  const unreachable = [];
  let answered = 0;
  for (const reading of readings ?? []) {
    const code = reading?.code;
    if (code === null || code === undefined) {
      unreachable.push(reading?.worker);
      continue;
    }
    answered += 1;
    if (code !== expected) stale.push({ worker: reading.worker, serving: String(code) });
  }
  return { expected, stale, unreachable, answered };
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
 * @param {{expected: string, stale: Array<{worker: string, serving: string}>, unreachable: string[],
 *           answered?: number}} drift
 * @param {{when?: string, bareMetalUrls?: string[], sourceDirty?: string}} options
 * @returns {string|null}
 */
export function describeCodeDrift(drift, { when = "before the run", bareMetalUrls = [], sourceDirty = "" } = {}) {
  // A FLEET NOBODY COULD REACH IS NOT A CLEAN FLEET. `describeEmptyPool` below makes exactly this
  // argument for `workers.length === 0` -- "an affirmative claim about a fleet it had not looked at" --
  // and the identical condition arrives by a second path when the pool is full and every box is silent:
  // `stale` is empty because nothing was COMPARED, not because everything matched, so this returned null
  // and the caller printed "Fleet runs this checkout (worker code …, 0 of 5 worker(s) checked)".
  //
  // A remedy that reaches one of several paths, in the module whose own header names that shape.
  //
  // Silence is NOT a per-worker finding -- a box asleep contributes no mismatch, and treating that as a
  // fault is how a check earns a reputation for crying wolf. The judgement is about the WHOLE reading:
  // some answered, so the ones that did not are context; none answered, so there is no reading at all.
  if (drift?.answered === 0 && drift?.unreachable?.length) {
    return [
      "",
      `REFUSING to vouch for the fleet ${when}: ${drift.unreachable.length} worker(s) were asked and NONE`,
      `answered, so nothing was compared against this checkout (${drift.expected}).`,
      ...drift.unreachable.map((w) => `  ${w}`),
      "",
      "This is not a clean fleet, it is an unexamined one. A capture is about to dispatch to these boxes,",
      "so silence here is a broken invocation rather than a pass. Common causes: the fleet is powered",
      "down (npm run fleet:status), or a deploy just rebooted it and nothing waited.",
      "",
      "Or pass --allow-stale-workers if you know something this check does not.",
      "",
    ].join("\n");
  }
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
 * Refuse to run against a fleet that is not serving `expected` — the shared body of
 * `assertFleetRunsThisCheckout`, taking the hash as a parameter rather than computing it.
 *
 * That split is the whole reason this function exists rather than living only in `worker-code-check.mjs`:
 * computing `expected` needs `codeVersion`/`workerSourceDir`, and reaching those from `packages/control`
 * cannot go through a relative path (TS5055 in `worker-fleet`'s own build) or a package-name import (no
 * `node_modules` on the control plane, ADR 0012) at once — see this file's header. So the CALLER computes
 * `expected` however it can safely reach a hasher, and this function starts from the answer.
 *
 * Exits 3, matching `assertOneBrowserAcross`: a precondition the operator must act on, distinct from 1
 * (captures failed) and 2 (the request was malformed).
 *
 * @param {string} expected
 * @param {string[]} workers
 * @param {{when?: string, allow?: boolean, read?: (url: string) => Promise<string|null>, bareMetalUrls?: string[]}} options
 */
export async function assertWorkersServe(expected, workers, options = {}) {
  const { when = "before the run", allow = false, read = readWorkerCode, bareMetalUrls = [] } = options;
  if (allow) {
    process.stdout.write("--allow-stale-workers: NOT checking that the fleet runs this checkout.\n");
    return;
  }
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
