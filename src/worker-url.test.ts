// Relocated from control/src/fleet-layer/worker-url.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * A worker address is validated where it ENTERS the program.
 *
 * `--worker=http://:8765` reached a real run. Nothing checked the value beyond truthiness, and
 * `http://:8765` is truthy, so four capture shards spent 29 minutes against an unparseable address while
 * every worker in the fleet sat idle — and the run recorded "worker never became ready" as a failure of the
 * PAGE, not of the argument. `requestJson` would have thrown `ERR_INVALID_URL` in under a second; a bare
 * `catch` in the readiness loop absorbed it as "mid-boot".
 *
 * This file pins the validator itself, `assertWorkerUrl`. The other half -- that every client which reads
 * `--worker=` actually CALLS it -- is a discovery over the clients, which live outside this package, so
 * it stays with them: a validator is only worth anything if every client calls it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertWorkerUrl } from "./worker-http.ts";

test("a well-formed address is accepted, and normalised", () => {
  assert.equal(assertWorkerUrl("http://203.0.113.107:8765"), "http://203.0.113.107:8765");
  // Trailing slash removed, because every caller appends `/capture` and `//capture` is a different route.
  assert.equal(assertWorkerUrl("http://203.0.113.107:8765/"), "http://203.0.113.107:8765");
  assert.equal(assertWorkerUrl("  http://host:1  "), "http://host:1");
  assert.equal(assertWorkerUrl("https://host:1"), "https://host:1");
});

test("the address that cost 29 minutes is refused", () => {
  assert.throws(() => assertWorkerUrl("http://:8765"), /is not a URL/);
});

test("the error explains what an empty host MEANS, because that is the recurring cause", () => {
  // "invalid URL" sends you looking at the code. "a shell variable expanded to nothing" sends you to the
  // command you typed, which is where the fault actually was, twice.
  assert.throws(() => assertWorkerUrl("http://:8765"),
    /shell variable expanding to nothing|does not survive `nohup bash -c`/);
});

test("empty, missing and wrong-scheme are each refused with their own message", () => {
  assert.throws(() => assertWorkerUrl(""), /required and was empty/);
  assert.throws(() => assertWorkerUrl(undefined), /required and was empty/);
  assert.throws(() => assertWorkerUrl(null), /required and was empty/);
  assert.throws(() => assertWorkerUrl("   "), /required and was empty/);
  assert.throws(() => assertWorkerUrl("ftp://host:1"), /must be http: or https:/);
  assert.throws(() => assertWorkerUrl("file:///etc/passwd"), /must be http: or https:/);
});

test("the source it names is the one in the message, so a second flag is not confusing", () => {
  assert.throws(() => assertWorkerUrl("nope", { source: "A11Y_WORKER" }), /A11Y_WORKER=nope/);
});
