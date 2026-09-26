// The pool assumes guests are interchangeable: cases are dispatched to whichever is free, the cache
// lets any guest reuse another's evidence, and a good/bad pair is only comparable because both halves
// came from equivalent machines. Two real divergences happened in one day and BOTH were caught by a
// human reading a console by eye. These tests are the replacement for that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fleetConsistency, describeMismatches, describeReportedOnly, MUST_MATCH, POLICY_MUST_MATCH,
  REPORTED_ONLY } from "./fleet-consistency.mjs";
import { layerFile } from "../../guards/src/layer-file.mjs";

/** The worker's `server.mjs` as TEXT, found by package name (#2613): it is not importable (guidepup at module scope) and not an export. */
const workerServerSource = () =>
  readFileSync(layerFile("@a11ign/nvda-worker", "src/server.mjs", { from: import.meta.dirname }), "utf8");

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
  const server = workerServerSource();
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

test("THE ROLLING DEPLOY IS CAUGHT -- a pinned guest against a still-maximized one", () => {
  // THE POSITIVE CONTROL for `windowSize` (#1561), and it is the split this field exists for rather than
  // an invented one: while the pin rolls out, some guests ask Edge for `--window-size=1024,768` and the
  // rest are still on `--start-maximized` and report no `windowSize` at all.
  //
  // `captureProtocol` cannot separate those two -- both guests are on 21 -- so without this field a
  // half-deployed fleet reads CONSISTENT and writes two evidence populations into one corpus under one
  // key. That is `provisionRevision`'s failure one deploy later, and it is the reason this field is in
  // the cache key as well (`environmentKey`), which `displayMode` deliberately is not.
  const { consistent, mismatches } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { windowSize: "1024x768" }),
    guest(`http://${IP.g5}:8765`, { windowSize: "maximized" }),
  ]);
  assert.equal(consistent, false);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].field, "windowSize");
  assert.match(describeMismatches(mismatches)[0], /\.4=1024x768 \.5=maximized/);
});

test("a fleet pinned to one window size is consistent", () => {
  // The other direction, and not the same assertion twice: a field that flagged two guests holding the
  // SAME pin would take `fleet:status` offline over nothing, which is how a diagnostic gets switched off.
  // It is also what the fleet reads once the deploy completes, so this is the NORMAL state rather than a
  // hypothetical one.
  const { consistent, mismatches } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { windowSize: "1024x768" }),
    guest(`http://${IP.g5}:8765`, { windowSize: "1024x768" }),
  ]);
  assert.equal(consistent, true);
  assert.deepEqual(mismatches, []);
});

test("#1561: the PIN and the DESKTOP are two fields, and a guest can differ on either", () => {
  // The defect a single field would have: `displayMode` is what the screen holds and `windowSize` is what
  // the worker asks Edge for, and they are the same number today only because provisioning made them so
  // (#1567). A guest pinned to 1024x768 on a 1280x1024 desktop is a legitimate future state -- it is how
  // a wider pin would be measured before it is adopted -- and collapsing the two would report it as
  // agreement on the one axis that decides what the page looks like.
  const { mismatches } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { displayMode: "1024x768", windowSize: "1024x768" }),
    guest(`http://${IP.g5}:8765`, { displayMode: "1280x1024", windowSize: "1024x768" }),
  ]);
  assert.deepEqual(mismatches.map((m: { field: string }) => m.field), ["displayMode"],
    "the desktops differ and the pins agree, so exactly one of the two fields may fire");
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

// --- #2063: THE THIRD CHANNEL — compared, named, and gating nothing ---

