// The inventory is the one place a machine is added, so this reader is the one place that can silently
// lose one. A short fleet list is invisible — a run with eight workers looks exactly like a run with eight
// workers — which is why every test below is about REFUSING rather than parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  workersFromInventory, portFromGroupVars, DEFAULT_WORKER_PORT, configuredWorkers, namedInventoryWorkers } from "./fleet-env.mjs";

test("hosts become worker URLs on the declared port", () => {
  const workers = workersFromInventory([
    "all:", "  children:", "    a11y_workers:", "      hosts:",
    "        a11y-worker-1:", "          ansible_host: 203.0.113.83",
    "        a11y-worker-2:", "          ansible_host: REDACTED-INTERNAL-ADDRESS",
  ].join("\n"), { port: 8765 });

  assert.deepEqual(workers, ["http://203.0.113.83:8765", "http://REDACTED-INTERNAL-ADDRESS:8765"]);
});

test("a commented-out machine is not in the fleet", () => {
  // Commenting a box out is how you take it out of rotation for a week. It must not come back because a
  // regex was hungry.
  const workers = workersFromInventory([
    "all:", "  children:", "    a11y_workers:", "      hosts:",
    "        a11y-worker-1:", "          ansible_host: 203.0.113.83",
    "        # a11y-worker-2:", "        #   ansible_host: REDACTED-INTERNAL-ADDRESS",
  ].join("\n"));

  assert.deepEqual(workers, [`http://203.0.113.83:${DEFAULT_WORKER_PORT}`]);
});

test("a host entry this reader does not understand is an ERROR, not a silent omission", () => {
  // The whole point. Losing a machine here means it is provisioned, updated, and never dispatched to —
  // and nothing reports a worker it does not know exists.
  assert.throws(
    () => workersFromInventory("          ansible_host: [203.0.113.83, REDACTED-INTERNAL-ADDRESS]"),
    /looks like a host entry but does not parse/);
});

test("an inventory with no hosts is refused rather than returning an empty fleet", () => {
  // An empty A11Y_WORKERS makes the orchestrator fall back to looking for local UTM VMs, which on the
  // Linux control plane do not exist — so the failure would surface as something unrelated.
  assert.throws(() => workersFromInventory("all:\n  children:\n    a11y_workers:\n      hosts:\n"),
    /no hosts found/);
});

test("quoted addresses are accepted, because YAML allows them", () => {
  assert.deepEqual(workersFromInventory([
    "all:", "  children:", "    a11y_workers:", "      hosts:",
    "        a11y-worker-1:", '          ansible_host: "203.0.113.83"',
  ].join("\n"), { port: 1 }), ["http://203.0.113.83:1"]);
});

test("the port comes from the group vars, not from a second copy in here", () => {
  assert.equal(portFromGroupVars("a11y_port: 9999\n"), 9999);
  assert.equal(portFromGroupVars("nothing here\n"), DEFAULT_WORKER_PORT);
});

// Reads inventory.example.yml, deliberately -- the REAL inventory.yml is gitignored (real addresses,
// restored from the secrets store at bring-up) and does not exist in CI or a fresh clone.
// inventory-example-parity.test.ts is what proves the example stays equivalent to the real file for this
// purpose; do not re-point this at inventory.yml, or it will pass locally and fail everywhere else.
test("the EXAMPLE inventory parses, and agrees with the real group vars", () => {
  // The fixtures above prove the reader's rules; this proves a real, committed file obeys them. A reader
  // that only ever runs against its own fixtures is a reader that has never met a file shaped like the one
  // it exists to read.
  const inventory = readFileSync(fileURLToPath(new URL("../../control/ansible/inventory.example.yml", import.meta.url)), "utf8");
  const groupVars = readFileSync(
    fileURLToPath(new URL("../../control/ansible/group_vars/a11y_workers.yml", import.meta.url)), "utf8");

  const workers = workersFromInventory(inventory, { port: portFromGroupVars(groupVars) });
  assert.ok(workers.length >= 1, "the shipped inventory should list at least the first bare-metal worker");
  for (const url of workers) assert.match(url, /^http:\/\/[\d.]+:\d+$/);
});

// `configuredWorkers` replaced three parsers that disagreed. The precedence test is the one that matters:
// doctor preferred A11Y_WORKERS and check-worker-code preferred A11Y_WORKER, so with both set the two
// commands described DIFFERENT MACHINES — and "doctor is happy" / "a worker is stale" could be true
// statements about disjoint sets, with nothing anywhere to say so.

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const saved = { A11Y_WORKER: process.env.A11Y_WORKER, A11Y_WORKERS: process.env.A11Y_WORKERS };
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("A11Y_WORKERS wins over A11Y_WORKER, so every command describes the same fleet", () => {
  withEnv({ A11Y_WORKERS: "http://REDACTED-INTERNAL-ADDRESS:8765,http://REDACTED-INTERNAL-ADDRESS:8765", A11Y_WORKER: "http://REDACTED-INTERNAL-ADDRESS:8765" }, () => {
    assert.deepEqual(configuredWorkers().map((w) => w.url),
      ["http://REDACTED-INTERNAL-ADDRESS:8765", "http://REDACTED-INTERNAL-ADDRESS:8765"],
      "the plural names the pool a run dispatches across; a diagnostic about a different set is worse "
      + "than no diagnostic");
  });
});

