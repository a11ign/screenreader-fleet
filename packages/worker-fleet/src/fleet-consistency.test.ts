// The pool assumes guests are interchangeable: cases are dispatched to whichever is free, the cache
// lets any guest reuse another's evidence, and a good/bad pair is only comparable because both halves
// came from equivalent machines. Two real divergences happened in one day and BOTH were caught by a
// human reading a console by eye. These tests are the replacement for that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fleetConsistency, describeMismatches, MUST_MATCH, POLICY_MUST_MATCH } from "./fleet-consistency.mjs";

/**
 * THE FIXTURE ADDRESSES, BUILT FROM OCTETS. #63's history purge replaced every RFC 1918 literal in the
 * tree with one constant string, so the distinct guest addresses here collapsed into the same value and
 * tests about telling two workers apart started comparing a thing to itself. Built, they survive any
 * `--replace-text` pass -- and `tracked-source-leak-guard` refuses a written-out one in tracked source
 * anyway, so this is the shape that satisfies both.
 */
const privateAddress = (...octets: number[]) => octets.join(".");
const IP = {
  g1: privateAddress(192, 168, 64, 1),
  g4: privateAddress(192, 168, 64, 4),
  g5: privateAddress(192, 168, 64, 5),
  g6: privateAddress(192, 168, 64, 6),
  h84: privateAddress(192, 168, 1, 84),
  lease: privateAddress(10, 1, 2, 3),
};


const guest = (worker: string, over = {}) => ({
  worker,
  environment: {
    browserVersion: "151.0.4129.59", screenReaderVersion: "2026.1.1",
    windowsVersion: "Microsoft Windows 11 Pro 10.0.22621", architecture: "arm64", captureProtocol: 2,
    guidepupVersion: "0.31.0",
    ...over,
  },
  policy: { StartupBoostEnabled: 0, BackgroundModeEnabled: 0 },
});

test("a matched fleet is consistent", () => {
  const r = fleetConsistency([guest(`http://${IP.g4}:8765`), guest(`http://${IP.g5}:8765`)]);
  assert.equal(r.consistent, true);
  assert.deepEqual(r.mismatches, []);
});

test("the real Edge version split is caught", () => {
  // Measured: Edge auto-updated to 151 on one guest while others stayed on 150, despite the updater
  // being policy-disabled. Noticed by reading a boot log by eye.
  const r = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { browserVersion: "151.0.4129.59" }),
    guest(`http://${IP.g5}:8765`, { browserVersion: "150.0.4078.105" }),
  ]);
  assert.equal(r.consistent, false);
  assert.equal(r.mismatches[0].field, "browserVersion");
  assert.match(describeMismatches(r.mismatches)[0], /\.4=151\.0\.4129\.59 \.5=150\.0\.4078\.105/);
});

test("the real StartupBoost policy split is caught", () => {
  // Measured: 1 on two guests, 0 on a third. Nothing keys on it, so only a check like this can see it.
  const a = guest(`http://${IP.g4}:8765`);
  const r = fleetConsistency([
    { ...a, policy: { StartupBoostEnabled: 1, BackgroundModeEnabled: 0 } },
    guest(`http://${IP.g6}:8765`),
  ]);
  assert.equal(r.consistent, false);
  assert.ok(r.mismatches.some((m) => m.field === "edgePolicy.StartupBoostEnabled"));
});

test("a guest on an older capture protocol is caught", () => {
  // The worst case: its evidence means something different, and the cache would happily mix them.
  const r = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { captureProtocol: 2 }),
    guest(`http://${IP.g5}:8765`, { captureProtocol: 1 }),
  ]);
  assert.ok(r.mismatches.some((m) => m.field === "captureProtocol"));
});

test("a mixed-architecture fleet is caught", () => {
  const r = fleetConsistency([
    guest("http://a:8765", { architecture: "arm64" }),
    guest("http://b:8765", { architecture: "x64" }),
  ]);
  assert.ok(r.mismatches.some((m) => m.field === "architecture"));
});

test("an absent field is not a mismatch", () => {
  // An older worker that does not report a field must not be flagged against newer ones. Only
  // DIFFERING known values are evidence of drift; missing data is missing data.
  const partial = { worker: "http://old:8765", environment: { browserVersion: "151.0.4129.59" }, policy: {} };
  assert.equal(fleetConsistency([guest("http://new:8765"), partial]).consistent, true);
});

test("one guest, or none, is not a finding", () => {
  // A fleet of one is trivially consistent with itself, and zero guests is not a fleet.
  assert.equal(fleetConsistency([guest("http://a:8765")]).consistent, true);
  assert.equal(fleetConsistency([]).consistent, true);
  assert.equal(fleetConsistency(undefined as never).consistent, true);
});

