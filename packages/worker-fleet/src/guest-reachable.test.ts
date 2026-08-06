/**
 * The guest cannot reach the host's `localhost`, and getting that wrong is silent.
 *
 * The dataset pages are served on the HOST, but the GUEST fetches them itself. `localhost` inside the guest
 * resolves to the guest, which serves nothing — so Edge shows "localhost refused to connect", the title check
 * rejects the capture, and three attempts are burned per page before the run gives up. Nothing says "wrong
 * host": every transcript just describes an empty page.
 *
 * It has already failed the other way round. `hostAddress` was set only on the managed-VM path, so naming a
 * worker explicitly — `A11Y_WORKER`, or any pool — skipped the rewrite entirely, because "the worker is remote"
 * was treated as meaning "our localhost is fine", which it never does.
 *
 * These are pure string functions guarding an expensive, quiet failure, and nothing had tested them. Found by
 * measuring coverage properly: `local-vm.ts` is 208 lines that no test loaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { guestReachableUrl, hostAddressForWorker, isAfterRun, DEFAULT_WORKER } from "./local-vm.js";

/** A lease is only read for `worker` and `hostAddress` here, so the rest is deliberately absent. */
const lease = (worker: string, hostAddress?: string) =>
  ({ worker, hostAddress, release: async () => {} }) as unknown as Parameters<typeof guestReachableUrl>[1];

// `hostAddressFor` scans the machine's REAL network interfaces for one on the guest's subnet, so whether a
// derivation is possible depends on whether a UTM bridge exists right now. Asserting a rewritten address
// unconditionally made this fail with the VM stopped — a test that passes only on a machine with the right
// interface up is not Repeatable, and would have failed in CI. So the property is asserted both ways: derive an
// address and it must be used; derive nothing and the URL must be left exactly alone.
test("localhost is rewritten when a host address can be derived, and untouched when it cannot", () => {
  const worker = "http://REDACTED-INTERNAL-ADDRESS:8765";
  const derived = hostAddressForWorker(worker);
  const rewritten = guestReachableUrl("http://localhost:5050", lease(worker));
  if (derived) {
    assert.equal(rewritten, `http://${derived}:5050`,
      "the guest resolves localhost to itself and serves nothing, so it must be replaced");
    assert.doesNotMatch(rewritten, /localhost/);
  } else {
    assert.equal(rewritten, "http://localhost:5050",
      "with no derivable address, leaving it alone fails visibly on the first page — better than a guess");
  }
});

test("127.0.0.1 is treated as the same mistake as localhost", () => {
  // Both must take the same branch, whichever it is on this machine: they mean the same wrong thing.
  const worker = "http://REDACTED-INTERNAL-ADDRESS:8765";
  assert.equal(
    guestReachableUrl("http://127.0.0.1:5050", lease(worker)).replace("127.0.0.1", "localhost"),
    guestReachableUrl("http://localhost:5050", lease(worker)).replace("127.0.0.1", "localhost"),
  );
  // And the port always survives, which is what a run depends on.
  assert.match(guestReachableUrl("http://127.0.0.1:5050", lease(worker)), /:5050$/);
});

test("an explicit hostAddress on the lease wins over deriving one", () => {
  const rewritten = guestReachableUrl("http://localhost:5050", lease("http://REDACTED-INTERNAL-ADDRESS:8765", "REDACTED-INTERNAL-ADDRESS"));
  assert.equal(rewritten, "http://REDACTED-INTERNAL-ADDRESS:5050");
});

test("a worker named by hostname derives nothing, and the URL is left alone", () => {
  // The regression this guards: silently returning a rewritten URL for a worker whose address we cannot reason
  // about would be worse than leaving it — at least an unrewritten localhost fails visibly on the first page.
  assert.equal(hostAddressForWorker("http://build-agent-7:8765"), undefined);
  assert.equal(guestReachableUrl("http://localhost:5050", lease("http://build-agent-7:8765")),
    "http://localhost:5050");
});

test("a URL that is already host-reachable is returned untouched", () => {
  // Idempotence matters: the rewrite runs per run, and a second pass must not mangle an address.
  const already = "http://REDACTED-INTERNAL-ADDRESS:5050";
  assert.equal(guestReachableUrl(already, lease("http://REDACTED-INTERNAL-ADDRESS:8765")), already);
  const external = "https://www.washington.edu/accesscomputing/AU/before.html";
  assert.equal(guestReachableUrl(external, lease("http://REDACTED-INTERNAL-ADDRESS:8765")), external);
});

test("a trailing slash is not introduced, because the caller concatenates paths onto this", () => {
  // `captureUrl` builds `${baseUrl}/${id}/${variant}.html`, so a trailing slash yields a double slash and a 404
  // on every page in the run.
  // Uses the EXPLICIT hostAddress so the rewrite definitely runs — with a derived address this assertion could
  // pass on a machine where nothing was rewritten at all, which is a check that examines nothing.
  const rewritten = guestReachableUrl("http://localhost:5050", lease("http://REDACTED-INTERNAL-ADDRESS:8765", "REDACTED-INTERNAL-ADDRESS"));
  assert.equal(rewritten, "http://REDACTED-INTERNAL-ADDRESS:5050");
  assert.doesNotMatch(rewritten, /\/$/, `${rewritten} would produce a double slash and 404 every page`);
});

test("a malformed worker URL is refused rather than throwing mid-run", () => {
  assert.equal(hostAddressForWorker("not a url"), undefined);
  assert.equal(hostAddressForWorker(""), undefined);
  // And the rewrite survives it, because throwing here would abandon a run that could still proceed.
  assert.equal(guestReachableUrl("http://localhost:5050", lease("not a url")), "http://localhost:5050");
});

test("isAfterRun accepts exactly the four documented values", () => {
  for (const valid of ["restore", "stop", "pause", "leave"]) assert.equal(isAfterRun(valid), true, valid);
  for (const invalid of ["", "STOP", "kill", "restore ", "true"]) assert.equal(isAfterRun(invalid), false, invalid);
});

test("DEFAULT_WORKER is a usable URL", () => {
  // It is the fallback a run uses when nothing is configured, so a malformed value here fails every capture.
  assert.doesNotThrow(() => new URL(DEFAULT_WORKER));
  assert.match(DEFAULT_WORKER, /^https?:\/\//);
});
