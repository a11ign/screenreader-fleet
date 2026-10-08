// Host capacity decides how much parallelism a run gets. Getting it wrong in either direction is
// expensive: too many workers made every capture 1.6x slower and produced mute-NVDA failures, too few
// leaves the machine idle. These are the boundaries.
//
// `totalMb` is passed explicitly throughout. It defaults to this machine's real RAM, which would make
// the expectations depend on whoever runs the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityReason, workerCeilingFromTotalRam, workersHostCanRun } from "./host-capacity.mjs";

const MAC_36GB = 36_864;

test("the measured case: 12.6 GB available with one worker up allows a second, not a third", () => {
  // The real reading from the host this was written on. Three workers is what the pool used to start.
  assert.equal(workersHostCanRun({ availableMb: 12_654, alreadyRunning: 1, totalMb: MAC_36GB }), 2);
});

test("a host running more guests than it can afford is capped BELOW what is already up", () => {
  // The regression. This returned `alreadyRunning + canStart`, so it could never answer fewer than the
  // VMs that happened to be running — and a pool somebody had already started was therefore beyond its
  // reach. Three 8.1 GB guests on this 36 GB Mac drove 6.6 GB of swap and starved two of the three
  // until they stopped answering /health within 75 s.
  //
  // At the current 3072 MB guest size three genuinely fit, so the answer here is 3. The property under
  // test is not the number — it is that the result is ALLOWED to come out below `alreadyRunning`, which
  // it structurally could not before. Re-sizing the guests changes the number; it must not change that.
  assert.equal(workersHostCanRun({ availableMb: 13_743, alreadyRunning: 3, totalMb: MAC_36GB }), 3);
});

test("the ceiling comes from physical RAM, which swap cannot distort", () => {
  // vm_stat counts a swapped-out guest's pages as compressed/inactive and therefore as *available*, so
  // the dynamic estimate rises exactly as the host gets sicker — it advertised 13.7 GB free while two
  // guests were starving. The ceiling comes from physical RAM instead, so a host claiming 99 GB spare
  // is still held to what it can actually hold.
  assert.equal(workerCeilingFromTotalRam(MAC_36GB), 3);
  assert.equal(workersHostCanRun({ availableMb: 99_999, alreadyRunning: 3, totalMb: MAC_36GB }), 3);
});

test("a host with nothing spare keeps the workers it already has", () => {
  assert.equal(workersHostCanRun({ availableMb: 1_000, alreadyRunning: 2, totalMb: MAC_36GB }), 2);
});

test("a roomy host is not capped below what it can hold", () => {
  // 128 GB of RAM with 64 GB going spare: the dynamic estimate binds at 11, under a ceiling of 20.
  assert.equal(workersHostCanRun({ availableMb: 65_536, alreadyRunning: 0, totalMb: 131_072 }), 11);
  assert.equal(workerCeilingFromTotalRam(131_072), 20);
});

test("at least one worker always runs, even on a host with no memory at all", () => {
  // Refusing to start the only guest turns a tight host into an outage.
  assert.equal(workersHostCanRun({ availableMb: 0, alreadyRunning: 0, totalMb: MAC_36GB }), 1);
  // Including a host too small to clear the reserve at all, where the ceiling itself goes negative.
  assert.equal(workersHostCanRun({ availableMb: 8_000, alreadyRunning: 1, totalMb: 8_192 }), 1);
});

test("an unreadable host memory figure does not constrain the run", () => {
  // A diagnostic that cannot read the host must never be the thing that shrinks the pool.
  assert.equal(
    workersHostCanRun({ availableMb: null, alreadyRunning: 3, totalMb: MAC_36GB }),
    Number.POSITIVE_INFINITY,
  );
});

test("a capped pool explains itself, naming the numbers and the override", () => {
  const reason = capacityReason({ limit: 2, wanted: 3, availableMb: 12_654 });
  assert.match(reason!, /2 of 3 local workers/);
  assert.match(reason!, /12654 MB available/);
  assert.match(reason!, /A11Y_MAX_WORKERS/);
});

test("a pool that was not capped says nothing", () => {
  assert.equal(capacityReason({ limit: 3, wanted: 3, availableMb: 40_000 }), null);
  assert.equal(capacityReason({ limit: Number.POSITIVE_INFINITY, wanted: 3, availableMb: null }), null);
});