test("#2063: THE PAIR — a fleet split on a reported-only field is NAMED, and one agreeing on it is not", () => {
  // THE CHANNEL'S OWN READING, and its subject is `displayAdapter` because `nodeVersion` LEFT this
  // channel at #2170 -- step 3 of `ceo`'s ruling, taken once the fleet converged on the pin. Driving
  // this pair with `nodeVersion` now would assert that a runtime split is not a mismatch, which is the
  // opposite of what this file asserts two tests down, and the ruling's exemption would be guarded by
  // nothing.
  //
  // The adapter split is the live one, measured 2026-09-23T18:02Z: `Intel(R) UHD Graphics 630` on nine
  // guests and `Intel(R) HD Graphics 630` on `.224`. One letter apart and real hardware, which is why it
  // stays here rather than graduating -- no provisioning run converges it.
  //
  // BOTH DIRECTIONS IN ONE TEST ON PURPOSE. An exclusion assertion alone -- "it is not a mismatch" --
  // passes on a comparison that compares nothing, which is this row's own mutation 1. The agreeing fleet
  // is what proves the naming is a reading rather than a constant.
  const split = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { displayAdapter: "Intel(R) UHD Graphics 630" }),
    guest(`http://${IP.g5}:8765`, { displayAdapter: "Intel(R) HD Graphics 630" }),
  ]);
  const agreed = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { displayAdapter: "Intel(R) UHD Graphics 630" }),
    guest(`http://${IP.g5}:8765`, { displayAdapter: "Intel(R) UHD Graphics 630" }),
  ]);

  assert.deepEqual(split.reportedOnly.map((d) => [d.field, d.state]), [["displayAdapter", "drifted"]],
    "the split is named, and only the field that actually split");
  assert.deepEqual(agreed.reportedOnly, [],
    "and a fleet that agrees on it reports nothing — a channel that always names its fields would pass "
    + "the assertion above while reading nothing off the guests");

  // LOCATED, not just detected, which is `describeMismatches`'s own rule one channel over.
  const [line] = describeReportedOnly(split.reportedOnly);
  assert.match(line, /displayAdapter: \.4=Intel\(R\) UHD Graphics 630 \.5=Intel\(R\) HD Graphics 630/);
});

test("#2170: THE PAIR — a fleet split on nodeVersion is a MISMATCH, and a converged one is consistent", () => {
  // THE FIELD THAT MOVED, and the assertion this row exists to add. `ceo`'s ruling on #2063 ordered the
  // three steps -- report it, pin provisioning so the fleet converges, only then may it gate -- and this
  // is the third, unblocked by `orchestrator`'s reading at 2026-09-23T18:02Z: all ten guests on
  // v24.20.0, read off their own `/health`, against the 5/5 split measured at 06:55Z the same morning.
  //
  // BOTH DIRECTIONS, for the reason the pair above states and this row's body restates: an exclusion
  // test alone passes on a comparison that compares nothing. `v24.19.0` against `v24.20.0` is the split
  // the fleet actually ran, not an invented one.
  const split = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { nodeVersion: "v24.19.0" }),
    guest(`http://${IP.g5}:8765`, { nodeVersion: "v24.20.0" }),
  ]);
  assert.equal(split.consistent, false, "two runtimes in one fleet write two populations into one corpus");
  assert.deepEqual(split.mismatches.map((m) => m.field), ["nodeVersion"],
    "and it is the gating channel it enters — the one `capture-fleet-guard` exits 3 on");
  assert.ok(!split.reportedOnly.some((d) => d.field === "nodeVersion"),
    "and NOT the reported-only channel as well: a field in both would be refused and exempted at once");
  assert.match(describeMismatches(split.mismatches)[0], /nodeVersion: \.4=v24\.19\.0 \.5=v24\.20\.0/,
    "located, not merely detected");

  const converged = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { nodeVersion: "v24.20.0" }),
    guest(`http://${IP.g5}:8765`, { nodeVersion: "v24.20.0" }),
  ]);
  assert.equal(converged.consistent, true,
    "and the fleet as it stands since 18:02Z still runs — a gate that refused the CONVERGED fleet is the "
    + "harm the ruling's ordering exists to prevent, arriving one step late instead of early");
  assert.deepEqual(converged.mismatches, []);
  assert.deepEqual(converged.fields.coverage.find((c) => c.field === "nodeVersion"),
    { field: "nodeVersion", reported: 2, asked: 2 },
    "and it is on the COVERAGE channel now too, which is #2047's second refusal: a guest that stops "
    + "reporting it refuses the run. `capture-fleet-guard.test.ts` pins that consequence.");
});

test("#2063: THE RULING — a reported-only split is `consistent: true` and reaches NO gate", () => {
  // The ruling's own clause, still guarded, one field over. `displayAdapter` is what carries it since
  // #2170 moved `nodeVersion` out, and it is the member that cannot ever graduate: the values differ by
  // HARDWARE, so a gate here would refuse `.224` for ever rather than until the next provisioning run.
  //
  // THERE ARE EXACTLY TWO GATING CHANNELS and this asserts against both, because #2047 made the second
  // one a refusal too: `capture-fleet-guard` exits 3 on a non-empty `mismatches` AND on any row of
  // `fields.coverage` where `reported < asked`.
  const { consistent, mismatches, fields } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { displayAdapter: "Intel(R) UHD Graphics 630" }),
    guest(`http://${IP.g5}:8765`, { displayAdapter: "Intel(R) HD Graphics 630" }),
  ]);
  assert.equal(consistent, true, "a reported-only split must not read as an inconsistent fleet");
  assert.deepEqual(mismatches, [], "and must not enter the channel that exits 3");
  assert.ok(!fields.coverage.some(({ field }) => field === "displayAdapter"),
    "nor the coverage channel, which #2047 made a refusal as well — a field there gates at ANY count");
  assert.ok(!fields.compared.includes("displayAdapter") && !fields.unchecked.includes("displayAdapter"),
    "and not on the lists those are derived from either");

  // The positive control for those three exclusions: the same verdict DOES carry the gating fields, so
  // the assertions above are reading a populated structure rather than an empty one.
  assert.ok(fields.coverage.some(({ field }) => field === "browserVersion"));
});

