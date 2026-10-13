// Relocated from control/src/fleet-layer/worker-code-check.test.ts by a11ign#5350 (the fleet-owned half).
// The drift classification and its message (`codeDrift`, `describeCodeDrift`, `describeEmptyPool`) and the shared-hasher claim belong to the
// module that owns them. `worker-code-clone.test.ts` pins the end-to-end reading through `assertFleetRunsThisCheckout`, and
// `worker-code-check.test.ts` pins which hasher FILE a clone is asked; neither drives the pure refusal text, which is this file.
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
import { fileURLToPath } from "node:url";

import { codeDrift, describeCodeDrift, describeEmptyPool, resolveExpectedWorkerCode } from "./worker-code-check.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
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

test("the expected hash is the SHARED hasher, not a second implementation", async () => {
  // 16 hex characters, and it must agree with what the deploy path computes. The worker package owns
  // the "one hasher" claim; this only checks that this module did not quietly grow its own. Which hasher
  // answered (the layer clone's or the installed package's) depends on whether this tree holds a clone, so
  // the reading is asked to name it rather than be assumed.
  const expected = await resolveExpectedWorkerCode({ checkoutRoot: REPO });
  assert.match(expected.code, /^[0-9a-f]{16}$/);
  assert.ok(["clone", "installed"].includes(expected.source), `the reading must say where it came from, not "${expected.source}"`);
  // `code-drift.ts` holds the comparison the re-export in `worker-code-check.ts` points at, so it is read too: a second hasher could grow in either.
  for (const file of ["worker-code-check.ts", "code-drift.ts"]) {
    const source = readFileSync(`${REPO}src/${file}`, "utf8");
    assert.ok(!/createHash\s*\(/.test(source),
      `${file} must call codeVersion() rather than hashing itself — a second implementation `
      + "of the comparison is a second chance for the two sides to disagree.");
  }
  // The positive control: the matcher must be able to HIT, or an absence proves nothing.
  assert.ok(/createHash\s*\(/.test('const hash = createHash("sha256");'), "the matcher does not recognise a hasher when it sees one");
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
