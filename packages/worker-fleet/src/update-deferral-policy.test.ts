/**
 * #921 / PR #1759 review: the write (`tasks/policy.yml`) and its read-back verification both derive the
 * expected values from the SAME `worker_update_deferral_policy` list in `defaults/main.yml` -- so a
 * mutation to that list (e.g. `DeferFeatureUpdatesPeriodInDays` 365 -> 1) regresses the actual policy
 * while every existing check, including the read-back, stays green: the read-back only proves Ansible
 * wrote whatever the list currently says, not that the list still says the right thing.
 *
 * This is the independent copy CLAUDE.md's assertion discipline asks for: the expected path, names and
 * values are LITERALS in this file, never read from `defaults/main.yml` itself, so a change to the role's
 * declared values is what this test exists to catch -- the same shape `worker-port.test.ts` and
 * `edge-pin-parity.test.ts` already use for a fact declared once and depended on elsewhere. Deliberately
 * not a YAML parse: `packages/control` takes no dependency (ADR 0012), and a plain regex on the block is
 * the house convention those two files already set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULTS = readFileSync(
  fileURLToPath(new URL("../../control/ansible/roles/worker/defaults/main.yml", import.meta.url)), "utf8");

/** Every `- path: '...' / name: ... / value: ...` entry under `worker_update_deferral_policy:`. */
function deferralEntries(): { path: string, name: string, value: number }[] {
  const start = DEFAULTS.indexOf("worker_update_deferral_policy:");
  assert.ok(start !== -1, "worker_update_deferral_policy is gone from the role defaults -- this test "
    + "examines nothing");
  // Ends at the next top-level (column-0) key, the same boundary convention `provision-stamp-inputs.test.ts`
  // uses for `$ENVIRONMENT_FILES`.
  const rest = DEFAULTS.slice(start);
  const afterFirstLine = rest.indexOf("\n") + 1;
  const end = rest.slice(afterFirstLine).search(/^\S/m);
  const block = end === -1 ? rest : rest.slice(0, afterFirstLine + end);
  const entries: { path: string, name: string, value: number }[] = [];
  const re = /-\s*path:\s*'([^']+)'\s*\n\s*name:\s*(\S+)\s*\n\s*value:\s*(\d+)/g;
  for (const m of block.matchAll(re)) entries.push({ path: m[1], name: m[2], value: Number(m[3]) });
  return entries;
}

const WINDOWS_UPDATE_PATH = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate';

test("the deferral policy declares BOTH expected values, independent of whatever the list currently says", () => {
  const entries = deferralEntries();
  assert.ok(entries.length >= 2,
    `found ${entries.length} entr(ies) under worker_update_deferral_policy -- expected at least 2 `
    + "(DeferFeatureUpdates, DeferFeatureUpdatesPeriodInDays); the regex may have drifted from the file's "
    + "own shape, or an entry was removed");

  const byName = new Map(entries.map((e) => [e.name, e]));

  const defer = byName.get("DeferFeatureUpdates");
  assert.ok(defer, "DeferFeatureUpdates is missing from worker_update_deferral_policy");
  assert.equal(defer.path, WINDOWS_UPDATE_PATH,
    `DeferFeatureUpdates is under '${defer.path}', not the WindowsUpdate policy path a feature-update `
    + "deferral has to live under to mean anything");
  assert.equal(defer.value, 1, `DeferFeatureUpdates is ${defer.value}, not 1 -- the switch that turns the `
    + "deferral on at all has regressed");

  const period = byName.get("DeferFeatureUpdatesPeriodInDays");
  assert.ok(period, "DeferFeatureUpdatesPeriodInDays is missing from worker_update_deferral_policy");
  assert.equal(period.path, WINDOWS_UPDATE_PATH,
    `DeferFeatureUpdatesPeriodInDays is under '${period.path}', not the WindowsUpdate policy path`);
  assert.equal(period.value, 365,
    `DeferFeatureUpdatesPeriodInDays is ${period.value}, not 365 (the maximum Windows accepts) -- #921 `
    + "exists because a feature update reached a worker twice; a shorter deferral reopens exactly that "
    + "window sooner, silently, with every other check here still green.");
});