test("every mismatch explains why it matters", () => {
  // A report that says "these differ" without saying what breaks is one an operator will learn to skip.
  const r = fleetConsistency([
    guest("http://a:8765", { browserVersion: "151.0.4129.59" }),
    guest("http://b:8765", { browserVersion: "150.0.4078.105" }),
  ]);
  for (const line of describeMismatches(r.mismatches)) {
    assert.match(line, / — .{10,}/, `no explanation in: ${line}`);
  }
});

test("a guidepup version split is caught", () => {
  // The driver parses NVDA's speech before this project sees it. 0.29.2 emitted an intermittent
  // U+FFFC where 0.31.0 emits a consistent empty segment — same NVDA, same page, different evidence.
  // During the upgrade the fleet was deliberately split for a while; nothing would have noticed.
  const r = fleetConsistency([
    guest("http://a:8765", { guidepupVersion: "0.31.0" }),
    guest("http://b:8765", { guidepupVersion: "0.29.2" }),
  ]);
  assert.equal(r.consistent, false);
  assert.ok(r.mismatches.some((m) => m.field === "guidepupVersion"));
});

test("a fleet split by provisioning is reported", () => {
  // `provisionRevision` was a cache key WITHOUT being a consistency field. A guest re-provisioned on
  // its own reports a real revision while the rest still report "unstamped", which produces two
  // evidence populations -- and the only symptom was the cache quietly ceasing to hit, which looks
  // like ordinary churn. Guests must be re-provisioned together, and now something says so.
  const { consistent, mismatches } = fleetConsistency([
    { worker: `http://${IP.g4}:8765`, environment: { provisionRevision: "unstamped" } },
    { worker: `http://${IP.g5}:8765`, environment: { provisionRevision: "a1b2c3d-0f1e2d3c4b5a6978" } },
  ]);
  assert.equal(consistent, false);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].field, "provisionRevision");
});

test("a uniformly unstamped fleet is consistent", () => {
  // Uniform is the current real state of this pool: imprecise, but not a split, and reporting it as a
  // mismatch would cry wolf on every run until a recapture happens to be worth doing.
  const { consistent } = fleetConsistency([
    { worker: "a", environment: { provisionRevision: "unstamped" } },
    { worker: "b", environment: { provisionRevision: "unstamped" } },
  ]);
  assert.equal(consistent, true);
});

test("EVERY MUST_MATCH FIELD IS ONE THE WORKER ACTUALLY REPORTS", () => {
  // The hole #1953 fell through, generalised so the next field cannot fall through it too.
  //
  // `check()` skips a field no guest reports ("absent is not a mismatch", and that rule is right -- an
  // older worker must not be flagged against newer ones). The cost is that a `MUST_MATCH` entry naming
  // something the worker never sends is INVISIBLE: it compares nothing, reports nothing, and the fleet
  // reads CONSISTENT. `displayMode` is that failure from the other end -- a property that mattered, that
  // nothing sent, so nothing could compare -- and a typo'd path here would produce it silently.
  //
  // Asserted against server.mjs's SOURCE, the same narrow exception `provision-stamp.test.ts` states:
  // `server.mjs` imports guidepup, which constructs a ScreenReader at module scope and throws on a host
  // with no screen reader, so this file cannot import it on any runner this repo has.
  const server = readFileSync(new URL("../../nvda-worker/src/server.mjs", import.meta.url), "utf8");
  const start = server.indexOf("function runtimeEnvironment() {");
  const end = server.indexOf("function provisionRevision() {");
  assert.ok(start !== -1 && end > start, "server.mjs no longer has a runtimeEnvironment block to read");
  const reported = server.slice(start, end);

  const missing = MUST_MATCH.map((f) => f.path).filter((path) => !reported.includes(`${path}:`));
  assert.deepEqual(missing, [], "MUST_MATCH compares fields the worker's /health environment never sends");

  // The positive control for the line above: `deepEqual(missing, [])` passes when the matcher matches
  // everything, and a matcher that cannot fail is the defect this whole file is about.
  assert.ok(!reported.includes("displayModeThatIsNotReported:"),
    "the source matcher matches names that are not there, so the assertion above proves nothing");
});

