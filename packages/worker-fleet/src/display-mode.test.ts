/**
 * THE DISPLAY MODE COMES FROM `defaults/main.yml`, NEVER HARDCODED IN THE TASK. #1567's own Region names
 * this file for exactly that reason: `tasks/display.yml` is EXEMPT from the provision stamp's
 * `$ENVIRONMENT_FILES` (see `provision-stamp-inputs.test.ts`) only because the VALUE it applies already
 * lives in `defaults/main.yml`, which the stamp already hashes -- the same argument that file makes for
 * `policy.yml`. A width or height typed directly into the task instead would move the environment with
 * nothing hashing it, and `provisionRevision` would stay equal across a fleet that had actually diverged.
 */
import { declareWalkScope } from "../../guards/src/walk-scope.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/** `worker_display_driver_*`'s own url/sha256, read from defaults -- never restated as a copy. */
function displayDriverPin(): { url: string; sha256: string } {
  const url = /^worker_display_driver_url:\s*"([^"]+)"/m.exec(DEFAULTS)?.[1];
  const sha256 = /^worker_display_driver_sha256:\s*"([^"]+)"/m.exec(DEFAULTS)?.[1];
  assert.ok(url && sha256, "worker_display_driver_url/_sha256 are gone from defaults/main.yml");
  return { url: url!, sha256: sha256! };
}

test("worker_display_driver_sha256 is the value #1782 sourced through Intel's real Download Center", () => {
  // #1567's own refusal: no third-party-mirror hash, and none invented here. This pins the exact value
  // the chairman sourced and this checkout independently re-verified -- see #1782 and display.yml's own
  // header comment. A future re-pin (a newer Intel package) is expected to change this test, not to leave
  // it matching stale prose.
  const { sha256 } = displayDriverPin();
  assert.equal(sha256, "a88862682e00bc203cf4be9ff6057e400e94a1dcca48e1f07a67718f5b99c423",
    "worker_display_driver_sha256 no longer matches the value #1782 sourced and this checkout verified");
});

test("display.yml fetches the driver with win_get_url's own checksum, never installs an unverified download", () => {
  assert.match(DISPLAY_TASK, /win_get_url:[\s\S]{0,200}checksum:\s*"\{\{\s*worker_display_driver_sha256\s*\}\}"/,
    "display.yml must pass worker_display_driver_sha256 to win_get_url's checksum -- fetching the pinned "
    + "URL without it would install whatever bytes are actually served, not the value #1782 verified");
});

test("display.yml treats installer exit codes 17/18 (shutdown required) as failures, never as success", () => {
  // The package's own installation_readme.txt: 2/14 mean a software-controlled restart, safe for
  // win_reboot; 17/18 mean the box is shutting down and, per the same readme, may need a human to press
  // its power button. This fleet is bare-metal with nobody guaranteed on site -- a green result here must
  // not be the thing that leaves a worker dark.
  assert.match(DISPLAY_TASK, /failed_when:\s*display_driver_install\.rc not in \[0,\s*2,\s*14\]/,
    "display.yml's install task no longer refuses exit codes 17/18 -- a shutdown-required outcome would "
    + "read as success");
});

test("display.yml's final debug never reads display_driver_proof.output unconditionally", () => {
  // `display_driver_proof` is only REGISTERED by the task above it, guarded `when: not display_driver_ok`.
  // On workers 2-6 (already a problem-free Intel driver) that task is skipped and the registered result
  // has no `.output` -- reading it unconditionally fails Ansible's strict templating there, which is
  // exactly the requirement this role must not violate: workers 2-6 are never touched. Reviewer's
  // blocker on #1819 (2026-09-20T21:39:58Z) caught this by reading the play, not by running it.
  const block = /- name: Say what the display adapter is on[\s\S]*?msg:[\s\S]*?(?=\n- name:|\n*$)/.exec(DISPLAY_TASK)?.[0];
  assert.ok(block, "the final 'Say what the display adapter is on' debug task is gone from display.yml");
  assert.match(block!, /display_driver_proof\.output \| first if not display_driver_ok/,
    "the debug's msg must guard display_driver_proof.output behind 'if not display_driver_ok' -- an "
    + "unconditional read broke workers 2-6, which never register that variable");
});