test("the singular is still honoured when it is the only one set", () => {
  withEnv({ A11Y_WORKERS: undefined, A11Y_WORKER: "http://REDACTED-INTERNAL-ADDRESS:8765" }, () => {
    assert.deepEqual(configuredWorkers().map((w) => w.url), ["http://REDACTED-INTERNAL-ADDRESS:8765"]);
  });
});

test("entries are trimmed and de-slashed", () => {
  // `A11Y_WORKERS=a, b` otherwise yields a URL with a leading space, which fails to parse and reports as
  // an unreachable worker — a configuration typo wearing a dead-machine costume.
  withEnv({ A11Y_WORKERS: "http://REDACTED-INTERNAL-ADDRESS:8765/, http://REDACTED-INTERNAL-ADDRESS:8765 ,", A11Y_WORKER: undefined }, () => {
    assert.deepEqual(configuredWorkers().map((w) => w.url),
      ["http://REDACTED-INTERNAL-ADDRESS:8765", "http://REDACTED-INTERNAL-ADDRESS:8765"]);
  });
});

test("nothing set is an empty list, not null — 'no worker named' is a normal state", () => {
  withEnv({ A11Y_WORKERS: undefined, A11Y_WORKER: undefined }, () => {
    assert.deepEqual(configuredWorkers(), []);
  });
});

test("the name is the host, for a readable per-worker report", () => {
  withEnv({ A11Y_WORKERS: "http://203.0.113.83:8765", A11Y_WORKER: undefined }, () => {
    assert.equal(configuredWorkers()[0].name, "203.0.113.83:8765");
  });
});

// ---------------------------------------------------------------------------------------------------
// Group awareness. This reader was groupless until 2026-08-21, which meant `inventory.yml` could only
// ever describe capture workers: adding the lab container to it would have put `http://<lab>:8765` into
// `A11Y_WORKERS` and a run would have dispatched capture cases to a box with no NVDA on it. Nothing
// would have said so — `fleet:status` would just have shown one unreachable "worker".

test("a host in another group is NOT a capture worker", () => {
  // The whole reason for this change: the lab and control containers belong in the inventory (one source
  // of truth for what exists) without becoming things a run dispatches to.
  const workers = workersFromInventory([
    "all:", "  children:", "    a11y_workers:", "      hosts:",
    "        a11y-worker-2:", "          ansible_host: 203.0.113.107",
    "    a11y_lab:", "      hosts:",
    "        a11y-lab:", "          ansible_host: 203.0.113.79",
  ].join("\n"), { port: 8765 });

  assert.deepEqual(workers, ["http://203.0.113.107:8765"]);
});

test("group order does not matter — a non-worker group FIRST must not leak", () => {
  // Ordering is exactly the kind of thing a reformat changes, and a reader that only works when the
  // worker group comes first is one that breaks silently on somebody else's tidy-up.
  const workers = workersFromInventory([
    "all:", "  children:", "    a11y_lab:", "      hosts:",
    "        a11y-lab:", "          ansible_host: 203.0.113.79",
    "    a11y_workers:", "      hosts:",
    "        a11y-worker-2:", "          ansible_host: 203.0.113.107",
  ].join("\n"), { port: 8765 });

  assert.deepEqual(workers, ["http://203.0.113.107:8765"]);
});

test("a host in no group at all is an ERROR, not a guess", () => {
  // Including it recreates the phantom worker; dropping it silently shortens the fleet. Both are
  // invisible, so neither is a safe default.
  assert.throws(
    () => workersFromInventory("        a11y-worker-1:\n          ansible_host: 203.0.113.83"),
    /declares a host outside any group/);
});

test("host vars other than the address do not disturb the group", () => {
  // `mac:` sits at the same indentation as `ansible_host:`, so a path tracker that mishandled leaves
  // would lose the group and reject a perfectly good worker.
  const workers = workersFromInventory([
    "all:", "  children:", "    a11y_workers:", "      hosts:",
    "        a11y-worker-2:", '          mac: "e8:6a:64:e2:3c:8d"',
    "          ansible_host: 203.0.113.107",
  ].join("\n"), { port: 8765 });

  assert.deepEqual(workers, ["http://203.0.113.107:8765"]);
});

test("indentation width is not assumed", () => {
  // The real file uses two spaces per level; a reader that hardcoded that would break on a reformat and
  // report a short fleet, which is the failure mode this module is built to refuse.
  const workers = workersFromInventory([
    "all:", "    children:", "        a11y_workers:", "            hosts:",
    "                a11y-worker-2:", "                    ansible_host: 203.0.113.107",
  ].join("\n"), { port: 8765 });

  assert.deepEqual(workers, ["http://203.0.113.107:8765"]);
});

