/**
 * THE DISPLAY MODE COMES FROM `defaults/main.yml`, NEVER HARDCODED IN THE TASK. #1567's own Region names
 * this file for exactly that reason: `tasks/display.yml` is EXEMPT from the provision stamp's
 * `$ENVIRONMENT_FILES` (see `provision-stamp-inputs.test.ts`) only because the VALUE it applies already
 * lives in `defaults/main.yml`, which the stamp already hashes -- the same argument that file makes for
 * `policy.yml`. A width or height typed directly into the task instead would move the environment with
 * nothing hashing it, and `provisionRevision` would stay equal across a fleet that had actually diverged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { declareWalkScope } from "../../guards/src/walk-scope.mjs";

// This reads `packages/control/ansible/roles/worker/` directly, so `packages/control` joins the scope
// the same way `provision-stamp-inputs.test.ts` already declares it.
export const WALK_SCOPE = ["packages/control", "packages/worker-fleet"];
await declareWalkScope(import.meta.url);

const DEFAULTS = readFileSync(
  fileURLToPath(new URL("../../control/ansible/roles/worker/defaults/main.yml", import.meta.url)), "utf8");
const DISPLAY_TASK = readFileSync(
  fileURLToPath(new URL("../../control/ansible/roles/worker/tasks/display.yml", import.meta.url)), "utf8");

/** `worker_display_mode`'s own width/height, read from defaults -- never restated as a copy. */
function displayMode(): { width: string; height: string } {
  const block = /^worker_display_mode:\n((?:[ \t]+\S.*\n?)+)/m.exec(DEFAULTS)?.[1];
  assert.ok(block, "worker_display_mode is gone from defaults/main.yml -- this test examines nothing");
  const width = /width:\s*(\d+)/.exec(block!)?.[1];
  const height = /height:\s*(\d+)/.exec(block!)?.[1];
  assert.ok(width && height, "worker_display_mode no longer declares both width and height");
  return { width: width!, height: height! };
}

test("worker_display_mode defaults to the mode the calibration corpus and workers 2-6 already sit at", () => {
  // `ceo`'s #1561 ruling (b): this is not a preference picked here, it is what already runs and is
  // measured to be safe -- a WIDER mode needs its own read showing it holds on every adapter first.
  const { width, height } = displayMode();
  assert.equal(width, "1024", "1024 is not chosen in this file -- it is read off what already runs");
  assert.equal(height, "768", "768 is not chosen in this file -- it is read off what already runs");
});

test("display.yml reads the mode from defaults; it does not carry its own width or height", () => {
  assert.match(DISPLAY_TASK, /worker_display_mode\.width/,
    "display.yml must template Width from worker_display_mode.width -- a hardcoded value here would move "
    + "the environment with nothing hashing it, and provisionRevision would stay equal across a fleet that "
    + "had actually diverged");
  assert.match(DISPLAY_TASK, /worker_display_mode\.height/,
    "same as Width, for Height -- see the message above");
});
