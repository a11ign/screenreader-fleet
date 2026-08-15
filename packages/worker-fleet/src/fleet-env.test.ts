// The inventory is the one place a machine is added, so this reader is the one place that can silently
// lose one. A short fleet list is invisible — a run with eight workers looks exactly like a run with eight
// workers — which is why every test below is about REFUSING rather than parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  workersFromInventory, portFromGroupVars, DEFAULT_WORKER_PORT, configuredWorkers,
} from "./fleet-env.mjs";

test("hosts become worker URLs on the declared port", () => {
  const workers = workersFromInventory([
    "all:", "  children:", "    a11y_workers:", "      hosts:",
    "        a11y-worker-1:", "          ansible_host: REDACTED-INTERNAL-ADDRESS",
    "        a11y-worker-2:", "          ansible_host: REDACTED-INTERNAL-ADDRESS",
  ].join("\n"), { port: 8765 });

  assert.deepEqual(workers, ["http://REDACTED-INTERNAL-ADDRESS:8765", "http://REDACTED-INTERNAL-ADDRESS:8765"]);
});

test("a commented-out machine is not in the fleet", () => {
  // Commenting a box out is how you take it out of rotation for a week. It must not come back because a
  // regex was hungry.
  const workers = workersFromInventory([
    "        a11y-worker-1:", "          ansible_host: REDACTED-INTERNAL-ADDRESS",
    "        # a11y-worker-2:", "        #   ansible_host: REDACTED-INTERNAL-ADDRESS",
  ].join("\n"));

  assert.deepEqual(workers, [`http://REDACTED-INTERNAL-ADDRESS:${DEFAULT_WORKER_PORT}`]);
});

test("a host entry this reader does not understand is an ERROR, not a silent omission", () => {
  // The whole point. Losing a machine here means it is provisioned, updated, and never dispatched to —
  // and nothing reports a worker it does not know exists.
  assert.throws(
    () => workersFromInventory("          ansible_host: [REDACTED-INTERNAL-ADDRESS, REDACTED-INTERNAL-ADDRESS]"),
    /looks like a host entry but does not parse/);
});

test("an inventory with no hosts is refused rather than returning an empty fleet", () => {
  // An empty A11Y_WORKERS makes the orchestrator fall back to looking for local UTM VMs, which on the
  // Linux control plane do not exist — so the failure would surface as something unrelated.
  assert.throws(() => workersFromInventory("all:\n  children:\n    a11y_workers:\n      hosts:\n"),
    /no hosts found/);
});

test("quoted addresses are accepted, because YAML allows them", () => {
  assert.deepEqual(workersFromInventory('          ansible_host: "REDACTED-INTERNAL-ADDRESS"', { port: 1 }),
    ["http://REDACTED-INTERNAL-ADDRESS:1"]);
});

test("the port comes from the group vars, not from a second copy in here", () => {
  assert.equal(portFromGroupVars("a11y_port: 9999\n"), 9999);
  assert.equal(portFromGroupVars("nothing here\n"), DEFAULT_WORKER_PORT);
});

test("the REAL inventory in this repo parses, and agrees with the real group vars", () => {
  // The fixtures above prove the reader's rules; this proves the shipped files obey them. A reader that
  // only ever runs against its own fixtures is a reader that has never met the file it exists to read.
  const inventory = readFileSync(fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url)), "utf8");
  const groupVars = readFileSync(
    fileURLToPath(new URL("../ansible/group_vars/a11y_workers.yml", import.meta.url)), "utf8");

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
  withEnv({ A11Y_WORKERS: "http://REDACTED-INTERNAL-ADDRESS:8765", A11Y_WORKER: undefined }, () => {
    assert.equal(configuredWorkers()[0].name, "REDACTED-INTERNAL-ADDRESS:8765");
  });
});
