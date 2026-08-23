// `fleet:status` answers "what are my boxes doing", so the tests are about the states it must keep
// APART. A status table that shows a dying worker as healthy, or a missing one as idle, is worse than no
// table at all — it is the "two states reported as one" shape this project keeps paying for.
import { test } from "node:test";
import assert from "node:assert/strict";

import { stateOf, activityOf, summarise } from "./fleet-status.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ready = { name: "w1", url: "http://REDACTED-INTERNAL-ADDRESS:8765", reachable: true, health: { ready: true, busy: false }, progress: { busy: false, capturing: null } };

test("the four worker states are distinct", () => {
  assert.equal(stateOf(ready), "ready");
  assert.equal(stateOf({ ...ready, health: { ready: true, busy: true } }), "busy");
  assert.equal(stateOf({ ...ready, health: { ready: false, busy: false } }), "warming");
  assert.equal(stateOf({ name: "w", url: "u", reachable: false }), "unreachable");
});

test("a worker with no `ready` field is ready, not warming", () => {
  // Same rule as workerIsUsable: `ready` is newer than some deployed guests, and calling an older one
  // "warming" forever would be a report about our own field history rather than about the machine.
  assert.equal(stateOf({ ...ready, health: { busy: false } }), "ready");
});

test("a busy worker says what it is doing and for how long", () => {
  // The answer the whole command exists for. `/progress` has been served by every worker since a capture
  // that hung for five minutes could only tell you it had died — and until now nothing read it.
  const activity = activityOf({
    ...ready,
    progress: {
      busy: true,
      capturing: "http://REDACTED-INTERNAL-ADDRESS:5050/form-error-silent/bad.html",
      elapsedMs: 95_000,
      lastPhase: "sweep",
    },
  });
  assert.match(activity, /^1m35s @sweep/, "elapsed time and the phase it is IN identify a hang");
  assert.match(activity, /form-error-silent\/bad\.html/, "and which case it is on");
});

test("an idle worker reports no activity rather than a stale one", () => {
  assert.equal(activityOf(ready), "");

  // THE CASE THIS TEST WAS NAMED FOR AND DID NOT COVER. `/progress` keeps the last capture's record after
  // it completes, so the probe that matters is an idle worker WITH a progress record, not one without.
  // Observed on a11y-worker-2: `ready`, and reported as `36m41s @browserKeptAlive` on a case that had
  // finished half an hour earlier.
  //
  // `elapsedMs` keeps growing while the box sits idle, so the stale line reads as an ever-worsening hang —
  // indistinguishable from the fault this column exists to detect, and the reason the name was written
  // before the behaviour existed.
  const finished = {
    ...ready,
    health: { ...ready.health, busy: false },
    // Copied from a real /progress on a11y-worker-2, 42 minutes after the capture ended: `busy` had
    // cleared, `capturing` had not, and `elapsedMs` was still growing.
    progress: {
      busy: false,
      capturing: "http://REDACTED-INTERNAL-ADDRESS:5050/table-unassociated-hilltown/bad.html",
      elapsedMs: 2_526_239,
      lastPhase: "browserKeptAlive",
    },
  };
  assert.equal(activityOf(finished), "",
    "a finished capture must not render identically to one that is still running");
});

test("a degraded worker is surfaced even though every capture is succeeding", () => {
  // The fault that produced ZERO failures: one guest's NVDA needed a recovery on every capture, the
  // worker's retry absorbed them all, and it ran at 122.9s against a healthy peer's 40.6s. `failures`
  // stayed 0, so no eviction rule could fire. The recovery RATE is the only number that moves.
  const [row] = summarise([{
    ...ready,
    health: { ready: true, busy: false, code: "abc", vitals: { captures: 50, recoveries: 48, failures: 0 } },
  }]);
  assert.equal(row.state, "ready", "it is still serving — degraded is not unhealthy");
  assert.equal(row.degraded, true);
  assert.match(row.degradedReason ?? "", /96%/);
});

test("an unreachable worker carries its error instead of looking idle", () => {
  const [row] = summarise([{ name: "w3", url: "http://REDACTED-INTERNAL-ADDRESS:8765", reachable: false, error: "connect ECONNREFUSED" }]);
  assert.equal(row.state, "unreachable");
  assert.equal(row.captures, null, "no vitals is 'we never heard', not 'it has done no work'");
  assert.match(row.error ?? "", /ECONNREFUSED/);
});

test("a healthy worker's row carries the code, so a stale box is visible here too", () => {
  const [row] = summarise([{
    ...ready,
    health: { ready: true, busy: false, code: "22822b7a3a08969c", vitals: { captures: 9, recoveries: 0, failures: 0 } },
  }]);
  assert.equal(row.code, "22822b7a3a08969c");
  assert.equal(row.degraded, false);
});

test("the summary says WHICH channel it probed, never an unqualified 'reachable'", () => {
  // This probes one channel — HTTP :8765 — and a worker can serve it perfectly while being unmanageable.
  // On 2026-08-23 all four reported reachable and CONSISTENT while `ansible-playbook deploy.yml` answered
  // UNREACHABLE on every one, because the tailnet ACL grants tcp:8765 and not tcp:22. The tool measured
  // exactly what it said; the WORD invited a conclusion it does not support, and an afternoon went into
  // diagnosing a fleet that was healthy.
  const source = readFileSync(
    fileURLToPath(new URL("./fleet-status.mjs", import.meta.url)), "utf8");
  assert.ok(!/\$\{status\.reachable\}\/\$\{status\.total\} reachable/.test(source),
    "the summary claims bare 'reachable' again; name the channel, because a reader will infer 'usable'");
  assert.match(source, /serving \/health/, "the summary must name the channel it actually probed");
  assert.match(source, /whether you can DEPLOY/,
    "it must say what it does NOT cover — deployability is a different channel with different access");
});
