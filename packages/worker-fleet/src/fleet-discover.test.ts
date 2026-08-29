// The interesting cases are the ones that only happen when something has already gone wrong, so they are
// tested without a network. The MOVED case is the one that cost real time: the worker drifted from .83 to
// .102 by DHCP, and probing the old address returned nothing — which is indistinguishable from a box that
// is switched off. That is the worst kind of staleness, because the fleet gets QUIETER as it happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { reconcile, inventoryHosts, normaliseMac, enrol } from "./fleet-discover.mjs";
import { workersFromInventory } from "./fleet-env.mjs";

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

test("a box at a worker's declared address with a DIFFERENT mac is NOT that worker", () => {
  // DHCP moved a worker from .83 to .102 once; if the freed address is later leased to another worker
  // while the first box is powered down, an IP-only match reports the DEAD machine as healthy, carrying
  // the other box's /health. Measured before the fix: w1 "ok", w2 "moved to REDACTED-INTERNAL-ADDRESS" -- one physical
  // box, two findings, and the healthy-looking one does not exist.
  //
  // The pre-existing "at its declared address is OK" test passes a MATCHING mac, so it pinned the shape
  // the code produced and could never see this. That is why the case is here and not folded into it.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" },
     { name: "w2", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:02" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:02", health }]);
  const w1 = found.find((f) => f.name === "w1");
  const w2 = found.find((f) => f.name === "w2");
  assert.equal(w1?.state, "absent");
  assert.equal(w2?.state, "moved");
  assert.equal(w2?.foundAt, "REDACTED-INTERNAL-ADDRESS");
  assert.equal(found.length, 2, "one physical box must not produce a third finding");
});

test("a declared worker with NO mac still matches on address", () => {
  // An inventory entry with no `mac:` is the normal state for a box nobody has read the address off --
  // inventory.yml says so, and enrolment deliberately records such a box. So an absent MAC must mean
  // "cannot check", never "does not match": the strict version of the fix above reported every
  // un-enrolled worker absent, which is the fleet going quiet, the fault this module exists to prevent.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: null }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:09", health }]);
  assert.equal(found[0].state, "ok");
});

test("ARP missing the mac of a box that just answered still matches on address", () => {
  // `macOf` returns null whenever ARP has no entry, which happens. The unknown side is the DISCOVERED
  // one here rather than the declared one, and it must be just as forgiving.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: null, health }]);
  assert.equal(found[0].state, "ok");
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
  const text = readFileSync(fileURLToPath(new URL("../../control/ansible/inventory.yml", import.meta.url)), "utf8");
  const hosts = inventoryHosts(text);
  assert.ok(hosts.length >= 1, "the shipped inventory should declare at least one worker");
  for (const h of hosts) assert.match(h.host, /^[\d.]+$/);
});

// ---------------------------------------------------------------------------------------------------
// Enrolment has to land in the WORKER group, and the only way to know is to read it back with the
// reader a run actually uses. These two modules were independently correct and jointly broken for the
// length of one commit on 2026-08-21: `fleet-env.mjs` became group-aware, `inventory.yml` gained the
// control-plane group, and `enrol` was still appending to the END OF THE FILE — so the next enrolled
// worker would have landed in `a11y_lab` and been correctly ignored by the reader. Provisioned,
// updated, never dispatched to, and nothing to say so.

const REAL_INVENTORY = readFileSync(
  fileURLToPath(new URL("../../control/ansible/inventory.yml", import.meta.url)), "utf8");

test("an enrolled worker is visible to the reader a RUN uses, not merely present in the file", () => {
  const { text, added } = enrol(REAL_INVENTORY, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }],
    "2026-08-21");

  assert.equal(added.length, 1);
  // The real assertion: parsed back, not grepped for. Being in the file is not the same as being a worker.
  assert.ok(workersFromInventory(text).includes("http://REDACTED-INTERNAL-ADDRESS:8765"),
    "an enrolled worker must be in the worker group — appending past the last group hides it");
});

test("enrolment does not disturb the workers already declared", () => {
  const before = workersFromInventory(REAL_INVENTORY);
  const { text } = enrol(REAL_INVENTORY, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }],
    "2026-08-21");

  assert.deepEqual(workersFromInventory(text).filter((w) => !w.includes("REDACTED-INTERNAL-ADDRESS")), before);
});

test("enrolment does not turn the control plane into a capture worker", () => {
  // The lab is in the inventory so there is one source of truth for what exists. It must never become
  // something a run dispatches capture cases to, before or after an enrolment.
  const { text } = enrol(REAL_INVENTORY, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }],
    "2026-08-21");

  for (const url of workersFromInventory(text)) {
    assert.ok(!url.includes("REDACTED-INTERNAL-ADDRESS"), `the lab leaked into the fleet as ${url}`);
  }
});

test("enrolling nothing changes nothing", () => {
  const { text, added } = enrol(REAL_INVENTORY, [], "2026-08-21");
  assert.equal(added.length, 0);
  assert.equal(text, REAL_INVENTORY);
});

test("an inventory with no worker group REFUSES the enrolment rather than appending anyway", () => {
  assert.throws(
    () => enrol("all:\n  children:\n    a11y_lab:\n      hosts:\n        a11y-lab:\n          ansible_host: 1.2.3.4\n",
      [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }], "2026-08-21"),
    /declares no `a11y_workers:` group/);
});

test("inventoryHosts is group-aware too, or discover reports the lab as a sleeping worker", () => {
  // This module has its own host reader with its own regexes, and it matched host names at exactly eight
  // spaces of indentation — which is what the control-plane entry uses. So it returned the lab as a fifth
  // worker and `reconcile` called it ASLEEP?, probing :8765 on a box that has no worker and never will.
  const hosts = inventoryHosts(REAL_INVENTORY);

  assert.ok(hosts.length >= 4, "the real workers must still be found");
  for (const host of hosts) {
    assert.notEqual(host.name, "a11y-lab", "the control plane is not a capture worker");
    assert.notEqual(host.host, "REDACTED-INTERNAL-ADDRESS", "the control plane is not a capture worker");
  }
  // And the MACs still parse — wake.yml sends its magic packet to these, and a host read without its mac
  // is SKIPPED by wake rather than woken.
  assert.ok(hosts.every((h) => h.mac), "every declared worker still has its mac");
});
