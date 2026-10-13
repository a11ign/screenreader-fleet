// Relocated from control/src/fleet-layer/protocol-guard.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * The deploy guard that stops a CAPTURE_PROTOCOL_VERSION change invalidating the capture cache unnoticed.
 *
 * It exists because the guard that WAS written reached only `worker:deploy` — `utmctl file push` against a
 * VM UUID, which cannot reach a bare-metal worker and fails off macOS. Every box in `inventory.yml` is bare
 * metal, so the one live deploy path was the unguarded one.
 *
 * This file pins the verdict function and the cost it prints. The DISCOVERY that every deploy client
 * actually calls the guard walks the whole tree, so it stays with the deploy clients.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { protocolVerdict, RECAPTURE_COST } from "./protocol-guard.ts";

const fleet = (...protocols: (number | null)[]) =>
  protocols.map((protocol, i) => ({ worker: `w${i + 1}`, protocol }));

test("a fleet already serving this protocol deploys silently", () => {
  const v = protocolVerdict({ local: 6, served: fleet(6, 6, 6), allowed: false });
  assert.equal(v.refuse, false);
  assert.equal(v.message, "", "the common case must add no noise to a deploy log");
});

test("A CHANGE IS REFUSED, and the refusal names every box and the cost", () => {
  const v = protocolVerdict({ local: 7, served: fleet(6, 6), allowed: false });
  assert.equal(v.refuse, true);
  assert.match(v.message, /w1 serves 6/);
  assert.match(v.message, /w2 serves 6/);
  assert.match(v.message, /full recapture/, "a refusal that does not state the cost gets overridden blindly");
  assert.match(v.message, /--allow-protocol-change/, "and it must say how to proceed deliberately");
});

/**
 * #2244: THE COST THE REFUSAL PRINTS IS DERIVED, DATED, AND NAMES ITS POPULATION. It printed 2,122 and
 * "about four hours" after the corpus had passed 4,500 captures, to an operator deciding whether to spend
 * the recapture. The figure below is `manifest.json`'s cases times two captures each, read
 * 2026-09-23T14:26Z -- so the assertion is on the ARITHMETIC and the date, not on a number that would be
 * retyped the next time the corpus moves.
 */
test("THE COST A REFUSAL PRINTS IS ITS POPULATION TIMES TWO, DATED, AND CARRIES NO WALL-CLOCK", () => {
  const v = protocolVerdict({ local: 7, served: fleet(6), allowed: false });
  assert.ok(v.message.includes(RECAPTURE_COST), "the refusal must print the one derived cost, not its own copy");
  const [, total, cases] = /^([\d,]+) captures \(([\d,]+) cases in manifest\.json x 2, read 2026-09-23T14:26Z/
    .exec(RECAPTURE_COST) ?? [];
  assert.ok(total && cases, `the cost must show cases x 2 and the date it was read: ${RECAPTURE_COST}`);
  const CAPTURES_PER_CASE = 2;
  assert.equal(Number(total.replace(/,/g, "")), Number(cases.replace(/,/g, "")) * CAPTURES_PER_CASE,
    "the printed total must be the printed cases times the printed captures-per-case");
  assert.doesNotMatch(v.message, /2,?122|hours? of fleet time|four hours/,
    "the stale figure and the re-guessed wall-clock are what this row removed");
});

test("--allow-protocol-change PROCEEDS AND SAYS WHAT IT DID, rather than passing quietly", () => {
  const v = protocolVerdict({ local: 7, served: fleet(6, 6), allowed: true });
  assert.equal(v.refuse, false);
  assert.match(v.message, /Every cached capture becomes invalid/,
    "an override that prints nothing is indistinguishable from a guard that never ran");
});

test("ONE BOX BEHIND IS ENOUGH — a partial fleet is a SPLIT corpus, not a rounding error", () => {
  // A single guest on a different protocol produces cache entries under a key its peers cannot share, and
  // the corpus then holds two populations at once. That happened here with MAX_TAB_STOPS: every gate was
  // green and reading the corpus meant bucketing captures by whether they carried a diagnostic mark.
  const v = protocolVerdict({ local: 6, served: fleet(6, 6, 5), allowed: false });
  assert.equal(v.refuse, true);
  assert.match(v.message, /w3 serves 5/);
});

test("NOBODY ANSWERED IS NOT AGREEMENT — the examined-nothing rule", () => {
  // `evidence:check` exited 0 reporting "evidence unchanged — safe to ship" having compared 2 of 48,
  // because its guard covered only `compared === 0`. A guard whose subject is entirely absent must refuse.
  const v = protocolVerdict({ local: 6, served: fleet(null, null), allowed: false });
  assert.equal(v.refuse, true);
  assert.match(v.message, /no worker answered/);
  assert.match(v.message, /fleet:status/, "and it must name the command that says why");
});

test("an unreachable box does not veto a fleet that otherwise agrees", () => {
  // The opposite failure: refusing to deploy while a box is down would make deploy impossible during an
  // outage, and deploy is the remedy for most outages. Reachable workers decide; silence abstains.
  const v = protocolVerdict({ local: 6, served: fleet(6, null, 6), allowed: false });
  assert.equal(v.refuse, false);
});

test("AN UNREADABLE LOCAL VERSION IS A BROKEN GUARD, and says so instead of allowing", () => {
  // If the regex stops matching — the constant is renamed or moves — the guard silently stops
  // guarding. That is the shape `protocolBumpNote` already warns about for its own git lookup.
  const v = protocolVerdict({ local: null, served: fleet(6), allowed: false });
  assert.equal(v.refuse, true);
  assert.match(v.message, /broken guard, not a clean one/);
});

test("a string protocol from an older worker compares equal to the number", () => {
  // JSON gives what the worker sent. `6` and `"6"` are the same protocol and must not read as a change.
  assert.equal(protocolVerdict({ local: 6, served: [{ worker: "w", protocol: "6" }], allowed: false }).refuse,
    false);
});
