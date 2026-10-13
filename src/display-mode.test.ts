// Relocated from control/src/fleet-layer/display-mode.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * THE `set-display-mode.ps1` SOURCE TESTS.
 *
 * These assert on the SCRIPT'S TEXT because there is no Windows host here to run it on: it calls Win32
 * display APIs through P/Invoke and needs an interactive window station. A text assertion cannot say the
 * script WORKS, only that a given call is still declared and still made, so every assertion below is split
 * across the P/Invoke declarations and the executable body (`scriptParts`), and the split carries its own
 * positive control.
 *
 * What stays with the Ansible role's owner: the tests that read `defaults/main.yml`, `display.yml` and
 * `tasks.yml`, and the ones that run the script under a real PowerShell through `display-mode-harness.ps1`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SET_DISPLAY_MODE_SCRIPT = readFileSync(
  new URL("./provisioning/set-display-mode.ps1", import.meta.url), "utf8");

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

test("set-display-mode.ps1 reads its width/height from the environment, never a hardcoded value", () => {
  assert.match(SET_DISPLAY_MODE_SCRIPT, /\$env:A11Y_DISPLAY_WIDTH/,
    "set-display-mode.ps1 must read A11Y_DISPLAY_WIDTH -- display.yml sets it from worker_display_mode.width");
  assert.match(SET_DISPLAY_MODE_SCRIPT, /\$env:A11Y_DISPLAY_HEIGHT/,
    "set-display-mode.ps1 must read A11Y_DISPLAY_HEIGHT -- display.yml sets it from worker_display_mode.height");
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

test("the script's read-back exits 1 on a mismatch, so a caller can surface the failure", () => {
  // Split out of control's logon-task test, whose other assertions read tasks.yml: `powershell.exe -Command`
  // ends 0 unless the script signals, so a task can only surface what the script's own exit code says.
  const { body } = scriptParts();
  assert.match(body, /dmPelsWidth -ne \$Width -or [^\n]*dmPelsHeight -ne \$Height\)\s*\{[^}]*exit 1/,
    "the script's read-back must exit 1 on a mismatch -- the task can only surface what the script signals");
});
