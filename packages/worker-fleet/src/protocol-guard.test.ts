/**
 * The deploy guard that stops a CAPTURE_PROTOCOL_VERSION change invalidating 2,122 captures unnoticed.
 *
 * It exists because the guard that WAS written reached only `worker:deploy` — `utmctl file push` against a
 * VM UUID, which cannot reach a bare-metal worker and fails off macOS. Every box in `inventory.yml` is bare
 * metal, so the one live deploy path was the unguarded one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { protocolVerdict } from "./protocol-guard.mjs";

const fleet = (...protocols: (number | null)[]) =>
  protocols.map((protocol, i) => ({ worker: `w${i + 1}`, protocol }));

test("a fleet already serving this protocol deploys silently", () => {
  const v = protocolVerdict({ local: 6, served: fleet(6, 6, 6), allowed: false });
  assert.equal(v.refuse, false);
  assert.equal(v.message, "", "the common case must add no noise to a deploy log");
});

test("A CHANGE IS REFUSED, and the refusal names every box and the cost", () => {
  const v = protocolVerdict({ local: 7, served: fleet(6, 6), allowed: false });
  assert.equal(v.refuse, true);
  assert.match(v.message, /w1 serves 6/);
  assert.match(v.message, /w2 serves 6/);
  assert.match(v.message, /full recapture/, "a refusal that does not state the cost gets overridden blindly");
  assert.match(v.message, /--allow-protocol-change/, "and it must say how to proceed deliberately");
});

test("--allow-protocol-change PROCEEDS AND SAYS WHAT IT DID, rather than passing quietly", () => {
  const v = protocolVerdict({ local: 7, served: fleet(6, 6), allowed: true });
  assert.equal(v.refuse, false);
  assert.match(v.message, /Every cached capture becomes invalid/,
    "an override that prints nothing is indistinguishable from a guard that never ran");
});

test("ONE BOX BEHIND IS ENOUGH — a partial fleet is a SPLIT corpus, not a rounding error", () => {
  // A single guest on a different protocol produces cache entries under a key its peers cannot share, and
  // the corpus then holds two populations at once. That happened here with MAX_TAB_STOPS: every gate was
  // green and reading the corpus meant bucketing captures by whether they carried a diagnostic mark.
  const v = protocolVerdict({ local: 6, served: fleet(6, 6, 5), allowed: false });
  assert.equal(v.refuse, true);
  assert.match(v.message, /w3 serves 5/);
});

test("NOBODY ANSWERED IS NOT AGREEMENT — the examined-nothing rule", () => {
  // `evidence:check` exited 0 reporting "evidence unchanged — safe to ship" having compared 2 of 48,
  // because its guard covered only `compared === 0`. A guard whose subject is entirely absent must refuse.
  const v = protocolVerdict({ local: 6, served: fleet(null, null), allowed: false });
  assert.equal(v.refuse, true);
  assert.match(v.message, /no worker answered/);
  assert.match(v.message, /fleet:status/, "and it must name the command that says why");
});

test("an unreachable box does not veto a fleet that otherwise agrees", () => {
  // The opposite failure: refusing to deploy while a box is down would make deploy impossible during an
  // outage, and deploy is the remedy for most outages. Reachable workers decide; silence abstains.
  const v = protocolVerdict({ local: 6, served: fleet(6, null, 6), allowed: false });
  assert.equal(v.refuse, false);
});

test("AN UNREADABLE LOCAL VERSION IS A BROKEN GUARD, and says so instead of allowing", () => {
  // If the regex stops matching — capture-core moves, the constant is renamed — the guard silently stops
  // guarding. That is the shape `protocolBumpNote` already warns about for its own git lookup.
  const v = protocolVerdict({ local: null, served: fleet(6), allowed: false });
  assert.equal(v.refuse, true);
  assert.match(v.message, /broken guard, not a clean one/);
});

test("a string protocol from an older worker compares equal to the number", () => {
  // JSON gives what the worker sent. `6` and `"6"` are the same protocol and must not read as a change.
  assert.equal(protocolVerdict({ local: 6, served: [{ worker: "w", protocol: "6" }], allowed: false }).refuse,
    false);
});

/**
 * DISCOVERY: every path that SHIPS worker code must consult the guard.
 *
 * The reason this is a test rather than a comment: the guard WAS written, in `deploy-worker.mjs`, and that
 * script is `utmctl file push` keyed on a VM UUID — it cannot reach a bare-metal worker and exits
 * immediately off macOS. Every box in `inventory.yml` is bare metal. So for as long as the fleet has been
 * real, the guarded path was the dead one and the live path had no check at all.
 *
 * SHIPPING is the test, not MENTIONING. The first classifier matched any file naming `deploy.yml` and
 * flagged four that only quote it in advice strings — `worker-code-check` telling you to run
 * `fleet:deploy`, `fleet-env` explaining why `worker:deploy` cannot reach a physical box. That is the
 * "expectations derived from source TEXT" defect, which this repo has recorded twice: a regex scrape that
 * matched nothing and asserted over an empty set, and a `sweepLog` guard that read a shape nobody
 * verified. Comments are stripped, and the signature is the ACT of deploying.
 */