const SET_DISPLAY_MODE_SCRIPT = readFileSync(
  fileURLToPath(new URL("./provisioning/set-display-mode.ps1", import.meta.url)), "utf8");

test("the display mode is set through run-interactive.yml, never a direct win_powershell call over SSH", () => {
  // #1567, 2026-09-21: a direct `win_powershell` task calling EnumDisplaySettings failed on all 10 real
  // workers -- SSH does not attach to the interactive window station GDI calls need, the same fact
  // `tasks/run-interactive.yml`'s own header names for SystemParametersInfo. A regression back to a direct
  // call would reintroduce that live failure with nothing here to catch it before the next real run.
  const block = /- name: The display mode the fleet pins[\s\S]*?(?=\n- name:|\n*$)/.exec(DISPLAY_TASK)?.[0];
  assert.ok(block, "'The display mode the fleet pins' task is gone from display.yml");
  assert.match(block!, /include_tasks:\s*"\{\{\s*playbook_dir\s*\}\}\/tasks\/run-interactive\.yml"/,
    "the display-mode task must run through tasks/run-interactive.yml's interactive scheduled task, not "
    + "a direct win_powershell call -- see this task's own header comment for why");
  assert.doesNotMatch(block!, /ansible\.windows\.win_powershell/,
    "the display-mode task must not call win_powershell directly -- that is the mechanism that failed "
    + "live against the real fleet");
});

test("set-display-mode.ps1 reads its width/height from the environment, never a hardcoded value", () => {
  assert.match(SET_DISPLAY_MODE_SCRIPT, /\$env:A11Y_DISPLAY_WIDTH/,
    "set-display-mode.ps1 must read A11Y_DISPLAY_WIDTH -- display.yml sets it from worker_display_mode.width");
  assert.match(SET_DISPLAY_MODE_SCRIPT, /\$env:A11Y_DISPLAY_HEIGHT/,
    "set-display-mode.ps1 must read A11Y_DISPLAY_HEIGHT -- display.yml sets it from worker_display_mode.height");
});

test("display.yml passes both env vars into set-display-mode.ps1 from worker_display_mode", () => {
  const block = /- name: The display mode the fleet pins[\s\S]*?(?=\n- name:|\n*$)/.exec(DISPLAY_TASK)?.[0];
  assert.ok(block, "'The display mode the fleet pins' task is gone from display.yml");
  assert.match(block!, /A11Y_DISPLAY_WIDTH = '\{\{\s*worker_display_mode\.width\s*\}\}'/,
    "display.yml must set A11Y_DISPLAY_WIDTH from worker_display_mode.width before invoking the script");
  assert.match(block!, /A11Y_DISPLAY_HEIGHT = '\{\{\s*worker_display_mode\.height\s*\}\}'/,
    "display.yml must set A11Y_DISPLAY_HEIGHT from worker_display_mode.height before invoking the script");
  assert.match(block!, /set-display-mode\.ps1/, "display.yml must invoke set-display-mode.ps1");
});

