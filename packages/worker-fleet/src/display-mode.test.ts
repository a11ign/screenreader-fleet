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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// THIS FILE DECLARED A WALK SCOPE UNTIL IT STARTED RUNNING POWERSHELL, and it cannot honestly declare one
// now. The tests at the bottom spawn `pwsh`, and `walk-scope.mjs` records a child process as
// `(the whole repository)` on purpose -- what a subprocess reads is not visible to the observer, so no
// narrower declaration could be checked, and `readsOutsideScope` refuses that marker whatever the scope
// says. Its own message offers exactly two ways out, widen or remove, and only the second is available.
// Undeclared is unbounded: `narrowByDeclaredScope` keeps an undeclared guard on every diff, which is the
// direction that fails safe -- see `declared-walk-scope.test.ts`, whose second pinned property this is.

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

/**
 * The script split into the two halves a mutation can tell apart, because the raw file cannot.
 *
 * reviewer-2's blocker on #1968 at `b7b79649`: every assertion below used to match the whole file, so
 * `/MonitorFromPoint/` was satisfied three times over -- by the `DllImport` declaration, by the script's
 * own header prose, and only incidentally by the one line that calls it. Deleting that call left 18/18
 * green. The corrected "delete every matching line" mutation in that PR's body widened the deletion
 * rather than fixing the assertion: it proved the WORD was gone, never that the CALL was load-bearing.
 *
 * `declarations` is the C# inside `Add-Type -TypeDefinition '...'`; `body` is the PowerShell that
 * actually runs, with that block and every comment line removed. An API now has to be DECLARED in the
 * first and CALLED in the second, and deleting either line ALONE is red.
 */
function scriptParts(): { declarations: string; body: string } {
  const declarations = /Add-Type -TypeDefinition '([\s\S]*?)'/.exec(SET_DISPLAY_MODE_SCRIPT)?.[1];
  assert.ok(declarations,
    "set-display-mode.ps1 no longer has an `Add-Type -TypeDefinition '...'` block -- this split examines "
    + "nothing, and every assertion built on it would be vacuously true");
  const body = SET_DISPLAY_MODE_SCRIPT
    .replace(declarations!, "")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  return { declarations: declarations!, body };
}

/**
 * An API is USED only where it is both declared in the P/Invoke block and invoked in the PowerShell.
 *
 * The call pattern is `[A11yDisplay.NativeMethods]::<name>(`, which no comment and no declaration can
 * satisfy -- that prefix appears at call sites and nowhere else. `declaredAs` and `calledAs` are separate
 * because they are not always the same word: `GetMonitorInfoW` is the `EntryPoint`, `GetMonitorInfo` is
 * what the script calls, and an assertion on the entry point alone left every call site unpinned.
 */
function assertNativeCall(api: { declaredAs: string; calledAs: string; why: string }): void {
  const { declarations, body } = scriptParts();
  assert.match(declarations,
    new RegExp(`EntryPoint = "${api.declaredAs}"|extern [^\\n]*\\b${api.declaredAs}\\(`),
    `set-display-mode.ps1 no longer DECLARES ${api.declaredAs} -- ${api.why}`);
  assert.match(body, new RegExp(`\\[A11yDisplay\\.NativeMethods\\]::${api.calledAs}\\(`),
    `set-display-mode.ps1 declares ${api.declaredAs} but no longer CALLS ${api.calledAs} anywhere in its `
    + `executable body -- ${api.why}`);
}

