/**
 * A DEPLOY THAT DID NOT FINISH IS A FACT ABOUT THE FLEET, AND NOTHING SAID IT.
 *
 * `fleet:status` has printed a `code` column since it existed and never compared the values. A fleet
 * part-way through a deploy shows two hashes, and that is the only symptom it has — `fleetConsistency`
 * cannot see it, because `workerCode` is deliberately OUTSIDE its `MUST_MATCH` list. That omission is
 * correct: MUST_MATCH answers "is this evidence still valid", and a code split is not an evidence
 * question. It is an operational one, and it had no home.
 *
 * Measured 2026-09-05: a deploy was killed mid-`Reboot`, leaving some boxes on the new code and one
 * unreachable. Nothing reported it. It surfaced when the next capture refused with `10 stale worker(s)`,
 * which is `assertFleetRunsThisCheckout` working exactly as designed — and one step too late to be the
 * thing that tells you.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/** The shape `fleetStatus` returns, narrowed to what the split verdict reads. */
type Rows = { code: string | null }[];
const codesOf = (rows: Rows) => [...new Set(rows.map((r) => r.code).filter(Boolean))];

test("one hash across every worker is not a split", () => {
  const codes = codesOf([{ code: "aaaa" }, { code: "aaaa" }, { code: "aaaa" }]);
  assert.equal(codes.length, 1, "a converged fleet must not be reported as split");
});

test("two hashes IS a split, and the count per hash is what makes it actionable", () => {
  const rows: Rows = [{ code: "aaaa" }, { code: "aaaa" }, { code: "bbbb" }];
  const codes = codesOf(rows);
  assert.equal(codes.length, 2);
  // A NUMBER, NOT A WORD. "the fleet is split" cannot tell you whether one box missed the deploy or nine
  // did, and those need different reactions — re-run, or look at the one box. This repo's own rule: "a
  // number beats a word", from a report that said examination was INCOMPLETE without saying by how much.
  const perHash = codes.map((c) => rows.filter((r) => r.code === c).length);
  assert.deepEqual(perHash, [2, 1]);
});

test("an UNREACHABLE worker does not invent a split", () => {
  // The killed deploy left one box unreachable, and a null code must not read as a third hash — that
  // would report a split on a fleet that is merely one box down, which is not a fault: a run evicts a
  // dead worker and carries on.
  const codes = codesOf([{ code: "aaaa" }, { code: "aaaa" }, { code: null }]);
  assert.deepEqual(codes, ["aaaa"], "a null code is an unreachable worker, not a different version");
});
