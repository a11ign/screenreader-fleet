/**
 * THE STAMP'S FILE LIST IS PINNED BY NOTHING. `provision-stamp.test.ts` asserts the four hashed files
 * have not silently changed; it does not, and structurally cannot, say whether they are the RIGHT four.
 * A new task file or a new custom Ansible module that provisioning reads can ship today with nothing
 * asking whether it belongs in the hash, and the failure is silent in the worst direction: the stamp
 * keeps matching across a real environment change, `fleet-consistency` calls a split fleet consistent,
 * and two guests with different NVDA/Edge behaviour share one capture cache entry.
 *
 * This is a DISCOVERING test, in the shape `busy-worker-guard.test.ts` already uses for the identical
 * problem one layer over (a worker playbook nobody classified). It enumerates every task file under
 * `roles/worker/tasks/`, every custom module under the `a11y.worker` collection, and the NIC driver
 * blobs `bespoke.yml` stages, and requires each to be either HASHED (its path appears in the stamp's own
 * `$ENVIRONMENT_FILES`) or EXEMPT with a reason — never silently uncovered.
 *
 * ## THE MIXTURE, measured file by file rather than assumed
 *
 * Most of the role vindicates the stated exclusion. `policy.yml`, `edge-version.yml` and `nvda.yml`'s
 * guidepup/NVDA install are all MECHANISM over VALUES that are either already hashed (`defaults/main.yml`
 * carries every Edge policy DWORD `policy.yml` applies) or independently re-measured every capture
 * (`browserVersion`, `screenReaderVersion`, `guidepupVersion` are read from the live guest, not assumed
 * from what provisioning intended) — a bug in the task file would show up as a live-measured mismatch,
 * which is a louder and more reliable signal than a stale stamp would be. `account.yml`, `firewall.yml`,
 * `tasks.yml`, `verify.yml`, and the `a11y_defender`/`a11y_nic_power`/`a11y_onedrive`/`a11y_power_timeouts`
 * modules affect reliability (does the box answer, does it stay awake, does it wake on LAN) rather than
 * what a capture HEARS, so they are correctly outside a key that exists to stop two guests' EVIDENCE from
 * blending.
 *
 * ONE FILE IS A GENUINE GAP: `a11y_speech_viewer.ps1` (and its documentation-only `.py` pair). It writes
 * `showSpeechViewerAtStartup = False` into every `nvda.ini` — described by its own header as "the
 * highest-value setting on a worker and the one that fails most quietly", because with it on, EVERY
 * interaction probe returns "NVDA Speech Viewer" instead of the page's response, making an accessible
 * page and an inaccessible one indistinguishable. Checked against every other cache-key field: not in
 * `CAPTURE_SETTINGS` (`nvda-logging.mjs` lists exactly one entry, `speech.reportLanguage` — Speech Viewer
 * is a separate `nvda.ini` section `getSettings()` does not read), not in `/health` (only `/diagnostics`
 * reports it, which is on-demand and outside `environmentKey()` entirely), not in `browserVersion`,
 * `guidepupVersion`, `windowsVersion`, `architecture` or `captureProtocol` — none of which have any
 * relationship to an NVDA UI window's startup state. Sharpened by its own sibling: `provision-nvda-worker.ps1`
 * (the zero-touch PowerShell path, ALREADY hashed) inlines the identical fix at its own Step 5 — so the
 * two provisioning paths apply the same remedy, and only one copy of it is protected by the stamp. That
 * is "a remedy applied at one call site when the behaviour reaches several", CLAUDE.md's own name for
 * this repo's most expensive recurring shape, arrived at inside the mechanism meant to catch exactly this.
 *
 * Recorded here as a FINDING, not fixed: changing `$ENVIRONMENT_FILES` moves `provisionRevision` and
 * invalidates the corpus, which is a decision for whoever owns the live recapture, not something a test
 * should decide unilaterally by asserting a bigger list into existence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROLE = fileURLToPath(new URL("../../control/ansible/roles/worker/", import.meta.url));
const MODULES = fileURLToPath(
  new URL("../../control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/", import.meta.url));

/** `$ENVIRONMENT_FILES` from the stamp's own source — never a restated copy of the list. */
function hashedFiles(): string[] {
  const stamp = readFileSync(
    fileURLToPath(new URL("./provisioning/stamp-provision-revision.ps1", import.meta.url)), "utf8");
  const list = stamp.slice(stamp.indexOf("$ENVIRONMENT_FILES = @("), stamp.indexOf(")", stamp.indexOf("$ENVIRONMENT_FILES = @(")));
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Every task file `main.yml` imports — the whole of what the Ansible path can DO to a guest. */
function taskFiles(): string[] {
  return readdirSync(ROLE + "tasks")
    .filter((f) => f.endsWith(".yml"))
    .map((f) => `packages/control/ansible/roles/worker/tasks/${f}`);
}

/** Every custom `a11y.worker` module — the PowerShell implementation and its documentation pair. */
function moduleFiles(): string[] {
  return readdirSync(MODULES)
    .filter((f) => f.endsWith(".ps1") || f.endsWith(".py"))
    .map((f) => `packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/${f}`);
}

/** The NIC driver blobs `bespoke.yml` stages onto a guest with the inbox driver. */
function driverFiles(): string[] {
  return readdirSync(ROLE + "files/intel-e1d")
    .map((f) => `packages/control/ansible/roles/worker/files/intel-e1d/${f}`);
}

/**
 * Why a discovered file does not need to be in `$ENVIRONMENT_FILES`. A REASON, never a bare name, so
 * that widening the hash means arguing with a sentence rather than deleting a string — the identical
 * discipline `busy-worker-guard.test.ts`'s `EXEMPT` already uses.
 *
 * Every entry states what the file changes and WHERE (if anywhere) that change is already caught, so a
 * reader can tell "correctly excluded" from "not yet decided" without re-deriving the audit.
 */
const EXEMPT: Record<string, string> = {
  "packages/control/ansible/roles/worker/tasks/main.yml":
    "Only imports the other task files below in order. Carries no value of its own.",
  "packages/control/ansible/roles/worker/tasks/policy.yml":
    "Applies registry DWORDs, but every VALUE it writes (worker_edge_policy, worker_edge_update_policy, "
    + "worker_quiet_policy, worker_content_delivery_values) is declared in defaults/main.yml, which is "
    + "already hashed. A refactor here (batching writes, changing the read-back shape) cannot move the "
    + "environment without also touching the file that is hashed.",
  "packages/control/ansible/roles/worker/tasks/edge-version.yml":
    "Installs and pins worker_edge_version (from the already-hashed defaults/main.yml), but the effect — "
    + "which Edge build actually runs — is independently re-measured every capture via browserVersion, a "
    + "cache-key field read from the live binary rather than assumed from provisioning intent. A bug here "
    + "shows up as a live mismatch, which is louder and more reliable than a stale stamp.",
  "packages/control/ansible/roles/worker/tasks/nvda.yml":
    "Installs guidepup/NVDA (screenReaderVersion and guidepupVersion are live-measured cache-key fields, "
    + "same reasoning as edge-version.yml) and invokes a11y_speech_viewer — see that module's own entry "
    + "below for the one part of this file that is NOT covered elsewhere.",
  "packages/control/ansible/roles/worker/tasks/tasks.yml":
    "Registers the scheduled task (LogonType, RunLevel). Getting these wrong makes NVDA fail to start at "
    + "all (\"NVDA is not supported\") or capture nothing (an elevated worker cannot read the browser) — a "
    + "loud, total capture failure, not the silent per-guest evidence drift the stamp exists to catch.",
  "packages/control/ansible/roles/worker/tasks/bespoke.yml":
    "Power timeouts, NIC wake, Defender and browser-profile directories — reliability and disk, not what "
    + "a capture hears. Also writes provision-revision.txt itself, which cannot sensibly hash its own input.",
  "packages/control/ansible/roles/worker/tasks/packages.yml":
    "Node and Git versions, and the repo clone. Neither Node nor Git touches NVDA/Edge announcement "
    + "content; the repo's checked-out COMMIT is deliberately a separate, non-cache-key precondition "
    + "(assertFleetRunsThisCheckout), not this stamp's job.",
  "packages/control/ansible/roles/worker/tasks/account.yml":
    "Account identity and auto-logon. No relationship to what a capture observes.",
  "packages/control/ansible/roles/worker/tasks/firewall.yml":
    "Network reachability (port rules, sshd). No relationship to what a capture observes.",
  "packages/control/ansible/roles/worker/tasks/verify.yml":
    "Read-only checks against what earlier tasks already did. Writes nothing.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_defender.ps1":
    "Windows Defender real-time monitoring, off for memory headroom. Perf only.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_defender.py":
    "Documentation for a11y_defender.ps1 (see that entry). No independent runtime effect.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_nic_power.ps1":
    "NIC selective-suspend and wake settings. Affects Wake-on-LAN and reachability, never capture content.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_nic_power.py":
    "Documentation for a11y_nic_power.ps1 (see that entry). No independent runtime effect.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_power_timeouts.ps1":
    "AC sleep timeouts, so the worker does not vanish. Affects reachability, never capture content.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_power_timeouts.py":
    "Documentation for a11y_power_timeouts.ps1 (see that entry). No independent runtime effect.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_onedrive.ps1":
    "Evicts OneDrive to stop a focus-stealing toast. Real evidence risk, but an INTERMITTENT one-off event "
    + "per capture, not a persistent per-guest state that silently blends two populations the way a "
    + "config default does — gate:stability's content comparison is what actually catches this class.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_onedrive.py":
    "Documentation for a11y_onedrive.ps1 (see that entry). No independent runtime effect.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_nvda.ps1":
    "Installs NVDA via guidepup. Which build lands is screenReaderVersion/guidepupVersion, live-measured "
    + "cache-key fields — the same reasoning as edge-version.yml above.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_nvda.py":
    "Documentation for a11y_nvda.ps1 (see that entry). No independent runtime effect.",
  // --- THE FINDING. Not silently covered by anything else; not silently added to the hash either. ---
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_speech_viewer.ps1":
    "GAP, recorded 2026-09-06, not yet remedied: writes showSpeechViewerAtStartup, and NOTHING else in "
    + "the cache key covers it. Not in CAPTURE_SETTINGS (nvda-logging.mjs has exactly one entry, "
    + "speech.reportLanguage), not in /health (only on-demand /diagnostics reports it), not related to "
    + "browserVersion/guidepupVersion/windowsVersion/architecture/captureProtocol. If this module ever "
    + "regressed (or a fresh box shipped guidepup's default ON), the stamp would not move, fleet-consistency "
    + "would read the fleet as fine, and every interaction probe on that guest would silently return "
    + "\"NVDA Speech Viewer\" instead of the page's response. provision-nvda-worker.ps1 (already hashed) "
    + "applies the IDENTICAL fix inline at its own Step 5, so the Ansible path's copy is the one call site "
    + "the remedy did not reach. This exemption exists so the gap is visible in source rather than silently "
    + "absent from consideration; whether to hash this file (or move its value into defaults/main.yml the "
    + "way every Edge policy already is) is a decision for whoever owns the live recapture, made deliberately "
    + "rather than as a side effect of this test passing.",
  "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_speech_viewer.py":
    "Documentation for a11y_speech_viewer.ps1. See that entry for the actual finding.",
  "packages/control/ansible/roles/worker/files/intel-e1d/e1d.inf":
    "Intel NIC driver. Wake-on-LAN and reachability, never capture content.",
  "packages/control/ansible/roles/worker/files/intel-e1d/e1d.sys":
    "Intel NIC driver. Wake-on-LAN and reachability, never capture content.",
  "packages/control/ansible/roles/worker/files/intel-e1d/e1d.cat":
    "Intel NIC driver catalogue (signature). Wake-on-LAN and reachability, never capture content.",
  "packages/control/ansible/roles/worker/files/intel-e1d/e1dmsg.dll":
    "Intel NIC driver message resource. Wake-on-LAN and reachability, never capture content.",
};

function discovered(): string[] {
  return [...taskFiles(), ...moduleFiles(), ...driverFiles()];
}

test("provision-stamp-inputs.test.ts discovers a non-trivial set of files", () => {
  // The vacuity guard. A change to this role's layout that silently emptied the discovery functions would
  // make every test below pass by examining nothing.
  const found = discovered();
  assert.ok(found.length >= 15, `expected to discover the role's task and module files, found ${found.length}`);
});

test("every task file, custom module and driver blob is HASHED or EXEMPT with a reason", () => {
  const hashed = new Set(hashedFiles());
  for (const file of discovered()) {
    if (hashed.has(file)) continue;
    assert.ok(EXEMPT[file], `${file} is neither in the stamp's $ENVIRONMENT_FILES nor in EXEMPT — nobody `
      + "has decided whether it belongs in the capture cache key. Add it to one, with a reason.");
    assert.ok(EXEMPT[file].length > 40, `${file}: an exemption needs a reason, not a name`);
  }
});

test("every EXEMPT entry names a file that still exists, so the list cannot rot into a phantom", () => {
  const present = new Set(discovered());
  const alsoHashed = new Set(hashedFiles());
  for (const file of Object.keys(EXEMPT)) {
    assert.ok(present.has(file) || alsoHashed.has(file),
      `EXEMPT names ${file}, which discovery no longer finds under roles/worker/ or the a11y.worker collection`);
  }
});

test("the speech-viewer gap is named explicitly, not folded into a generic reason", () => {
  // A guard against someone "tidying" the finding away by giving it the same boilerplate reason as its
  // safe siblings, which would make this test pass while quietly deciding the open question.
  const reason = EXEMPT["packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_speech_viewer.ps1"];
  assert.match(reason, /^GAP,/, "the speech-viewer exemption must say plainly that it is an open gap, "
    + "not a vindicated exclusion");
});
