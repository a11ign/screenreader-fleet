/**
 * ONE PORT, DECLARED THREE TIMES, IN THREE LANGUAGES, WITH NOTHING COMPARING THEM.
 *
 *   packages/worker-fleet/src/fleet-env.mjs          DEFAULT_WORKER_PORT = 8765   what NODE asks on
 *   packages/control/ansible/group_vars/…yml         a11y_port: 8765              what the FLEET answers on
 *   packages/control/ansible/roles/worker/defaults/  worker_port: 8765            what the ROLE opens
 *
 * Raised by an external architecture audit as "a change to `worker_port` splits the role from every other
 * consumer silently". Checked here before acting, and the exposure is NARROWER than stated — which is
 * worth recording, because an overstated finding fixed as stated leaves the real one unaddressed.
 * `provision-role.yml` passes `worker_port: "{{ a11y_port }}"`, so through the play the role uses the
 * inventory's value and the two cannot disagree.
 *
 * WHAT IS ACTUALLY EXPOSED, and it is still worth a test:
 *
 * - The role's DEFAULT governs whenever the role runs standalone — `ansible.builtin.include_role` from
 *   anywhere that does not set it, which is every future caller that has not read `provision-role.yml`.
 *   It opens the firewall (`firewall.yml`) and verifies health (`verify.yml`) on that number.
 * - `DEFAULT_WORKER_PORT` is what node uses to build a worker URL when the inventory gives no port. So a
 *   drift means the fleet ANSWERS on one port and the host ASKS on another, and the symptom is every
 *   worker reading unreachable — which this repo has repeatedly and expensively misread as a dead machine
 *   rather than a configuration split.
 *
 * The copies cannot be deleted or derived: Ansible cannot import JavaScript, `packages/control` may take
 * no npm dependency (ADR 0012), and the role must stay usable standalone. That leaves CLAUDE.md's third
 * remedy for a fact stated twice — pin them equal — which is what `name-normalisation.test.ts` does across
 * the same kind of boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEFAULT_WORKER_PORT } from "./fleet-env.mjs";

const repo = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

/** A bare `key: 8765` at the top level of a vars file. Deliberately not a YAML parse: `packages/control`
 *  takes no dependencies, and a test that needed one to read its config would invert that boundary. */
function declaredPort(source: string, key: string): number | null {
  const found = new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m").exec(source);
  return found ? Number(found[1]) : null;
}

test("the fleet answers on the port node asks on", () => {
  const a11yPort = declaredPort(repo("packages/control/ansible/group_vars/a11y_workers.yml"), "a11y_port");
  assert.ok(a11yPort, "group_vars must declare `a11y_port`; the regex has drifted or the key was renamed");
  assert.equal(a11yPort, DEFAULT_WORKER_PORT,
    `the inventory answers on ${a11yPort} and DEFAULT_WORKER_PORT asks on ${DEFAULT_WORKER_PORT}. Every `
    + "worker would read unreachable, which this repo has repeatedly misdiagnosed as a dead machine.");
});

test("the role's standalone default matches, because it governs every caller that does not set it", () => {
  const workerPort = declaredPort(
    repo("packages/control/ansible/roles/worker/defaults/main.yml"), "worker_port");
  assert.ok(workerPort, "the worker role must declare `worker_port`");
  assert.equal(workerPort, DEFAULT_WORKER_PORT,
    `the role opens the firewall and verifies health on ${workerPort} when run standalone, and node asks `
    + `on ${DEFAULT_WORKER_PORT}. \`provision-role.yml\` overrides it, so this only bites a caller that `
    + "does not — which is every future one that has not read that play.");
});

test("the play still passes the inventory's port down, which is what makes the default a fallback", () => {
  // The wiring that narrows this finding. If it were ever removed, the role's default would silently
  // become authoritative for the real fleet too, and the two tests above would be the only thing
  // standing between a renamed port and a fleet nobody can reach.
  assert.match(repo("packages/control/ansible/provision-role.yml"),
    /worker_port:\s*"\{\{\s*a11y_port\s*\}\}"/,
    "provision-role.yml must pass the inventory's `a11y_port` into the role, or the role's default "
    + "governs the real fleet rather than acting as a standalone fallback");
});
