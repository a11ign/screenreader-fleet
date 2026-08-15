// `fleet:status` answers "what are my boxes doing", so the tests are about the states it must keep
// APART. A status table that shows a dying worker as healthy, or a missing one as idle, is worse than no
// table at all — it is the "two states reported as one" shape this project keeps paying for.
import { test } from "node:test";
import assert from "node:assert/strict";

import { stateOf, activityOf, summarise } from "./fleet-status.mjs";

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