test("THE REAL DISPLAY SPLIT IS CAUGHT -- 1024x768 against 640x480", () => {
  // THE POSITIVE CONTROL for the field below, and the pair is the one this fleet was actually running:
  // workers 2-6 at 1024x768 on the Intel adapter, workers 7-11 at 640x480 on the Basic Display Adapter
  // with the Intel one at error 43 (#1953, measured 2026-09-22; the 640x480 read is from worker-7's own
  // interactive session, #1955). `fleet:status` called that fleet CONSISTENT and interchangeable.
  //
  // Without this assertion the field passes by being empty: `assert.deepEqual(mismatches, [])` in "a
  // matched fleet is consistent" is true of a `MUST_MATCH` entry that no guest ever reports.
  const { consistent, mismatches } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { displayMode: "1024x768" }),
    guest(`http://${IP.g5}:8765`, { displayMode: "640x480" }),
  ]);
  assert.equal(consistent, false);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].field, "displayMode");
  assert.match(describeMismatches(mismatches)[0], /\.4=1024x768 \.5=640x480/);
});

test("a fleet on one display mode is consistent", () => {
  // The other direction, and it is not the same assertion twice: a field that reported a mismatch
  // between two guests holding the SAME mode would take `fleet:status` offline over nothing, which is
  // how a diagnostic gets switched off. 1024x768 is what the pool is pinned to (#1561, ceo's ruling b).
  const { consistent, mismatches } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { displayMode: "1024x768" }),
    guest(`http://${IP.g5}:8765`, { displayMode: "1024x768" }),
  ]);
  assert.equal(consistent, true);
  assert.deepEqual(mismatches, []);
});

test("a guest whose display could not be read is reported, not skipped", () => {
  // `displayMode` answers the string "unknown" rather than nothing when the read fails, and the worker
  // does that deliberately: `check()` skips an absent field, so an unreadable display would land back in
  // exactly the state #1953 is about -- a property nobody compares, printed as agreement. A guest whose
  // screen cannot be read is not KNOWN to be interchangeable, and the report must say so.
  const { consistent, mismatches } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { displayMode: "1024x768" }),
    guest(`http://${IP.g5}:8765`, { displayMode: "unknown" }),
  ]);
  assert.equal(consistent, false);
  assert.ok(mismatches.some((m) => m.field === "displayMode"));
});

test("a shortened worker label must still distinguish the workers", () => {
  // `.4` is the right label in a table until two workers share a last octet — two boxes on one host, or
  // two subnets that meet. The line then reports drift without locating it, which is the whole point of
  // naming the guests: `browserVersion: .1=151.0.1 .1=150.0.9` says something is wrong and not where.
  const collide = describeMismatches([{
    field: "browserVersion",
    why: "Edge announces differently across releases",
    values: { "http://127.0.0.1:9201": "151.0.1", "http://127.0.0.1:9202": "150.0.9" },
  }])[0];
  assert.match(collide, /127\.0\.0\.1:9201=151\.0\.1/);
  assert.match(collide, /127\.0\.0\.1:9202=150\.0\.9/);

  // And the short form survives where it is unambiguous — this is a readability optimisation that must
  // not cost the thing the line exists to convey, not a reason to print full URLs always.
  const distinct = describeMismatches([{
    field: "browserVersion",
    why: "Edge announces differently across releases",
    values: { "http://203.0.113.83:8765": "151.0.1", [`http://${IP.h84}:8765`]: "150.0.9" },
  }])[0];
  assert.match(distinct, /\.83=151\.0\.1 \.84=150\.0\.9/);
});

// --- #1997: WHICH FIELDS WERE COMPARED, and the pair that must not look alike ---

/** Every `MUST_MATCH` field reported, DERIVED, so a field added to the list cannot leave this stale. */
const fullyReporting = (worker: string, over: Record<string, unknown> = {}) => ({
  worker,
  environment: { ...Object.fromEntries(MUST_MATCH.map(({ path }) => [path, `same-${path}`])), ...over },
  policy: { StartupBoostEnabled: 0, BackgroundModeEnabled: 0 },
});