test("#2063: a reported-only field NOBODY reports is `unreported`, not silence", () => {
  // Clause 3 of #2063, and the state `displayAdapter` was in on every guest until the worker carrying it
  // was deployed on 2026-09-23 -- the state any field entering this channel starts in, which is why the
  // case outlives the deploy. `check()` skips an absent value, so silence here would put the field back in
  // exactly the condition #1997 is about -- compared on nobody, indistinguishable from agreed on by
  // everybody -- while a refusal would stop every capture in the project immediately.
  const { consistent, reportedOnly } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { nodeVersion: "v24.20.0" }),
    guest(`http://${IP.g5}:8765`, { nodeVersion: "v24.20.0" }),
  ]);
  assert.equal(consistent, true, "an unreported field refuses nothing");
  assert.deepEqual(reportedOnly.map((d) => [d.field, d.state, d.reported, d.asked]),
    [["displayAdapter", "unreported", 0, 2]],
    "named with its count, so a reader can tell 0 of 2 from a field that agreed");
  assert.match(describeReportedOnly(reportedOnly)[0], /not reported by any of 2 guests/);
});

test("#2063: a reported-only field only SOME guests report is named with its count", () => {
  // The rolling-deploy reading, which for a GATING field is #2019's refusal and here is a sentence. It
  // must not read as agreement on the strength of the one guest that answered -- the defect #2019 fixed
  // on the other channel -- and it must not refuse the deploy that is mid-flight.
  const { consistent, reportedOnly } = fleetConsistency([
    guest(`http://${IP.g4}:8765`, { displayAdapter: "Intel(R) UHD Graphics 630" }),
    guest(`http://${IP.g5}:8765`),
  ]);
  assert.equal(consistent, true);
  const adapter = reportedOnly.find((d) => d.field === "displayAdapter");
  assert.deepEqual([adapter?.state, adapter?.reported, adapter?.asked], ["unreported", 1, 2]);
  assert.match(describeReportedOnly([adapter!])[0], /\.4=Intel\(R\) UHD Graphics 630 \(1 of 2 guests reported it\)/);
});

test("#2063: EVERY REPORTED_ONLY FIELD IS ONE THE WORKER ACTUALLY REPORTS", () => {
  // `EVERY MUST_MATCH FIELD…` above, for the second channel, and it matters MORE here: a typo in
  // `MUST_MATCH` at least shows up as a permanent coverage gap that refuses a run, while a typo here is
  // a field that reads `unreported` for ever and looks exactly like a fleet that has not been deployed.
  const server = workerServerSource();
  const start = server.indexOf("function runtimeEnvironment() {");
  const end = server.indexOf("function provisionRevision() {");
  assert.ok(start !== -1 && end > start, "server.mjs no longer has a runtimeEnvironment block to read");
  const reported = server.slice(start, end);

  const missing = REPORTED_ONLY.map((f) => f.path).filter((path) => !reported.includes(`${path}:`));
  assert.deepEqual(missing, [], "REPORTED_ONLY names fields the worker's /health environment never sends");

  // The positive control for the line above, the same one the MUST_MATCH test carries: the matcher has
  // to be able to MISS, or an empty list proves nothing.
  assert.ok(!reported.includes("displayAdapterThatIsNotReported:"),
    "the source matcher matches names that are not there, so the assertion above proves nothing");
});

test("#2063: the two channels compare the same way — a reported-only field is not a second rule", () => {
  // One reader, two consequences. If the channels compared differently, "reported by 1 of 10" would mean
  // one thing in a refusal and another in a report, and no reader could tell which was right. The pair
  // below is the same fleet shape on a gating field and on a reported-only one.
  const guests = (over: Record<string, unknown>) => [
    guest(`http://${IP.g4}:8765`, over), { worker: `http://${IP.g5}:8765`, environment: {}, policy: undefined },
  ];
  const gating = fleetConsistency(guests({ displayMode: "1024x768" }));
  const noted = fleetConsistency(guests({ displayAdapter: "Intel(R) UHD Graphics 630" }));
  assert.deepEqual(gating.fields.coverage.find((c) => c.field === "displayMode"),
    { field: "displayMode", reported: 1, asked: 2 });
  const same = noted.reportedOnly.find((d) => d.field === "displayAdapter");
  assert.deepEqual([same?.reported, same?.asked], [1, 2],
    "the same one-of-two reading, counted identically — only what is DONE with it differs");
});