test("the declarations/body split really separates them -- the control every assertion below rests on", () => {
  // Without this, a split that silently returned "" would make each `doesNotMatch` below pass for the
  // wrong reason and prove nothing at all. Each pair here is a fact that holds ONLY if the split worked:
  // the thing is present in the whole file, and absent from the half that must not contain it.
  const { declarations, body } = scriptParts();
  assert.match(declarations, /DllImport/,
    "the declarations half must hold the P/Invoke declarations -- it is what `Add-Type` compiles");
  assert.doesNotMatch(body, /DllImport/,
    "the declarations must NOT survive into the body half: if they do, 'the API is called in the body' is "
    + "satisfied by its declaration again, which is the exact defect this split exists to fix");
  assert.match(SET_DISPLAY_MODE_SCRIPT, /^# Pin the display mode/m,
    "positive control for the line below -- the script's header comment must be there to be stripped");
  assert.doesNotMatch(body, /^# Pin the display mode/m,
    "comments must NOT survive into the body half: this file's header names every API asserted on below, "
    + "so a surviving comment satisfies a call assertion by itself");
  assert.match(body, /^\$ErrorActionPreference = 'Stop'$/m,
    "the body half must still hold the script's executable lines -- an empty body makes every `match` "
    + "below fail loudly, but it is cheaper to say so here");
});

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
  // True, 1024x768. That `$null` never reached Windows as NULL -- PowerShell binds it to a `string`
  // parameter as `[string]::Empty` -- so what those readings establish is that an EMPTY-named call
  // refuses and a named one answers. A regression to `$null` here reintroduces a failure that took a
  // ten-host play and three probe rounds to separate from the session, the desktop, the driver and the
  // struct layout.
  assertNativeCall({
    declaredAs: "MonitorFromPoint", calledAs: "MonitorFromPoint",
    why: "it is what resolves the primary display, and display.yml's #1955 header records what happens "
      + "when the device is left for the system to pick instead",
  });
  assertNativeCall({
    declaredAs: "GetMonitorInfoW", calledAs: "GetMonitorInfo",
    why: "MonitorFromPoint gives a monitor HANDLE; this is the call that turns it into the \\\\.\\DISPLAYn "
      + "NAME every display call here has to be given",
  });
  const { body } = scriptParts();
  assert.match(body, /\[A11yDisplay\.NativeMethods\]::EnumDisplaySettings\(\$deviceName/,
    "EnumDisplaySettings must be called with the RESOLVED device name -- naming the variable is the whole "
    + "fix, so a call that passes anything else is the defect back");
  assert.doesNotMatch(body, /EnumDisplaySettings\(\$null/,
    "EnumDisplaySettings must never be given $null -- $null is the exact call that returned False on all "
    + "ten workers");
});

