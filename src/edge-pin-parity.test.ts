// Relocated from control/src/fleet-layer/edge-pin-parity.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * THE BOOTSTRAP MUST STOP THE EDGE UPDATER BEFORE IT INSTALLS, AND COMPLETE WHAT THE INSTALLER LEAVES UNDONE.
 *
 * `bootstrap-windows-worker.ps1` carries a port of the Ansible role's Edge pin, because a pin that arrives
 * after the box has updated itself is not a pin -- which is what happened to a11y-worker-7 on 2026-09-04.
 * Nothing in first boot mentioned Edge; the box came up with a network, Edge updated itself to 152 while
 * `npm install` was still running, and the role then refused correctly: Chromium will not install over a
 * newer build. One box reimaged.
 *
 * These three tests read only the bootstrap, so they live with it. The tests that compare its pin with the
 * role's `defaults/main.yml` (version, MSI, hash, the declared lag) read the Ansible role and stay with the
 * role's owner.
 *
 * They assert on the SCRIPT'S TEXT because there is no Windows host here to run a first boot on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BOOTSTRAP = readFileSync(new URL("./provisioning/bootstrap-windows-worker.ps1", import.meta.url), "utf8");

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

test("it ROLLS BACK a box already newer than the pin, rather than stranding it", () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and its own failure message carried the reason: "Windows will
  // not let Edge be uninstalled". That is false. `ALLOWDOWNGRADE=1` is Microsoft's supported enterprise
  // rollback, and the role's refusal message has listed it as remedy (2) since it was corrected — the
  // bootstrap was ported from that message BEFORE the correction, and this test pinned the wrong half in
  // place. A test can hold a refuted belief steady just as well as a correct one.
  //
  // What made it matter: `browserVersion` is first in `fleet-consistency`'s MUST_MATCH, so a box that
  // loses the first-boot race — fresh Windows ships consumer Edge and it self-updates while `npm install`
  // is still running — could never join the fleet. And "follow the pin forward" is not always available:
  // measured 2026-09-04, one box came up at 152.0.4191.66 and the enterprise channel publishes no such
  // build, so the preferred remedy did not exist.
  assert.match(BOOTSTRAP, /\$rollingBack\s*=\s*\$have -ne '\(absent\)' -and \[version\]\$have -gt \[version\]\$EdgeVersion/,
    "the bootstrap no longer detects an Edge newer than the pin by comparing VERSIONS. A string compare "
    + "would read 152.0.4191.9 as newer than 152.0.4191.62.");
  // A BARE /ALLOWDOWNGRADE=1/ ASSERTION WAS HERE AND IT WAS WORTHLESS. Mutation-checked by deleting the
  // code that passes the flag: it still PASSED, because the word also appears in the comment explaining
  // why the flag is used. It matched PROSE, not behaviour — this repo's "a test must not derive its
  // expectations from source TEXT" rule, reproduced by the person who wrote the rule down. The assertion
  // below matches the code construct and strictly implies it, so the bare one is deleted rather than kept
  // as reassurance.

  // THE FLAG MUST BE CONDITIONAL. Passing it unconditionally would work today and would hide the case it
  // exists for: a fresh install and a rollback would become the same command, so nothing downstream could
  // report which one happened — the repo's own "two faults must not print the same word" rule.
  assert.match(BOOTSTRAP, /if \(\$rollingBack\) \{ \$msiArgs \+= 'ALLOWDOWNGRADE=1' \}/,
    "ALLOWDOWNGRADE is not gated on actually rolling back, so a first install and a rollback are "
    + "indistinguishable in the log.");

  // And the refuted claim must not come back. This is the sentence that sent an operator to reimage a
  // machine one flag fixes.
  assert.doesNotMatch(BOOTSTRAP, /will not let Edge be uninstalled/,
    "the bootstrap has regained the claim that a newer Edge cannot be brought back. It can: "
    + "ALLOWDOWNGRADE=1, which this script now uses.");
  assert.doesNotMatch(BOOTSTRAP, /REIMAGE this box/,
    "the bootstrap tells the operator to reimage a box that a supported rollback repairs in place.");
});

test("the bootstrap pins Edge 156.0.4314.42: version, MSI and hash move together", () => {
  // The three values are one pin. A version bumped without its MSI URL and hash installs the OLD build
  // (the `already pinned` branch is skipped, the hash check passes, the post-install check refuses), and a
  // hash from another build refuses every first boot. Control's `edge-pin-parity.test.ts` holds the worker
  // role equal to whatever is read here; this holds the values themselves, so a typo in any one of them
  // fails in the repository that owns the script.
  // Each value is read the way the script assigns it, not searched for as a bare string, so a stale copy
  // left in a comment cannot satisfy the assertion.
  const assigned = (name: string): string | undefined =>
    BOOTSTRAP.match(new RegExp(`^\\$${name}\\s*=\\s*(?:if \\(\\$env:\\w+\\) \\{ \\$env:\\w+ \\} else \\{ )?'([^']+)'`, "m"))?.[1];

  assert.equal(assigned("EdgeVersion"), "156.0.4314.42");
  assert.equal(assigned("EdgeMsiUrl"),
    "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/62209208-6eb6-4f5e-bff5-feb45cfe41d3/MicrosoftEdgeEnterpriseX64.msi");
  assert.equal(assigned("EdgeMsiSha"), "324d226c5ade08c2776645cfc2a7b12af9c08214abf18c6499410cd8ed92d1b3");
});
