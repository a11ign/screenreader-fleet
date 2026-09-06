/**
 * Does a capture run refuse a fleet that is not running this checkout?
 *
 * The fault being reproduced is measured, not hypothetical. On 2026-08-25 `MAX_TAB_STOPS` went 12 -> 150
 * and `collectByType` began recording `prevCount`; the real-page corpus then held captures from both
 * versions at once, and reading it required bucketing by whether a capture carried the new diagnostic mark.
 * Every gate was green. The run reported success. `npm run worker:code` would have said so and was not run,
 * because it is a separate command a human has to remember — this repo's own definition of a check that
 * does not happen.
 *
 * Note what these tests deliberately do NOT do: call `assertFleetRunsThisCheckout` and let it
 * `process.exit(3)`. The classification and the message are pure and are driven directly; the exit is four
 * lines around them. Anything that needs a fleet is asserted structurally at the bottom.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { codeDrift, describeCodeDrift, describeEmptyPool, expectedWorkerCode } from "./worker-code-check.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const FLEET = ["http://203.0.113.107:8765", "http://203.0.113.59:8765", "http://203.0.113.175:8765"];
const CURRENT = "d1c98aa032198754";
const BEHIND = "22822b7a3a08969c";

const reading = (worker: string, code: string | null) => ({ worker, code });

test("a fleet uniformly one deploy behind is REFUSED, and the hashes are named", () => {
  // The measured shape. Uniform drift is the dangerous one: `fleetConsistency` reports the guests as
  // perfectly interchangeable, because they are — with each other, and not with the commit being stamped.
  const drift = codeDrift(CURRENT, FLEET.map((w) => reading(w, BEHIND)));
  assert.equal(drift.stale.length, 3);

  const refusal = describeCodeDrift(drift, { bareMetalUrls: FLEET });
  assert.ok(refusal, "a fleet three deploys behind must not pass");
  assert.match(refusal!, new RegExp(CURRENT), "the refusal must name what this checkout expects");
  assert.match(refusal!, new RegExp(BEHIND), "and what the fleet is actually serving");
  // A NUMBER, not a word: "the fleet is stale" cannot tell you whether one box is behind or all of them.
  assert.match(refusal!, /3 worker\(s\) serve something else/);
});

test("a fleet that matches this checkout passes, and passing is not an empty result", () => {
  const drift = codeDrift(CURRENT, FLEET.map((w) => reading(w, CURRENT)));
  assert.deepEqual(drift.stale, []);
  assert.equal(describeCodeDrift(drift, { bareMetalUrls: FLEET }), null);
});

test("a worker that did not answer is not a finding, but IS counted in the refusal", () => {
  // Silence is not staleness — `assertOneBrowserAcross` settled that and the reasoning transfers: a box
  // that is asleep contributes no evidence and no mismatch. But when something ELSE is stale, how many
  // machines went unjudged is part of reading the number.
  const quiet = codeDrift(CURRENT, [reading(FLEET[0], null), reading(FLEET[1], CURRENT)]);
  assert.deepEqual(quiet.stale, []);
  assert.deepEqual(quiet.unreachable, [FLEET[0]]);
  assert.equal(describeCodeDrift(quiet, { bareMetalUrls: FLEET }), null);

  const mixed = codeDrift(CURRENT, [reading(FLEET[0], null), reading(FLEET[1], BEHIND)]);
  const refusal = describeCodeDrift(mixed, { bareMetalUrls: FLEET })!;
  assert.match(refusal, /1 worker\(s\) did not answer and were not judged/);
  assert.match(refusal, new RegExp(FLEET[0].replace(/[.]/g, "\\.")));
});

test("a worker predating /health.code reports `absent`, which is a stale deploy and not silence", () => {
  const drift = codeDrift(CURRENT, [reading(FLEET[0], "absent")]);
  assert.deepEqual(drift.unreachable, []);
  assert.equal(drift.stale.length, 1);
  assert.equal(drift.stale[0].serving, "absent");
});

test("when THIS checkout is the dirty one, the advice inverts and says not to deploy", () => {
  // Getting this backwards ships uncommitted work to twelve machines. Worse, an uncommitted
  // CAPTURE_PROTOCOL_VERSION bump among it invalidates every cached capture — the exact trap
  // `worker:code`'s protocol note already warns about, arriving through a different door.
  const drift = codeDrift(CURRENT, [reading(FLEET[0], BEHIND)]);
  const clean = describeCodeDrift(drift, { bareMetalUrls: FLEET })!;
  assert.doesNotMatch(clean, /modified against HEAD/);
  assert.match(clean, /npm run fleet:deploy/);

  const dirty = describeCodeDrift(drift,
    { bareMetalUrls: FLEET, sourceDirty: " M packages/nvda-worker/src/capture-core.mjs" })!;
  assert.match(dirty, /the drift is on THIS side/);
  assert.match(dirty, /capture-core\.mjs/);
  assert.match(dirty, /Do not reach for the remedy below until this is clean/);
});

test("the refusal names the escape hatch, so it is a decision rather than a wall", () => {
  const refusal = describeCodeDrift(codeDrift(CURRENT, [reading(FLEET[0], BEHIND)]), {})!;
  assert.match(refusal, /--allow-stale-workers/);
});

test("`when` is carried into the message, so a start-of-run and end-of-run refusal read differently", () => {
  const drift = codeDrift(CURRENT, [reading(FLEET[0], BEHIND)]);
  assert.match(describeCodeDrift(drift, { when: "by the END of the run" })!, /by the END of the run/);
});

test("the expected hash is the SHARED hasher, not a second implementation", () => {
  // 16 hex characters, and it must agree with what the deploy path computes. `code-version.test.ts` owns
  // the "one hasher" claim; this only checks that this module did not quietly grow its own.
  assert.match(expectedWorkerCode(), /^[0-9a-f]{16}$/);
  const source = readFileSync(`${REPO}packages/worker-fleet/src/worker-code-check.mjs`, "utf8");
  assert.ok(!/createHash\s*\(/.test(source),
    "worker-code-check.mjs must call codeVersion() rather than hashing itself — a second implementation "
    + "of the comparison is a second chance for the two sides to disagree.");
});

/**
 * Every module that drives a capture is classified, and the union must cover what is DISCOVERED.
 *
 * A plain list rots: `worker-files.mjs`, the budget ladder and the signal-type scrape all read a hardcoded
 * set and all eventually missed the case that mattered. A plain discovery test over-fires here, because
 * "posts to /capture" admits diagnostics as well as corpus writers and the right behaviour differs — a
 * diagnostic must NEVER be the thing that takes the pool offline (`fleet-consistency.mjs` says so
 * explicitly, and it is why that check reports rather than refuses).
 *
 * So: two lists whose union must equal what is found. A seventh capture client fails this test until
 * somebody decides which kind it is, which is the decision that was missed when this preflight did not
 * exist.
 */
