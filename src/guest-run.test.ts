// The elevated-execution channel. Both traps encoded here produced WRONG ANSWERS today rather than
// errors, which is why they are pinned by tests rather than left to a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleCommand, wrapScript, isComplete, DONE_SENTINEL } from "./guest-run.mjs";

test("the schedule command is a single string, with the script path quoted", () => {
  // Trap 1: `utmctl exec ... -- a b c` passes a, b, c as SEPARATE argv entries. A command containing
  // parentheses, & or quotes gets split across them and cmd receives fragments. A reg query written
  // that way reported "key not found" for a key that existed, and nearly turned a real configuration
  // drift into a dismissed false alarm.
  const cmd = scheduleCommand({ scriptPath: "C:\\Users\\witness\\a11y-witness\\trim.cmd" });
  assert.equal(typeof cmd, "string");
  assert.match(cmd, /\/tr "C:\\Users\\witness\\a11y-witness\\trim\.cmd"/, "path must be quoted — it has spaces");
  assert.match(cmd, /\/ru SYSTEM \/rl HIGHEST/, "elevation is the whole point");
  assert.match(cmd, /schtasks \/run/, "registering without running does nothing");
});

test("a scheduled task is used, not start /b", () => {
  // Trap 2: a detached child dies with the exec that spawned it. `start /b` returned exit 0 with no
  // output and the child never ran — indistinguishable from success. The Task Scheduler service owns
  // the process instead, so it survives.
  const cmd = scheduleCommand({ scriptPath: "C:\\x.cmd" });
  assert.ok(!cmd.includes("start /b"), "start /b children do not survive the exec");
  assert.match(cmd, /^schtasks \/create/);
});

test("the wrapper always ends with the sentinel", () => {
  // Without it there is no way to tell "still running" from "died on line one" — which is exactly how
  // a trim that crashed immediately looked identical to one in progress, for three consecutive boots.
  const wrapped = wrapScript("echo hello", "C:\\out.txt");
  assert.ok(wrapped.trimEnd().endsWith(`echo ${DONE_SENTINEL}`));
  assert.ok(wrapped.includes("echo hello"), "the caller's body survives");
});

test("the wrapper uses CRLF, because cmd.exe requires it", () => {
  // A .cmd with bare LF line endings fails in ways that look like syntax errors in the caller's script.
  const wrapped = wrapScript("echo one\necho two", "C:\\out.txt");
  assert.ok(wrapped.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(wrapped), "every newline must be preceded by a carriage return");
});

test("the wrapper truncates the output file first, so a stale result cannot be re-read", () => {
  // Re-reading the PREVIOUS run's output and believing it is the classic stale-diagnostic failure this
  // repo already hit with utmctl exec returning days-old files.
  assert.match(wrapScript("echo x", "C:\\out.txt"), /> C:\\out\.txt echo === guest-run ===/);
});

test("a duplicated @echo off from the caller is dropped", () => {
  const wrapped = wrapScript("@echo off\necho x", "C:\\out.txt");
  assert.equal(wrapped.match(/@echo off/g)?.length, 1);
});

test("completion is judged by the sentinel, not by the file existing", () => {
  assert.equal(isComplete(`=== guest-run ===\nworking...\n${DONE_SENTINEL}`), true);
  assert.equal(isComplete("=== guest-run ===\nworking..."), false, "partial output is not completion");
  assert.equal(isComplete(""), false);
  assert.equal(isComplete(null as never), false, "no file at all is not completion");
});
