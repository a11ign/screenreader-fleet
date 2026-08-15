// The interesting cases are the ones that only happen when something has already gone wrong, so they are
// tested without a network. The MOVED case is the one that cost real time: the worker drifted from .83 to
// .102 by DHCP, and probing the old address returned nothing — which is indistinguishable from a box that
// is switched off. That is the worst kind of staleness, because the fleet gets QUIETER as it happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { reconcile, inventoryHosts, normaliseMac } from "./fleet-discover.mjs";

const health = { code: "abc", environment: { screenReaderVersion: "2026.1.1" } };

test("a worker at its declared address is OK", () => {
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01", health }]);
  assert.equal(found[0].state, "ok");
});

test("a worker that MOVED is matched by MAC, not by address", () => {
  // Matching on IP is exactly what broke. The MAC comes from ARP after the box answers, so it needs no
  // change to /health — which matters, because a new field there would change codeVersion() and mark the
  // entire fleet stale.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01", health }]);
  assert.equal(found[0].state, "moved");
  assert.equal(found[0].foundAt, "REDACTED-INTERNAL-ADDRESS");
});

test("a worker that is off is ASLEEP, not a failure", () => {
  // This fleet is meant to be powered down between runs; doctor already refuses to call that a fault.
  const found = reconcile([{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }], []);
  assert.equal(found[0].state, "absent");
});

test("something answering that we do not know about is UNKNOWN, never adopted", () => {
  // The retired Proxmox VM answers /health on this LAN. A tool that adopted whatever replied would have
  // quietly added it to the fleet and produced evidence from a machine nobody provisioned.
  const found = reconcile([], [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "f2:24:19:33:b0:d3", health }]);
  assert.equal(found[0].state, "unknown");
  assert.equal(found[0].mac, "f2:24:19:33:b0:d3");
});

test("a moved worker is not ALSO reported as unknown", () => {
  // Otherwise one machine produces two findings and the count is a lie.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01", health }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].state, "moved");
});

test("without a MAC a moved worker cannot be recognised, and is not guessed at", () => {
  // It reports absent + unknown, which is honest: we genuinely cannot tell whether that is the same box.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: null }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01", health }]);
  assert.deepEqual(found.map((f) => f.state).sort(), ["absent", "unknown"]);
});

test("MAC formats are normalised, so 00-1A-2B and 00:1a:2b are one machine", () => {
  assert.equal(normaliseMac("00-1A-2B-3C-4D-5E"), "00:1a:2b:3c:4d:5e");
  assert.equal(normaliseMac("001a2b3c4d5e"), "00:1a:2b:3c:4d:5e");
  assert.equal(normaliseMac(""), null);
  assert.equal(normaliseMac("nonsense"), null);
});

test("the real inventory parses, and its hosts carry an address", () => {
  const text = readFileSync(fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url)), "utf8");
  const hosts = inventoryHosts(text);
  assert.ok(hosts.length >= 1, "the shipped inventory should declare at least one worker");
  for (const h of hosts) assert.match(h.host, /^[\d.]+$/);
});