const CORPUS_WRITERS = [
  "packages/lab/src/training/capture-real-pages.mjs",
  "packages/lab/src/training/capture-screenreader-dataset.mjs",
];

const DIAGNOSTICS = [
  "packages/lab/src/training/repeat-capture.mjs",
  "packages/lab/src/harnesses/capture-fixtures.mjs",
  "packages/lab/src/harnesses/page-identity-rate.mjs",
  "packages/lab/src/harnesses/occurrence-verdict-stability.mjs",
  "packages/lab/src/harnesses/capture-check.mjs",
];

/** Every lab module that POSTs a capture to a worker. */
function captureClients(): string[] {
  const found: string[] = [];
  for (const dir of ["packages/lab/src/training", "packages/lab/src/harnesses"]) {
    for (const entry of readdirSync(`${REPO}${dir}`)) {
      if (!entry.endsWith(".mjs")) continue;
      const path = `${dir}/${entry}`;
      const source = readFileSync(`${REPO}${path}`, "utf8");
      // DISPATCHING WORK is the signature, and it now has two spellings: a literal POST, or a call to the
      // shared `captureTolerantly`. Matching only the first found four clients after nine moved behind the
      // shared one -- a discovery walk quietly describing less than half the codebase, which is the exact
      // rot this test's own count assertion exists to catch.
      //
      // Still NOT matched: reading `/capture/<id>` to recover a lost response. That is asking for work
      // already done, not dispatching it, and a module that merely mentions the route is not a client.
      const dispatches = /["'`][^"'`]*\/capture["'`][^]{0,120}?method:\s*["']POST["']/.test(source)
        || /\bcaptureTolerantly\(/.test(source);
      if (dispatches) found.push(path);
    }
  }
  return found.sort();
}

test("every capture client is classified as a corpus writer or a diagnostic", () => {
  const classified = new Set([...CORPUS_WRITERS, ...DIAGNOSTICS]);
  const unclassified = captureClients().filter((path) => !classified.has(path));
  assert.deepEqual(unclassified, [],
    "A new module drives captures and nobody has said whether it writes evidence. If it does, it must "
    + "call assertFleetRunsThisCheckout — a capture taken by a stale worker is indistinguishable from a "
    + "current one for ever after. If it is a diagnostic, add it to DIAGNOSTICS: a diagnostic must never "
    + "be the thing that takes the pool offline.");
});

test("EVERY corpus writer runs the preflight — not one of them", () => {
  // The shape this repo has paid for three times: `anchorToTop` had the focus-mode remedy and the other
  // sweeps did not; `startScreenReader` adopted a live NVDA and `ensureSpeechChannel` did not;
  // `waitForAnnouncement` settled speech at the end of a delta and not at the start. Each remedy was
  // correct, commented, and reachable from only one of the paths that needed it.
  for (const path of CORPUS_WRITERS) {
    const source = readFileSync(`${REPO}${path}`, "utf8");
    assert.match(source, /assertFleetRunsThisCheckout\(/,
      `${path} writes captures into a corpus and does not check the fleet runs this checkout.`);
    assert.match(source, /--allow-stale-workers/,
      `${path} must offer the escape hatch, and by the same name as its sibling.`);
  }
});

test("the corpus writers are real files, so the list cannot rot into a no-op", () => {
  // A guard written against a shape you did not verify is the count-based check all over again: the first
  // version of `verify.corpus.test.ts` read a field that does not exist and passed against a corpus
  // carrying 604 crashes.
  for (const path of [...CORPUS_WRITERS, ...DIAGNOSTICS]) {
    assert.ok(readFileSync(`${REPO}${path}`, "utf8").length > 0, `${path} does not exist`);
  }
  assert.ok(captureClients().length >= CORPUS_WRITERS.length, "discovery found fewer clients than are listed");
});

test("an EMPTY pool is refused, not vouched for", () => {
  // `assertFleetRunsThisCheckout([])` printed "Fleet runs this checkout (worker code …, 0 worker(s)
  // checked)" and returned — an affirmative claim about a fleet it had not looked at. The count being in
  // the sentence is the only reason that was ever arguable, and "0 worker(s) checked" under a heading
  // saying the fleet is fine is how "verified" comes to mean "unexamined".
  //
  // Refused rather than reported-and-continued, unlike the pre-push hook's loud skip: `runs/` being absent
  // is legitimate, an empty pool at a capture boundary never is.
  const refusal = describeEmptyPool([], CURRENT)!;
  assert.match(refusal, /REFUSING to vouch/);
  assert.match(refusal, /broken invocation/);
  assert.ok(refusal.includes(CURRENT), "name the checkout nothing was compared against");
});

test("a pool with workers in it is NOT refused, so the guard cannot block a real run", () => {
  // The control. A refusal that fires on the healthy case is worse than none — it gets bypassed, and
  // `A11Y_SKIP_VERIFY=1` was reached for six times in one evening after exactly that.
  assert.equal(describeEmptyPool(FLEET, CURRENT), null);
  assert.equal(describeEmptyPool([FLEET[0]], CURRENT), null);
});

test("a fleet where NOTHING answered is refused, not vouched for", () => {
  // `describeEmptyPool` makes this argument for an empty pool -- "an affirmative claim about a fleet it
  // had not looked at" -- and the identical condition arrives by a second path when the pool is full and
  // every box is silent: `stale` is empty because nothing was COMPARED, not because everything matched.
  //
  // Measured before the fix: five workers, all silent, `describeCodeDrift` -> null, and the caller
  // printed "Fleet runs this checkout (worker code abc123, 0 of 5 worker(s) checked)".
  const drift = codeDrift("abc123", FLEET.map((worker) => ({ worker, code: null })));
  assert.equal(drift.answered, 0);
  const refusal = describeCodeDrift(drift, {});
  assert.ok(refusal, "a fleet nobody could reach must not read as clean");
  assert.match(refusal ?? "", /NONE\s*\n?answered/, "it must say nothing answered");
  assert.match(refusal ?? "", /unexamined one/);
  for (const worker of FLEET) assert.ok(refusal?.includes(worker), `must name ${worker}`);
});

test("SOME silent workers are context, never a refusal on their own", () => {
  // Silence is not a per-worker finding: a box asleep contributes no mismatch, and treating that as a
  // fault is how a check earns a reputation for crying wolf. The judgement is about the WHOLE reading.
  const drift = codeDrift("abc123", [
    { worker: FLEET[0], code: null },
    { worker: FLEET[1], code: "abc123" },
  ]);
  assert.equal(drift.answered, 1);
  assert.equal(describeCodeDrift(drift, {}), null);
});

test("answered counts boxes that were read, not boxes that agreed", () => {
  // The number exists to separate "nothing was wrong" from "nothing was examined", so a STALE worker
  // must still count as answered -- it was reached and compared.
  const drift = codeDrift("abc123", [{ worker: FLEET[0], code: "old999" }]);
  assert.equal(drift.answered, 1);
  assert.equal(drift.stale.length, 1);
});