test("#1997: A FIELD COMPARED ON NOBODY IS NAMED, and does not look like a field everybody agrees on", () => {
  // THE PAIR IS THE TEST. Measured 2026-09-22T20:09Z on the live fleet at the merge of #1953: nine
  // fields at 10/10 guests, `displayMode` at 0/10, and `fleet:status` printed `fleet CONSISTENT across
  // 10 of 10 -- these workers are interchangeable for capture`. Both halves below are `consistent: true`
  // with the same `compared`, which is exactly why the verdict could not tell them apart -- so a single
  // assertion on either one passes while the defect is present.
  const everything = fleetConsistency([fullyReporting("http://a:8765"), fullyReporting("http://b:8765")]);
  // ONE VARIABLE between the two fleets: same guests, same policy block, `displayMode` deleted. Anything
  // else different and the pair stops being a control for this field and becomes a control for the axis.
  const reportingAllBut = (worker: string) => {
    const guest = fullyReporting(worker);
    const { displayMode, ...rest } = guest.environment;
    assert.equal(typeof displayMode, "string",
      "the fixture must have HELD displayMode for deleting it to mean anything");
    return { ...guest, environment: rest };
  };
  const blind = fleetConsistency([reportingAllBut("http://a:8765"), reportingAllBut("http://b:8765")]);

  assert.equal(everything.consistent, true);
  assert.equal(blind.consistent, true, "the absent-skip rule is unchanged: nobody reporting it is not a mismatch");
  assert.equal(everything.compared, blind.compared, "and the GUEST count cannot tell these apart either");

  assert.deepEqual(everything.fields.unchecked, [],
    "a fleet reporting every MUST_MATCH field has nothing unchecked -- the positive control for the line below");
  assert.deepEqual(blind.fields.unchecked, ["displayMode"],
    "and the field NO guest reported is named, which is the whole distinction this row exists for");
  const everyField = MUST_MATCH.length + POLICY_MUST_MATCH.length;
  assert.equal(everything.fields.compared.length, everyField,
    "every field this compares drew a value, so every one of them is named as compared");
  assert.equal(blind.fields.compared.length, everyField - 1,
    "and the blind fleet is short by exactly the one field, never by a whole axis");
  assert.ok(!blind.fields.compared.includes("displayMode"),
    "and it is not on both lists: compared and unchecked are a partition, not two views of the same set");
});

test("#1997: ONE guest reporting a field still counts as COMPARED, never as unchecked", () => {
  // The rolling-deploy case the absent-skip rule exists for, and the line this row deliberately does not
  // cross. A field the deploy has reached on one guest HAS been compared -- on the guests that have it --
  // and calling that "compared on nobody" would flag every mid-deploy fleet for a field it can already
  // see. That partial coverage still weakens the headline is true and is #2019's question, not this one.
  const { consistent, fields } = fleetConsistency([
    fullyReporting("http://new:8765", { displayMode: "1024x768" }),
    { worker: "http://old:8765", environment: { browserVersion: "same-browserVersion" }, policy: undefined },
  ]);
  assert.equal(consistent, true, "a guest missing a field others report is still not a mismatch");
  assert.ok(fields.compared.includes("displayMode"), "one value is a comparison, not a gap");
  assert.deepEqual(fields.unchecked, [], "nothing here was asked of everybody and answered by nobody");
});

test("#1997: a block the CALLER never collected is not a field the fleet failed to report", () => {
  // `fleet:status` and `doctor` both pass `policy: undefined` -- `/health` carries no policy block at all,
  // so POLICY_MUST_MATCH is compared by nobody in production. That is a fact about the PROBE, and
  // reporting it as "the guests do not report these" would print a permanent two-field gap on every
  // reading and drown the one field that a deploy could actually fix.
  const { fields } = fleetConsistency([
    { worker: "http://a:8765", environment: fullyReporting("x").environment, policy: undefined },
    { worker: "http://b:8765", environment: fullyReporting("y").environment, policy: undefined },
  ]);
  assert.deepEqual(fields.unchecked, []);
  assert.ok(!fields.compared.some((f) => f.startsWith("edgePolicy.")),
    "and it is not claimed as compared either: not asked is its own answer, on both lists");

  // The positive control: a caller that DOES collect the block gets the policy fields on a list. Without
  // this, the assertions above would pass on an implementation that dropped the policy axis entirely.
  const collected = fleetConsistency([fullyReporting("http://a:8765"), fullyReporting("http://b:8765")]);
  assert.ok(collected.fields.compared.includes("edgePolicy.StartupBoostEnabled"));
  const empty = fleetConsistency([
    { worker: "http://a:8765", environment: fullyReporting("x").environment, policy: {} },
    { worker: "http://b:8765", environment: fullyReporting("y").environment, policy: {} },
  ]);
  assert.deepEqual(empty.fields.unchecked, ["edgePolicy.StartupBoostEnabled", "edgePolicy.BackgroundModeEnabled"],
    "a policy block that was collected and holds neither value IS a field nobody reported");
});

// --- #2019: HOW MANY guests reported each field, not only whether any did ---

