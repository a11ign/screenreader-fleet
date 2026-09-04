/**
 * THE EDGE PIN EXISTS IN TWO PLACES, AND THEY MUST NOT DRIFT.
 *
 * `roles/worker/tasks/edge-version.yml` is the tested copy and the one `provisionRevision` hashes.
 * `bootstrap-windows-worker.ps1` now carries a port of it, because a pin that arrives after the box has
 * updated itself is not a pin — which is what happened to a11y-worker-7 on 2026-09-04. Nothing in first
 * boot mentioned Edge; the box came up with a network, Edge updated itself to 152 while `npm install` was
 * still running, and the role then refused correctly: Chromium will not install over a newer build and
 * Windows will not let Edge be uninstalled. One box reimaged.
 *
 * A fact stated twice is this repo's most-repeated defect, and the remedies in order of preference are:
 * delete a copy, derive one from the other, or PIN THEM EQUAL. The first two are unavailable — the
 * bootstrap runs on a box with no Ansible, before the fleet can reach it, and reading `defaults/main.yml`
 * would mean a YAML parser in PowerShell at first boot. So: pinned equal, here.
 *
 * The VERSION is what must match. The prose need not, and deliberately so — the role explains itself to an
 * operator reading a playbook, the bootstrap to one reading a console.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const DEFAULTS = readFileSync(resolve(REPO, "packages/control/ansible/roles/worker/defaults/main.yml"), "utf8");
const BOOTSTRAP = readFileSync(
  resolve(REPO, "packages/worker-fleet/src/provisioning/bootstrap-windows-worker.ps1"), "utf8");

const fromRole = (key: string) =>
  new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "m").exec(DEFAULTS)?.[1]?.trim();

test("the bootstrap pins the SAME Edge build the role does", () => {
  const version = fromRole("worker_edge_version");
  assert.ok(version, "worker_edge_version is gone from the role defaults — this test examines nothing");
  assert.ok(BOOTSTRAP.includes(version),
    `the role pins Edge ${version} and the bootstrap does not mention it. A box built from the bootstrap `
    + "would come up on a different build from the fleet, and `browserVersion` is FIRST in "
    + "`fleet-consistency`'s MUST_MATCH — so every capture run would refuse to start, on all boxes.");
});

test("the bootstrap fetches the SAME MSI, verified by the SAME hash", () => {
  // The URL is a delivery endpoint: what it serves can change under a stable address, so the hash is the
  // real pin and a copy that checks a different one is not checking anything.
  for (const key of ["worker_edge_msi_url", "worker_edge_msi_sha256"]) {
    const value = fromRole(key);
    assert.ok(value, `${key} is gone from the role defaults`);
    assert.ok(BOOTSTRAP.includes(value),
      `${key} differs between the role and the bootstrap — they would install different bytes`);
  }
});

test("the bootstrap stops the updater BEFORE installing, and by PREFIX", () => {
  // Both are load-bearing and both were learned the hard way. Order: a live updater finishes the update it
  // had started, in the window between installing and believing it. Prefix: a fresh guest carried a third
  // task, `MicrosoftEdgeUpdateBrowserReplacementTask`, that an enumerated list could not see.
  assert.match(BOOTSTRAP, /MicrosoftEdgeUpdate\*/,
    "the bootstrap enumerates updater tasks by NAME; it must match the prefix, or it cannot see a task "
    + "nobody listed — which is the one that replaced the browser");
  const disableAt = BOOTSTRAP.search(/Disable-ScheduledTask/);
  // ANCHORED ON THE EDGE INSTALL, not on `msiexec` — step 2 installs Node with msiexec too, so the first
  // version of this assertion measured that one and reported the order backwards. A test matching the
  // wrong occurrence of a common token is the same defect it is here to catch, one layer out.
  const installAt = BOOTSTRAP.search(/'install pinned Edge'/);
  assert.ok(disableAt > 0 && installAt > 0, "the bootstrap no longer disables the updater or installs Edge");
  assert.ok(disableAt < installAt,
    "the bootstrap installs Edge BEFORE disabling the updater. That leaves a live updater to finish the "
    + "update it had already begun — the drift the pin exists to prevent, arriving in the gap.");
  assert.match(BOOTSTRAP, /Stop-ScheduledTask[\s\S]{0,400}Disable-ScheduledTask/,
    "`Disable-ScheduledTask` stops a task STARTING again; it does not terminate one already RUNNING. Stop "
    + "before disable, or a running updater is marked disabled and carries on.");
});

test("the bootstrap completes the RENAME, which the installer does not", () => {
  // A Chromium install stages `new_msedge.exe` and leaves the running `msedge.exe` alone; the rename is a
  // separate operation the updater performs later — and the updater has just been disabled. Measured on
  // a11y-worker-3: the install reported success, left the old build, and a full reboot did not finish it.
  assert.match(BOOTSTRAP, /--rename-chrome-exe/,
    "without the rename the install reports success and leaves the OLD build in place, which is the "
    + "failure that looks most like the pin working");
});

test("it REFUSES a box already newer than the pin, rather than trying", () => {
  // The one outcome that cannot be repaired in place, so it must be said at first boot where reimaging is
  // still cheap — not after provisioning, which is when a11y-worker-7 found out.
  assert.match(BOOTSTRAP, /NEWER than the pin/,
    "the bootstrap does not detect an Edge newer than the pin. Chromium will not install over a newer "
    + "build and Windows will not let Edge be uninstalled, so a silent attempt reports success and leaves "
    + "the box unfit for the fleet.");
});
