import { test } from "node:test";
import assert from "node:assert/strict";

import { leaseWorker, DEFAULT_WORKER } from "./local-vm.js";

/**
 * `leaseWorker`'s precedence, proven rather than assumed.
 *
 * FOUND 2026-09-06 (audit §8): `leaseWorker` went straight from an explicit worker to the local UTM
 * VM, never reading `inventory.yml` at all — so a checkout WITH a bare-metal fleet declared and a UTM
 * guest still registered (the ordinary state of a Mac that used to run the deprecated pool) leased the
 * VM by default. `resolveWorkerPool` (`fleet-env.mjs`) already had the corrected order for the POOL
 * case; `worker-precedence.test.ts` is supposed to keep every resolver in line with it and could not
 * see this one, because it read only one of the two sources it compares.
 *
 * `deps.findLocalVm` here always resolves `null` in the cases that reach it: this suite is about the
 * ORDER of the decision, not about `acquireLocalWorker`'s own UTM mechanics, which are unchanged and
 * exercise real `utmctl` calls this suite has no business making.
 */

/** A findLocalVm spy that records whether it was ever asked, without touching real utmctl. */
function spyFindLocalVm() {
  let calls = 0;
  return { findLocalVm: async () => { calls += 1; return null; }, calls: () => calls };
}

test("an explicit worker wins outright — inventory and the local VM are never consulted", async () => {
  const inventorySpy = { calls: 0, fn: () => { inventorySpy.calls += 1; return ["http://inv:8765"]; } };
  const vmSpy = spyFindLocalVm();
  const lease = await leaseWorker(
    { worker: "http://named:8765/", after: "restore" },
    { inventory: inventorySpy.fn, findLocalVm: vmSpy.findLocalVm },
  );
  assert.equal(lease.worker, "http://named:8765", "the trailing slash must still be stripped");
  assert.equal(lease.source, "explicit");
  assert.equal(inventorySpy.calls, 0, "naming a worker means managing it yourself — nothing else may run");
  assert.equal(vmSpy.calls(), 0);
});

test("inventory.yml beats the local VM — the regression this unit closes", async () => {
  const vmSpy = spyFindLocalVm();
  const lease = await leaseWorker(
    { worker: null, after: "restore" },
    { inventory: () => ["http://a11y-worker-2:8765/", "http://a11y-worker-3:8765"], findLocalVm: vmSpy.findLocalVm },
  );
  assert.equal(lease.worker, "http://a11y-worker-2:8765", "the FIRST declared worker, trailing slash stripped");
  assert.equal(lease.source, "inventory.yml");
  assert.equal(vmSpy.calls(), 0, "the local VM must not even be looked up once the inventory has an answer");
});

test("no inventory falls through to the local VM check, exactly as before", async () => {
  const vmSpy = spyFindLocalVm();
  const lease = await leaseWorker(
    { worker: null, after: "restore" },
    { inventory: () => [], findLocalVm: vmSpy.findLocalVm },
  );
  assert.equal(lease.worker, DEFAULT_WORKER);
  assert.equal(lease.source, "default");
  assert.equal(vmSpy.calls(), 1, "an empty inventory must still ask whether a local VM is registered");
});

test("A11Y_LOCAL_VM=0 skips the local VM even with no inventory — unchanged escape hatch", async () => {
  const vmSpy = spyFindLocalVm();
  process.env.A11Y_LOCAL_VM = "0";
  try {
    const lease = await leaseWorker(
      { worker: null, after: "restore" },
      { inventory: () => [], findLocalVm: vmSpy.findLocalVm },
    );
    assert.equal(lease.worker, DEFAULT_WORKER);
    assert.equal(lease.source, "default");
    assert.equal(vmSpy.calls(), 0, "A11Y_LOCAL_VM=0 must still skip the VM lookup, moved or not");
  } finally {
    delete process.env.A11Y_LOCAL_VM;
  }
});

test("A11Y_LOCAL_VM=0 does not skip the inventory — that escape hatch is about the VM only", async () => {
  const vmSpy = spyFindLocalVm();
  process.env.A11Y_LOCAL_VM = "0";
  try {
    const lease = await leaseWorker(
      { worker: null, after: "restore" },
      { inventory: () => ["http://inv:8765"], findLocalVm: vmSpy.findLocalVm },
    );
    assert.equal(lease.source, "inventory.yml");
    assert.equal(vmSpy.calls(), 0);
  } finally {
    delete process.env.A11Y_LOCAL_VM;
  }
});

/**
 * MUTATION TARGET: reordering `leaseWorker` back to VM-before-inventory makes the second test above fail
 * (the lease would come back `source: "local-vm"` or the VM spy would be called), while the first,
 * third and fourth stay green — which is exactly the shape of the original defect: invisible on a
 * checkout with no inventory, wrong only on one that declares a fleet.
 */

test("no inventory and no local VM falls through to the historical default, unchanged", async () => {
  const lease = await leaseWorker(
    { worker: null, after: "restore" },
    { inventory: () => [], findLocalVm: async () => null },
  );
  assert.equal(lease.worker, DEFAULT_WORKER);
  assert.equal(lease.source, "default");
});