test("set-display-mode.ps1 NAMES the display device, and never asks for the nameless default", () => {
  // #1955, measured on a11y-worker-2 inside the interactive one-shot task on 2026-09-22:
  // `EnumDisplaySettingsW($null, CURRENT)` -> False, `EnumDisplaySettingsW('\\.\DISPLAY1', CURRENT)` ->
  // True, 1024x768. Every NULL-device GDI call on this fleet refuses and every named one answers, so a
  // regression to `$null` here reintroduces a failure that took a ten-host play and three probe rounds to
  // separate from the session, the desktop, the driver and the struct layout.
  assert.match(SET_DISPLAY_MODE_SCRIPT, /MonitorFromPoint/,
    "set-display-mode.ps1 must resolve the primary display through MonitorFromPoint -- see display.yml's "
    + "#1955 header for what happens when the device is left for the system to pick");
  assert.match(SET_DISPLAY_MODE_SCRIPT, /GetMonitorInfoW/,
    "MonitorFromPoint gives a monitor handle; GetMonitorInfoW is what turns it into the \\\\.\\DISPLAYn "
    + "name the display calls need");
  assert.doesNotMatch(SET_DISPLAY_MODE_SCRIPT, /EnumDisplaySettings\(\$null/,
    "EnumDisplaySettings must be given the resolved device name, never $null -- $null is the exact call "
    + "that returned False on all ten workers");
});

test("set-display-mode.ps1 changes the mode through ChangeDisplaySettingsEx, the form that takes a device name", () => {
  // ChangeDisplaySettings (no Ex) has no device-name parameter at all, so it cannot express the fix
  // above: it always acts on the default device, which is the thing this fleet refuses.
  assert.match(SET_DISPLAY_MODE_SCRIPT, /ChangeDisplaySettingsExW/,
    "set-display-mode.ps1 must call ChangeDisplaySettingsExW with the resolved device name");
  assert.doesNotMatch(SET_DISPLAY_MODE_SCRIPT, /EntryPoint = "ChangeDisplaySettings"/,
    "the nameless ChangeDisplaySettings cannot take a device name, so importing it would be a way back "
    + "to the defect #1955 fixed");
});

test("set-display-mode.ps1 reports the context a bare failure could not distinguish", () => {
  // Done-when 1 of #1955. The old failure wrote one sentence, which could not tell apart "landed in
  // session 0", "landed in session 1 with no display" and "reached the right desktop and the call
  // refused" -- three causes in three different files. Each fact below is one of those discriminators,
  // and dropping any of them puts the next fleet play back to buying one sentence for a ten-host run.
  for (const [probe, why] of [
    ["SessionId", "the session id separates 'the interactive_token route did not take' from the rest"],
    ["GetProcessWindowStation", "the window station name is how 'WinSta0' is shown rather than assumed"],
    ["GetThreadDesktop", "the desktop name is the other half of that: 'Default' is the interactive one"],
    ["GetSystemMetrics", "screen metrics say whether the desktop has a display AT ALL, which is what "
      + "disagreed with the enumeration and pointed at the argument instead of the environment"],
    ["EnumDisplayDevices", "the device enumeration is the measurement that named the defect"],
    ["GetLastWin32Error", "the Win32 code, printed with its own warning that it is unreliable here"],
  ] as const) {
    assert.match(SET_DISPLAY_MODE_SCRIPT, new RegExp(probe),
      `set-display-mode.ps1 no longer reports ${probe} -- ${why}`);
  }
});

test("display.yml pins the display mode AFTER the driver install, never before it", () => {
  // #1955, measured on a11y-worker-7 2026-09-22T19:07Z: with the device-name fix in place the mode READS
  // (640x480, the Microsoft Basic Display Adapter's fallback) and ChangeDisplaySettingsEx returns -2,
  // DISP_CHANGE_FAILED -- a basic adapter cannot do 1024x768. With the mode task running first, the play
  // failed there and the Intel driver install below it never ran: the one step that would have made the
  // mode settable. Workers 2-6, already on a problem-free Intel driver, passed the same task in the same
  // run, which is what makes this an ordering fault and not a second defect in the script.
  const modeAt = DISPLAY_TASK.indexOf("- name: The display mode the fleet pins");
  const installAt = DISPLAY_TASK.indexOf("- name: Install it silently");
  assert.ok(modeAt >= 0, "'The display mode the fleet pins' task is gone from display.yml");
  assert.ok(installAt >= 0, "the display-driver install task is gone from display.yml");
  assert.ok(modeAt > installAt,
    "display.yml must pin the display mode AFTER installing the display driver -- ordered the other way, "
    + "workers 7-11 fail the mode pin on a basic display adapter and never reach the install that fixes it");
});