test("#2019: THE PAIR -- a field every guest reports and a field ONE guest reports carry different counts", () => {
  // The defect this row is about, at the layer that can still see it. Both fleets below are
  // `consistent: true` with the same `compared` list and an empty `unchecked` -- #1997's partition cannot
  // tell them apart, by design, because one guest reporting a field HAS been compared. The count is the
  // only thing that differs, so it is the only thing `fleet:status` can draw its line from.
  const everybody = fleetConsistency([fullyReporting("http://a:8765"), fullyReporting("http://b:8765"),
    fullyReporting("http://c:8765")]);
  const one = fleetConsistency([
    fullyReporting("http://a:8765", { displayMode: "1024x768" }),
    { worker: "http://b:8765", environment: { browserVersion: "same-browserVersion" }, policy: undefined },
    { worker: "http://c:8765", environment: { browserVersion: "same-browserVersion" }, policy: undefined },
  ]);
  const displayOf = (verdict: ReturnType<typeof fleetConsistency>) =>
    verdict.fields.coverage.find((entry) => entry.field === "displayMode");

  assert.deepEqual(displayOf(everybody), { field: "displayMode", reported: 3, asked: 3 });
  assert.deepEqual(displayOf(one), { field: "displayMode", reported: 1, asked: 3 },
    "one guest of three, said as a count -- the reading `fleet:status` called interchangeable");

  // #1997's answer is UNCHANGED on both, which is what makes this an addition rather than a re-decision.
  assert.equal(one.consistent, true, "a guest missing a field others report is still not a mismatch");
  assert.deepEqual(one.fields.unchecked, [], "and it is still COMPARED, not unchecked");
  assert.ok(one.fields.compared.includes("displayMode"));
});

test("#2019: the reporter count is COUNTED -- guests with no `worker` name cannot collapse it", () => {
  // #2018, which is why done-when 6 says counted rather than read. `values` is keyed by worker name, and
  // `capture-real-pages.mjs` calls this with guests that carry none -- every one of them lands on a single
  // `undefined` key, so `Object.keys(values).length` reads 1 however many guests reported. That understates
  // coverage in exactly the case a coverage number exists for, and it would read as 1-of-3 on a fleet where
  // all three answered. THE POSITIVE CONTROL for the counting is the pair above; this is the control for
  // the SOURCE of the count.
  const anonymous = () => ({ environment: fullyReporting("ignored").environment, policy: undefined });
  // The cast is the POINT of the case, not a convenience: the type says every guest carries a `worker`,
  // and `capture-real-pages.mjs` passes guests that do not, which is what #2018 measured.
  const { fields } = fleetConsistency(
    [anonymous(), anonymous(), anonymous()] as unknown as Parameters<typeof fleetConsistency>[0]);
  const browser = fields.coverage.find(({ field }) => field === "browserVersion");
  assert.deepEqual(browser, { field: "browserVersion", reported: 3, asked: 3 },
    "three nameless guests reported it, and a count read off the values map would say one");
});

test("#2019: coverage counts the guests that carried the BLOCK, never all the guests", () => {
  // `asked` is the denominator, and it is per-field because the two blocks are collected independently:
  // `/health` carries no policy at all, so every production caller passes `policy: undefined`. Dividing by
  // the guest count instead would report every policy field as 0-of-N on every real reading -- the
  // permanent gap #1997 refused -- and would make the `k of N` line fire forever on a fact about the probe.
  const { fields } = fleetConsistency([
    fullyReporting("http://a:8765"),
    { worker: "http://b:8765", environment: fullyReporting("x").environment, policy: undefined },
  ]);
  const policy = fields.coverage.find(({ field }) => field === "edgePolicy.StartupBoostEnabled");
  assert.deepEqual(policy, { field: "edgePolicy.StartupBoostEnabled", reported: 1, asked: 1 },
    "one guest carried the policy block and reported it: 1 of 1, not 1 of 2");
  const browser = fields.coverage.find(({ field }) => field === "browserVersion");
  assert.deepEqual(browser, { field: "browserVersion", reported: 2, asked: 2 },
    "while the environment block, which both carried, has both as its denominator");
});

test("#2019: coverage is a row per ASKED field, so nothing on it is absent from the lists", () => {
  // The lists and the counts are one measurement thresholded, and `fleet:status` now draws BOTH its
  // clauses off the counts. A field on one and not the other would let those two readings disagree, which
  // is the defect of this whole family one level up.
  const { fields } = fleetConsistency([fullyReporting("http://a:8765"), fullyReporting("http://b:8765")]);
  const named = fields.coverage.map(({ field }) => field).sort();
  assert.deepEqual(named, [...fields.compared, ...fields.unchecked].sort(),
    "every asked field is on the coverage, and the coverage names no field that was not asked");
  assert.ok(fields.coverage.length > 0, "the positive control: a deepEqual of two empty lists passes");
  assert.ok(fields.coverage.every(({ reported, asked }) => reported === asked),
    "and a fully-reporting fleet has every field at N of N -- the control for the partial readings above");
});