function deployClients(): { file: string; guarded: boolean }[] {
  const root = resolve(import.meta.dirname, "../../..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return execFileSync("git", ["ls-files", "packages"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|mjs)$/.test(f) && !f.includes(".test.") && !f.includes("/dist/"))
    .map((file) => ({ file, source: strip(readFileSync(resolve(root, file), "utf8")) }))
    // Two real shapes, and both must be here: Ansible running deploy.yml (bare metal, the live path) and
    // `utmctl file push` of WORKER_FILES (the UTM path, deprecated but still present).
    .filter(({ source }) => (source.includes("ansible-playbook") && source.includes("deploy.yml"))
      || (/"file",\s*"push"/.test(source) && source.includes("WORKER_FILES")))
        // THE CALL, not the name and not the import — and both refinements came from mutation, neither from
    // reading. A bare substring let `protocolVerdictXX` pass, because it contains `protocolVerdict`. Then
    // a word boundary still let a DELETED guard pass, because the `import` line survived the deletion and
    // matched. An import is not a guard. A test that cannot see its own subject being disabled is the
    // `refreshBrowseBuffer` defect one level out: green, and vouching for nothing.
    .map(({ file, source }) => ({ file,
      guarded: /\bprotocolVerdict\s*\(/.test(source) || /--allow-protocol-change/.test(source) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

test("DISCOVERY: every path that ships worker code guards CAPTURE_PROTOCOL_VERSION", () => {
  const clients = deployClients();
  assert.ok(clients.length >= 2, "the discovery found fewer than the two known deploy clients, so its "
    + `classifier has stopped matching and it is examining nothing: ${JSON.stringify(clients)}`);
  assert.deepEqual(clients.filter((c) => !c.guarded).map((c) => c.file), [],
    "a path that ships worker code must check CAPTURE_PROTOCOL_VERSION against what the fleet serves — "
    + "shipping a change to it invalidates every cached capture");
});

test("BOTH deploy paths are found, so neither can go unguarded unnoticed", () => {
  // Named explicitly because the lesson was that ONE of them was guarded and it was the dead one. A
  // classifier that silently stopped matching the live path would make this file pass having checked half.
  const found = deployClients().map((c) => c.file);
  assert.ok(found.includes("packages/control/src/fleet-playbook.mjs"),
    `the bare-metal path (the only live one) must be discovered; found ${JSON.stringify(found)}`);
  assert.ok(found.includes("packages/worker-fleet/src/deploy-worker.mjs"),
    `the UTM path must be discovered; found ${JSON.stringify(found)}`);
});
