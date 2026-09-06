/**
 * A worker address is validated where it ENTERS the program, and every client does it.
 *
 * `--worker=http://:8765` reached a real run. Nothing checked the value beyond truthiness, and
 * `http://:8765` is truthy, so four capture shards spent 29 minutes against an unparseable address while
 * every worker in the fleet sat idle — and the run recorded "worker never became ready" as a failure of the
 * PAGE, not of the argument. `requestJson` would have thrown `ERR_INVALID_URL` in under a second; a bare
 * `catch` in the readiness loop absorbed it as "mid-boot".
 *
 * So there are two halves and the second one is why this file is a DISCOVERY test rather than a list: a
 * validator is only worth anything if every client actually calls it, and a hardcoded list of clients is a
 * guard that checks the places somebody already thought of. That is the exact failure the budget ladder hit
 * — it read one hardcoded path and could not see the client that had the defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertWorkerUrl } from "./worker-http.mjs";
import { sourceFiles } from "./source-walk.mjs";

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

/** Every script that reads a `--worker=` argument, discovered rather than listed. */
function workerArgClients(): Array<[string, string]> {
  return sourceFiles().filter(([path, src]) =>
    src.includes('"--worker="') && !path.endsWith("worker-http.mjs"));
}

test("every client that takes --worker validates it", () => {
  const clients = workerArgClients();

  // A discovery finding nothing passes every assertion below in perfect silence, which is this repo's own
  // rule about a check that reports success having examined nothing.
  assert.ok(clients.length >= 3,
    `only found ${clients.length} --worker clients; the discovery walk is broken, not the codebase clean`);

  for (const [name, src] of clients) {
    assert.match(src, /assertWorkerUrl/,
      `${name} reads --worker but never validates it. A truthiness check passes \`http://:8765\`, and the `
      + "cost of that is 5 minutes per page of readiness timeout recorded as a failure of the page.");
  }
});

test("no client rolls its own worker-URL check instead of calling the shared one", () => {
  // A second validator is a second thing to drift. This is the same argument as one channel table, one
  // inventory reader, one source walk.
  for (const [name, src] of workerArgClients()) {
    assert.ok(!/new URL\((?:WORKER|worker)/.test(src),
      `${name} parses the worker address itself — call assertWorkerUrl so there is one definition`);
  }
});