// #2211: WHAT AN OPERATOR IS TOLD ABOUT `displayAdapter` IS PINNED, NOT JUST WHAT THE FIELD DOES. The
// `#2063` tests above hold its behaviour (drift state, channel, census line) and none of its TEXT, so the
// sentence "no deployed worker reports it yet" was corrected once (#2246) with nothing keeping it corrected,
// and it printed on every `fleet:status` run directly beneath ten reported values.

/** Sentences that assert the field is unreported. Each is a spelling the old text used or would reword to. */
const CLAIMS_UNREPORTED = [
  /\bno (deployed )?(worker|guest)s? (reports?|sends?) it\b/i,
  /\breads? (as )?`?unknown`? (across|on every|on all)\b/i,
  /\buntil (this code|the worker|it) (is|has been|was) deployed\b/i,
  /\bwhich it will until\b/i,
];
const claimsUnreported = (text: string) => CLAIMS_UNREPORTED.some((claim) => claim.test(text));

/** Every occurrence of `reading` must sit within `reach` characters of a calendar date, either side. */
function readingsWithoutADate(text: string, reading: RegExp, reach = 160) {
  const dated = (at: number) => /\d{4}-\d{2}-\d{2}/.test(text.slice(Math.max(0, at - reach), at + reach));
  return [...text.matchAll(new RegExp(reading.source, "g"))].filter((m) => !dated(m.index)).length;
}
const HARDWARE_READINGS = [/640x480/, /Intel\(R\) (UHD|HD) Graphics 630/];

const displayAdapterEntry = () => REPORTED_ONLY.find((f) => f.path === "displayAdapter")!.why;
const workerDisplayAdapterComment = () => {
  const server = workerServerSource();
  // The comment is the SUBJECT here, so it is not stripped -- and it is located by the two CODE lines
  // that bracket it, so what is found cannot be a phrase that lives only in prose (#1213's defect).
  const start = server.indexOf("windowSize: CAPTURE_WINDOW_SIZE,");
  const end = server.indexOf("displayAdapter: displayAdapter(),");
  assert.ok(start !== -1 && end > start, "server.mjs no longer carries displayAdapter's comment to read");
  const between = server.slice(start, end);
  assert.ok(/WHICH ADAPTER IS DRIVING/.test(between), "the code anchors no longer bracket displayAdapter's comment");
  return between;
};

test("#2211: displayAdapter's exemption text does not claim the field is unreported, and says it is reported", () => {
  const why = displayAdapterEntry();
  assert.equal(claimsUnreported(why), false,
    "the exemption tells operators no guest reports displayAdapter, on the line that prints ten values");
  assert.match(why, /10 of 10 guests report it/, "and states the reading that is true instead of merely omitting the false one");

  // The positive control for the negative above: the sentence this row removed, verbatim, must be caught.
  // Without it `false` proves only that the patterns matched nothing.
  assert.equal(claimsUnreported("NOT a gate: no deployed worker reports it yet, so it reads unknown across the fleet"),
    true, "the matcher does not recognise the very sentence it exists to keep out");
});

test("#2211: the worker's own displayAdapter comment claims no absence either", () => {
  const comment = workerDisplayAdapterComment();
  assert.equal(claimsUnreported(comment), false,
    "the reporter still says the fleet reads the field as unknown `until this code is deployed`");
  assert.equal(claimsUnreported("the fleet reading it as `unknown` on every guest -- which it will until this code is deployed"),
    true, "the matcher does not recognise the comment this row removed");
});

test("#2211: every hardware reading in displayAdapter's text is attributable to a moment", () => {
  for (const [where, text] of [["exemption", displayAdapterEntry()], ["worker comment", workerDisplayAdapterComment()]] as const) {
    for (const reading of HARDWARE_READINGS) {
      if (!reading.test(text)) continue; // a reading that is absent is not an undated one
      assert.equal(readingsWithoutADate(text, reading), 0,
        `${where}: ${reading} appears with no date beside it, so a reader cannot tell June from an hour ago`);
    }
  }
  // Positive control: the undated clause this row dated, and the exemption's own 640x480 must be READ at all.
  assert.equal(readingsWithoutADate("workers 7-11 fell back to the Basic Display Adapter and captured at 640x480", /640x480/), 1,
    "the date matcher accepts an undated reading");
  assert.ok(/640x480/.test(displayAdapterEntry()), "the exemption no longer carries the reading this test dates");
});
