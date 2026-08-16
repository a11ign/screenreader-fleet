// Enrolment writes to the file that DEFINES the fleet, so the properties that make that safe are asserted
// here rather than trusted: it only ever appends, it never touches a declared machine, and it refuses to
// add a box that is really one the inventory already has at another address. Get any of those wrong and
// the failure is the quiet kind -- a machine that stops being maintained, or one listed twice.
import { test } from "node:test";
import assert from "node:assert/strict";

import { enrol, enrolmentBlock, inventoryHosts, nextWorkerName } from "./fleet-discover.mjs";

const INVENTORY = `all:
  children:
    a11y_workers:
      hosts:
        a11y-worker-1:
          # A comment that has to survive, because every one of them was paid for by an incident.
          ansible_host: REDACTED-INTERNAL-ADDRESS
          mac: "00:80:64:da:18:e9"
`;

const HEALTH = {
  environment: { screenReaderVersion: "2026.1.1", windowsVersion: "Microsoft Windows 11 Pro 10.0.22631", architecture: "x64" },
};

const worker = (ip: string, mac: string | null) => ({ ip, mac, health: HEALTH });

test("an unknown worker is appended, and the existing entry is untouched", () => {
  const { text, added } = enrol(INVENTORY, [worker("REDACTED-INTERNAL-ADDRESS", "e8:6a:64:e2:3c:8d")], "2026-08-16");

  assert.equal(added.length, 1);
  assert.equal(added[0].name, "a11y-worker-2");
  // The whole safety argument: everything that was there before is still there, byte for byte.
  assert.ok(text.startsWith(INVENTORY), "existing inventory must be a literal prefix of the result");
  assert.match(text, /a11y-worker-2:/);
  assert.match(text, /ansible_host: 192\.168\.1\.107/);
  assert.match(text, /mac: "e8:6a:64:e2:3c:8d"/);
});

test("the appended entry parses back as a host", () => {
  // Writing YAML by string concatenation is only acceptable if the file's own reader still sees it.
  const { text } = enrol(INVENTORY, [worker("REDACTED-INTERNAL-ADDRESS", "e8:6a:64:e2:3c:8d")], "2026-08-16");
  const hosts = inventoryHosts(text);

  assert.deepEqual(hosts.map((h) => h.name), ["a11y-worker-1", "a11y-worker-2"]);
  assert.equal(hosts[1].host, "REDACTED-INTERNAL-ADDRESS");
  assert.equal(hosts[1].mac, "e8:6a:64:e2:3c:8d");
});

test("comments in the existing file survive", () => {
  const { text } = enrol(INVENTORY, [worker("REDACTED-INTERNAL-ADDRESS", "e8:6a:64:e2:3c:8d")], "2026-08-16");
  assert.match(text, /every one of them was paid for by an incident/);
});

test("a MAC the inventory already declares is skipped, not added a second time", () => {
  // This is a MOVE. Appending would put one machine in the file twice under two names.
  const { text, added, skipped } = enrol(INVENTORY, [worker("REDACTED-INTERNAL-ADDRESS", "00:80:64:da:18:e9")], "2026-08-16");

  assert.deepEqual(added, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].ip, "REDACTED-INTERNAL-ADDRESS");
  assert.equal(text, INVENTORY, "nothing may be written when there is nothing to add");
});

test("enrolling twice is idempotent", () => {
  const once = enrol(INVENTORY, [worker("REDACTED-INTERNAL-ADDRESS", "e8:6a:64:e2:3c:8d")], "2026-08-16");
  const twice = enrol(once.text, [worker("REDACTED-INTERNAL-ADDRESS", "e8:6a:64:e2:3c:8d")], "2026-08-16");

  assert.deepEqual(twice.added, []);
  assert.equal(twice.text, once.text);
});

test("several unknowns in one run get sequential names", () => {
  const { added } = enrol(
    INVENTORY,
    [worker("REDACTED-INTERNAL-ADDRESS", "aa:bb:cc:dd:ee:01"), worker("REDACTED-INTERNAL-ADDRESS", "aa:bb:cc:dd:ee:02")],
    "2026-08-16",
  );
  assert.deepEqual(added.map((e) => e.name), ["a11y-worker-2", "a11y-worker-3"]);
});

test("a worker with no MAC is still enrolled, and says so where a human will see it", () => {
  // inventory.yml's own comment: a worker with no mac is SKIPPED AND NAMED by wake.yml. The gap is
  // already loud, so recording the machine beats leaving a real box in no file at all.
  const { text, added } = enrol(INVENTORY, [worker("REDACTED-INTERNAL-ADDRESS", null)], "2026-08-16");

  assert.equal(added.length, 1);
  assert.equal(added[0].mac, null);
  assert.match(text, /NO mac/);
  assert.match(text, /Get-NetAdapter/);
  assert.doesNotMatch(text, /mac: "null"/);
});

test("names are never reused after a retirement", () => {
  // a11y-worker-2 retired; the next box must be 4, not 2. Reusing it makes every old reference wrong.
  assert.equal(nextWorkerName(["a11y-worker-1", "a11y-worker-3"]), "a11y-worker-4");
  assert.equal(nextWorkerName([]), "a11y-worker-1");
  assert.equal(nextWorkerName(["something-else"]), "a11y-worker-1");
});

test("the block records what the box was when it was enrolled", () => {
  const block = enrolmentBlock({
    name: "a11y-worker-2", ip: "REDACTED-INTERNAL-ADDRESS", mac: "e8:6a:64:e2:3c:8d", health: HEALTH, today: "2026-08-16",
  });
  assert.match(block, /2026-08-16/);
  assert.match(block, /NVDA 2026\.1\.1/);
  assert.match(block, /10\.0\.22631/);
  // Indented to the depth inventoryHosts requires; one space out and the host silently disappears.
  assert.match(block, /^ {8}a11y-worker-2:$/m);
});
