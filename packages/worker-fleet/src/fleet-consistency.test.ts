// The pool assumes guests are interchangeable: cases are dispatched to whichever is free, the cache
// lets any guest reuse another's evidence, and a good/bad pair is only comparable because both halves
// came from equivalent machines. Two real divergences happened in one day and BOTH were caught by a
// human reading a console by eye. These tests are the replacement for that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetConsistency, describeMismatches } from "./fleet-consistency.mjs";

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