test("asking for a group that has no hosts is refused, naming the group", () => {
  assert.throws(() => workersFromInventory([
    "all:", "  children:", "    a11y_workers:", "      hosts:",
    "        a11y-worker-2:", "          ansible_host: 203.0.113.107",
  ].join("\n"), { group: "a11y_lab" }), /no hosts found under a11y_lab\.hosts/);
});

// ---------------------------------------------------------------------------------------------------
// The ENV route into the same defect the `--worker=` clients now refuse. `A11Y_WORKERS=http://:8765`
// used to pass straight through here into `doctor`, `worker:code`, `fleet:status` and the dataset
// runner — each of which would then report a machine that cannot be addressed as one that is merely
// not answering, which is the single most misleading thing this fleet tooling can say.

test("a malformed entry in A11Y_WORKERS is refused, naming the variable", () => {
  const original = process.env.A11Y_WORKERS;
  try {
    process.env.A11Y_WORKERS = "http://:8765";
    assert.throws(() => configuredWorkers(), /A11Y_WORKERS=http:\/\/:8765/);
  } finally {
    if (original === undefined) delete process.env.A11Y_WORKERS;
    else process.env.A11Y_WORKERS = original;
  }
});

test("one bad entry fails the whole list, rather than silently shortening the fleet", () => {
  // Fail closed. A pool of one where two were named looks exactly like a pool of one, which is this
  // module's founding complaint.
  const original = process.env.A11Y_WORKERS;
  try {
    process.env.A11Y_WORKERS = "http://good:8765,http://:8765";
    assert.throws(() => configuredWorkers(), /is not a URL/);
  } finally {
    if (original === undefined) delete process.env.A11Y_WORKERS;
    else process.env.A11Y_WORKERS = original;
  }
});

test("validation does NOT disturb the empty case, which is a normal state", () => {
  // "No worker was named" means "find the local VMs" and every caller branches on emptiness. Turning
  // that into a throw would break the default path for every developer on a Mac.
  const workers = process.env.A11Y_WORKERS;
  const worker = process.env.A11Y_WORKER;
  try {
    delete process.env.A11Y_WORKERS;
    delete process.env.A11Y_WORKER;
    assert.deepEqual(configuredWorkers(), []);
    process.env.A11Y_WORKERS = "";
    assert.deepEqual(configuredWorkers(), []);
    process.env.A11Y_WORKERS = " , ";
    assert.deepEqual(configuredWorkers(), []);
  } finally {
    if (workers === undefined) delete process.env.A11Y_WORKERS; else process.env.A11Y_WORKERS = workers;
    if (worker === undefined) delete process.env.A11Y_WORKER; else process.env.A11Y_WORKER = worker;
  }
});

test("THE INVENTORY IS A FLEET DOCTOR CAN SEE, and it is named", () => {
  // `doctor` resolved A11Y_WORKERS, then the local UTM pool, then gave up — so on a Mac with any
  // registered VM it reported the DEPRECATED local guests and never inventory.yml. Measured on one
  // machine at one moment: doctor said "2 worker(s), all stopped — READY" while `worker:code` said
  // "checking 5 worker(s) from inventory.yml" and `fleet:status` showed those five BUSY with a corpus
  // run. Its next_command was `training:capture`, which would have captured on the wrong machines.
  //
  // Named, not numbered: `fleet-status.mjs` records what an address-only report cost — ".224 is
  // a11y-worker-FIVE, so `fleet:sleep --limit=a11y-worker-4` put a healthy machine to sleep and left the
  // drifted one serving".
  //
  // inventory.example.yml, not the real inventory.yml -- the real one is gitignored (real addresses,
  // restored from the secrets store at bring-up) and this checkout would otherwise need it just to run
  // `npm test`. `inventory-example-parity.test.ts` is what keeps the example's shape (and therefore this
  // test's premise) honest.
  const workers = namedInventoryWorkers({
    inventoryPath: fileURLToPath(new URL("../../control/ansible/inventory.example.yml", import.meta.url)),
  });
  assert.ok(workers.length > 0, "this checkout declares a bare-metal fleet; the reader must find it");
  for (const { name, url } of workers) {
    assert.match(url, /^https?:\/\/[^/]+:\d+$/, "every entry is a usable worker address");
    assert.doesNotMatch(name, /^https?:\/\//,
      "a name is a name — an address here means the inventory pairing was lost");
    assert.doesNotMatch(name, /^inventory-\d+$/, "a positional label cannot be matched to a --limit flag");
  }
});

test("and it answers EMPTY rather than throwing when no inventory is declared", () => {
  // A checkout with no fleet is supported, and a hint must not fail the command it is advising.
  assert.ok(Array.isArray(namedInventoryWorkers()));
});