test("set-display-mode.ps1 changes the mode through ChangeDisplaySettingsEx, the form that takes a device name", () => {
  // ChangeDisplaySettings (no Ex) has no device-name parameter at all, so it cannot express the fix
  // above: it always acts on the default device, which is the thing this fleet refuses.
  assertNativeCall({
    declaredAs: "ChangeDisplaySettingsExW", calledAs: "ChangeDisplaySettingsEx",
    why: "it is the only form that takes a device name, and the mode write is the half of this script "
      + "the fleet actually needs",
  });
  const { declarations, body } = scriptParts();
  assert.match(body, /\[A11yDisplay\.NativeMethods\]::ChangeDisplaySettingsEx\(\s*\$deviceName/,
    "ChangeDisplaySettingsEx must be passed the resolved device name as its device argument -- calling "
    + "the Ex form with $null asks the same unanswerable question the plain form did");
  assert.doesNotMatch(declarations, /EntryPoint = "ChangeDisplaySettings"/,
    "the nameless ChangeDisplaySettings cannot take a device name, so importing it would be a way back "
    + "to the defect #1955 fixed");
});

test("set-display-mode.ps1 READS THE MODE BACK after writing it, in the same process", () => {
  // The same "read back or it didn't happen" rule policy.yml's own trailing verify task follows, and it
  // is load-bearing here for a measured reason: on workers 7-11 ChangeDisplaySettingsEx returned -2 while
  // the desktop stayed at 640x480, and a script that trusted a return code would have reported a mode it
  // had not set. Found unpinned by the same mutation sweep that answered reviewer-2's blocker -- deleting
  // the whole read-back was green, so it is asserted rather than left to the next reader to notice.
  const { body } = scriptParts();
  const after = body.slice(body.indexOf("$result = "));
  assert.match(after, /::EnumDisplaySettings\(\$deviceName/,
    "the mode must be read back through EnumDisplaySettings AFTER the write -- a DISP_CHANGE_SUCCESSFUL "
    + "return is not the same claim as the desktop actually being at that mode");
  assert.match(after, /dmPelsWidth -ne \$Width -or [^\n]*dmPelsHeight -ne \$Height/,
    "the read-back has to be COMPARED against what was asked for, and disagreeing has to fail -- reading "
    + "a value and not checking it is the shape of proof that proves nothing");
});

test("set-display-mode.ps1 reports the context a bare failure could not distinguish", () => {
  // Done-when 1 of #1955. The old failure wrote one sentence, which could not tell apart "landed in
  // session 0", "landed in session 1 with no display" and "reached the right desktop and the call
  // refused" -- three causes in three different files. Each fact below is one of those discriminators,
  // and dropping any of them puts the next fleet play back to buying one sentence for a ten-host run.
  //
  // Each P/Invoke probe is asserted as a declaration AND a call, for reviewer-2's blocker: matching the
  // bare word left every one of these satisfied by its own `DllImport` line, so deleting the call that
  // actually produces the reading was green.
  for (const probe of [
    {
      declaredAs: "GetProcessWindowStation", calledAs: "GetProcessWindowStation",
      why: "the window station name is how 'WinSta0' is SHOWN rather than assumed",
    },
    {
      declaredAs: "GetThreadDesktop", calledAs: "GetThreadDesktop",
      why: "the desktop name is the other half of that: 'Default' is the interactive one",
    },
    {
      declaredAs: "GetSystemMetrics", calledAs: "GetSystemMetrics",
      why: "screen metrics say whether the desktop has a display AT ALL, which is what disagreed with "
        + "the enumeration and pointed at the argument instead of the environment",
    },
    {
      declaredAs: "EnumDisplayDevicesW", calledAs: "EnumDisplayDevices",
      why: "the device enumeration is the measurement that named the defect",
    },
  ]) {
    assertNativeCall(probe);
  }

  const { body } = scriptParts();
  // GetSystemMetrics is asked THREE questions and each is a separate fact, so it is pinned per index
  // rather than per call: with one assertion for the function, deleting any single one of the three left
  // the other two matching and the mutant green, reporting `screen=x768` and nobody the wiser.
  for (const metric of ["$SM_CXSCREEN", "$SM_CYSCREEN", "$SM_CMONITORS"]) {
    assert.match(body, new RegExp(`::GetSystemMetrics\\(\\${metric}\\)`),
      `set-display-mode.ps1 no longer reads ${metric} -- screen width, screen height and monitor COUNT `
      + "are three different discriminators, and a context block missing one of them is missing a fact");
  }
  assert.match(body, /\$process\.SessionId/,
    "set-display-mode.ps1 no longer reports the session id -- it is what separates 'the interactive_token "
    + "route did not take' from the two cases where it did");
  assert.match(body, /\[System\.Runtime\.InteropServices\.Marshal\]::GetLastWin32Error\(\)/,
    "set-display-mode.ps1 no longer reads the Win32 error at all -- it is printed with its own warning "
    + "that it is unreliable here, and printing it is still worth more than dropping it");
  assert.match(body, /\$\(Get-LastWin32Error\)/,
    "reading the Win32 error is not reporting it: some failure message must still interpolate it, or the "
    + "reader above is dead code and the next failure buys one sentence again");
});

test("Write-DisplayDevices runs a SAME-API positive control before claiming the population is empty", () => {
  // reviewer-2's second blocker on #1968. `EnumDisplayDevices(NULL, 0)` returning False at index 0 is two
  // findings wearing one face -- "this desktop has no display adapters" and "this function refuses a
  // nameless call here" -- and the script claimed the second while measuring only the first. (The second
  // is still unmeasured: every EnumDisplaySettings refusal on record was EMPTY-named, not nameless, so
  // the reading that would settle it has never been taken. See the script's header.) `Screen.AllScreens` and the named `EnumDisplaySettingsW` are a DIFFERENT
  // API answering a different question, so neither can settle it; the control has to be this same
  // function given a device name. This is CLAUDE.md's own rule -- an emptiness assertion names where its
  // positive control lives -- applied to a diagnostic rather than to a test.
  const { body } = scriptParts();
  assert.match(body, /Get-EnumeratedDevices -Device \(\[NullString\]::Value\)/,
    "the NULL arm is gone: it is the reading the whole row turns on");
  assert.doesNotMatch(body, /Get-EnumeratedDevices -Device \$null\b/,
    "the NULL arm must pass [NullString]::Value, never $null -- PowerShell binds $null to a `string` "
    + "parameter as [string]::Empty, so `$null` here asks about a device NAMED \"\" and never about the "
    + "NULL device at all. That coercion is the whole reason the previous version of this script failed "
    + "on 10 of 10 workers; see the file's header for the measurement");
  assert.match(body, /Get-EnumeratedDevices -Device \$PrimaryDevice\b/,
    "the NAMED arm is gone -- with no same-API control, an empty enumeration cannot distinguish a desktop "
    + "with no adapters from a function that refuses nameless calls");

  const emptyClaims = body.split("\n").filter((line) => /enumerated NOTHING/.test(line));
  assert.ok(emptyClaims.length > 0,
    "positive control for the loop below: the script must still have an empty-population message, or "
    + "this test passes over nothing");
  for (const claim of emptyClaims) {
    assert.match(claim, /NAMED/,
      `this line claims an empty enumeration without naming the control's own outcome: ${claim.trim()}`);
  }
});

test("Get-PrimaryDisplayName reports its refusal through [ref], never by writing it", () => {
  // In PowerShell everything a function writes JOINS ITS RETURN VALUE. An earlier draft of this script
  // wrote its failure line with Write-Output and returned $null: the caller's `$deviceName` held the
  // diagnostic sentence, `-not $deviceName` was therefore false, the failure branch never ran, and the
  // message was never printed either -- the script went on to ask for the mode of a device called
  // "context: MonitorFromPoint found no primary monitor". A function that both reports and returns can do
  // neither here, and the trap is invisible at the diff.
  const { body } = scriptParts();
  const resolver = /function Get-PrimaryDisplayName \{[\s\S]*?\n\}/.exec(body)?.[0];
  assert.ok(resolver, "Get-PrimaryDisplayName is gone from set-display-mode.ps1");
  assert.doesNotMatch(resolver!, /Write-Output/,
    "Get-PrimaryDisplayName must not Write-Output: its output IS its return value, so a printed line "
    + "comes back to the caller as the device name and the caller's own failure check never fires");
  assert.match(resolver!, /\$Reason\.Value = /,
    "positive control for the line above -- the refusal has to be reported SOMEHOW, and [ref] $Reason is "
    + "the way that does not collide with the return value");
  assert.match(body, /Get-PrimaryDisplayName -Reason \(\[ref\] \$\w+\)/,
    "the caller must pass the [ref] and so be able to print the refusal it fills in");
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

/**
 * EVERYTHING ABOVE THIS LINE READS THE SCRIPT AS TEXT, AND TEXT CANNOT ANSWER THE QUESTION BELOW.
 *
 * reviewer-2's blocker on #1968 at `a58c7e44`: the same-API positive control was in the file and did not
 * run. A textual assertion cannot tell "the control is written" from "the control ran" -- it is the same
 * distinction the first verdict named at `:204`, one level up. So these tests hand the real script to a
 * real PowerShell, with the one Windows API it needs replaced by a stub whose population is settable, and
 * read what it actually wrote. `display-mode-harness.ps1` carries the how and why.
 *
 * `pwsh` is REQUIRED, and these tests fail rather than skip when it is missing. A control that quietly
 * does not run is the exact defect this whole section exists to answer, and writing that defect into the
 * test for it would be the same mistake with a longer fuse. GitHub's ubuntu runners ship PowerShell 7.6.5,
 * so CI has it; `A11Y_PWSH` names a different binary where it is not on PATH.
 */
const PWSH = process.env.A11Y_PWSH ?? "pwsh";
const HARNESS = fileURLToPath(new URL("./display-mode-harness.ps1", import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL("./provisioning/set-display-mode.ps1", import.meta.url));
// `Get-ModuleFunctionScriptBlock`, which returns a function's literal text from the PARSED file. Imported
// rather than retyped: a second copy of a predicate drifts from the first.
const AST_HELPERS = fileURLToPath(new URL(
  "../../control/ansible/collections/ansible_collections/a11y/worker/tests/unit/plugins/modules/TestHelpers.psm1",
  import.meta.url));

function pwsh(args: string[]): string {
  const run = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", ...args], { encoding: "utf8" });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    assert.fail(`no PowerShell at \`${PWSH}\`, and these tests do not skip without one. Install it (`
      + "`curl -sSL https://github.com/PowerShell/PowerShell/releases/latest` -> the linux-x64 tar.gz, "
      + "extracted anywhere) and either put `pwsh` on PATH or set A11Y_PWSH to the binary. The tests "
      + "below are the only thing here that can tell a control that RAN from one that was merely written");
  }
  assert.equal(run.status, 0, `${PWSH} exited ${run.status}:\n${run.stderr}`);
  return run.stdout;
}

interface Enumeration {
  name: string;
  nullDevices: number;
  namedDevices: number;
  primary: string | null;
  /** What `EnumDisplayDevices` was asked for at index 0, per call: `NULL` or the quoted device name. */
  askedFor: string[];
  lines: string[];
}

let harnessOutput: Enumeration[] | undefined;

/** Every scenario, run once -- the harness is one pwsh start, and four of them is three too many. */
function enumerations(): Enumeration[] {
  harnessOutput ??= JSON.parse(pwsh(
    ["-File", HARNESS, "-ScriptPath", SCRIPT_PATH, "-HelperModule", AST_HELPERS])) as Enumeration[];
  return harnessOutput;
}

function scenario(name: string): Enumeration {
  const found = enumerations().find((run) => run.name === name);
  assert.ok(found, `display-mode-harness.ps1 no longer runs a '${name}' scenario -- named explicitly so a `
    + "rename there fails loudly rather than silently testing nothing");
  return found!;
}

/** The number the script CLAIMED it enumerated, read back off its own output line. */
function claimed(run: Enumeration, unit: "adapter" | "monitor"): number | undefined {
  const claim = run.lines.map((line) => new RegExp(`enumerated (\\d+) ${unit}\\(s\\)`).exec(line))
    .find((match) => match !== null);
  return claim ? Number(claim[1]) : undefined;
}

test("set-display-mode.ps1 PARSES -- the whole file, under a real PowerShell", () => {
  // Found by running the thing: at `0c4f39b1d` this file had FOURTEEN parse errors and every test here
  // was green, because every test here matched text. `Write-Output ("a"` followed by a line starting
  // `+ "b"` is not a continuation in PowerShell -- a complete expression ends at the newline, so the
  // operator has to END the previous line. A script that cannot be parsed does nothing at all on a
  // worker, and the next fleet run is a poor place to learn that.
  const errors = pwsh(["-Command",
    "$parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile("
    + `'${SCRIPT_PATH}', [ref] $null, [ref] $parseErrors); `
    + "$parseErrors | ForEach-Object { $_.ToString() }"]);
  assert.equal(errors.trim(), "",
    `set-display-mode.ps1 does not parse:\n${errors}\nNothing else in this file can catch that -- a `
    + "syntax error leaves every textual assertion here passing over a script Windows will refuse to run");
});

test("the nameless arm passes a REAL null, never PowerShell's empty string", () => {
  // PowerShell binds `$null` to a `string` parameter as `[string]::Empty`; only `[NullString]::Value`
  // sends a genuine NULL. That is what the stub records, so this is measured at the boundary rather than
  // inferred from the script's source. The previous version of this script asked every "default device"
  // question with `""` -- a device no machine has -- which is the cheaper explanation for the ten-host
  // failure that #1968's first telling missed entirely.
  for (const run of enumerations()) {
    assert.equal(run.askedFor[0], "NULL",
      `the '${run.name}' scenario asked EnumDisplayDevices for ${run.askedFor[0]} rather than NULL: the `
      + "nameless arm is asking about a device NAMED \"\", so the whole reading is about the wrong call");
  }
});

test("the count Write-DisplayDevices reports IS the count of devices it enumerated", () => {
  // reviewer-2's blocker, and the defect was worse than the report. `Get-EnumeratedDevices` returned
  // `,$lines` while the caller counted `@(...)`: PowerShell's unary comma emits the collection as ONE
  // pipeline object, so `.Count` was 1 for EVERY population -- measured 0 -> 1, 1 -> 1, 3 -> 1. The
  // non-empty case is the half no fleet reading can supply, because every real worker measured so far
  // enumerates nothing, which is exactly the population that cannot tell a broken counter from a good one.
  const many = scenario("nonEmptyNull");
  const deviceLines = many.lines.filter((line) => /^context: device\[/.test(line));
  assert.equal(deviceLines.length, many.nullDevices,
    `the stub gave ${many.nullDevices} devices and the script printed ${deviceLines.length} lines`);
  assert.equal(claimed(many, "adapter"), deviceLines.length,
    `the script printed ${deviceLines.length} device lines and claimed ${claimed(many, "adapter")}: a `
    + "count that crosses a function boundary as a collection is a count of the wrapper");
  assert.ok(!many.lines.some((line) => /enumerated NOTHING/.test(line)),
    "a non-empty enumeration must not also claim it found nothing");
});

test("the same-API control RUNS when the nameless enumeration comes back empty", () => {
  // The invariant blocker 2 asked for, asserted on behaviour: with the NULL arm empty, the NAMED arm has
  // to have been CALLED, and its own outcome has to reach the message. The old code returned before ever
  // reaching it, which is why "the control is in the file" was true and worthless.
  const empty = scenario("emptyNullAnsweringControl");
  assert.equal(empty.askedFor.length, 2,
    `the control did not run: EnumDisplayDevices was asked ${JSON.stringify(empty.askedFor)}, and an `
    + "empty population with no same-API control cannot tell an absent display from a refused call");
  assert.match(empty.askedFor[1]!, /DISPLAY1/,
    "the control has to be the SAME API given a device NAME -- a different API answers a different question");
  assert.equal(claimed(empty, "monitor"), empty.namedDevices,
    "the control's own outcome has to be the number it actually enumerated");
  assert.equal(claimed(empty, "adapter"), undefined,
    "an empty nameless enumeration must never report an adapter population -- that claim is the defect");
});

test("when the control refuses too, the script says so instead of claiming the stronger finding", () => {
  // The other half of the same invariant, and the one that keeps this honest: a refusing control means
  // the reading is about the FUNCTION, not about the argument, and over-claiming there is what the
  // should-fix on #1968 was about.
  const both = scenario("emptyNullRefusingControl");
  assert.equal(both.askedFor.length, 2, "the control must still be attempted when the NULL arm is empty");
  assert.ok(both.lines.some((line) => /the control refused too/.test(line)),
    `both arms enumerated nothing and the script wrote: ${JSON.stringify(both.lines)}`);

  const unnameable = scenario("emptyNullNoControlPossible");
  assert.equal(unnameable.askedFor.length, 1,
    "with no primary device name there is nothing to control WITH, so the named call must not be invented");
  assert.ok(unnameable.lines.some((line) => /no NAMED control could be run/.test(line)),
    `no control was possible and the script wrote: ${JSON.stringify(unnameable.lines)}`);
});

test("every empty-population claim in the harness output names the control's own outcome", () => {
  // The runtime twin of the textual invariant above: over the real output lines rather than the source.
  const claims = enumerations().flatMap((run) => run.lines.filter((line) => /enumerated NOTHING/.test(line)));
  assert.ok(claims.length > 0,
    "positive control for the loop below -- no scenario produced an empty-population claim at all, so "
    + "this test passes over nothing");
  for (const claim of claims) {
    assert.match(claim, /NAMED/,
      `this line claims an empty enumeration without naming the control's own outcome: ${claim}`);
  }
});
