/**
 * The two properties of the lab job runner that a future edit could break in perfect silence.
 *
 * Neither is checkable by `ansible-playbook --syntax-check`, and both were measured on the real container
 * rather than reasoned about — which is why they are worth pinning rather than trusting a comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../ansible/${name}`, import.meta.url)), "utf8");

/**
 * The file with its comments stripped.
 *
 * These assertions are about what the tasks DO, and both of these files explain at length why they do not
 * use `systemctl is-active` or `--collect` — so asserting on the raw text failed on its own documentation.
 * A guard that a correct comment can break is a guard that gets weakened rather than fixed.
 */
const executable = (text: string) => text
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

const RUN_JOB = executable(read("tasks/run-job.yml"));
const LAB_JOB = executable(read("lab-job.yml"));

test("the waiter polls SubState, never `systemctl is-active`", () => {
  // Measured on the lab: with `--remain-after-exit` an exited unit stays `active (exited)` for good, so
  // `is-active` returns true forever and a waiter written that way hangs indefinitely reporting "still
  // running" for a finished job. That is the original incident this whole change set exists to remove,
  // and the first waiter written here reproduced it.
  assert.match(RUN_JOB, /until: job_state\.stdout/,
    "the wait must be a polled `until`, not a sleep");
  assert.match(RUN_JOB, /-p", SubState/, "the poll must read SubState");
  assert.ok(!/is-active/.test(RUN_JOB),
    "`systemctl is-active` cannot distinguish exited from running under --remain-after-exit");
});

test("--remain-after-exit is set, and --collect is not", () => {
  // A collected unit is unloaded on exit and takes its exit code with it, so the handle vanishes at the
  // moment it matters. Verified both ways on the container: `exit 42` leaves
  // `Result=exit-code ExecMainStatus=42` rather than disappearing.
  assert.match(RUN_JOB, /--remain-after-exit/);
  assert.ok(!/--collect/.test(RUN_JOB), "--collect would discard the exit code this file exists to read");
});

test("the outcome is read AFTER the wait, never before it", () => {
  // `Result` and `ExecMainStatus` are populated while a job is still running — observed
  // `Result=success ExecMainStatus=0` on a job seven minutes from finishing. Reading them first reports
  // success for work in flight, which is this repo's "404 and 202 are different answers" rule again.
  const wait = RUN_JOB.indexOf("Wait for it to finish");
  const collect = RUN_JOB.indexOf("Collect its result");
  assert.ok(wait > 0 && collect > wait,
    "the result must be collected after the poll, or it reports on a job that is still going");
});

test("a running job is refused, not killed", () => {
  // The lock has to distinguish "somebody else's work is in flight" (refuse) from "a previous run left an
  // unreaped handle" (reset and proceed). Stopping to make room would destroy hours.
  const refuse = RUN_JOB.indexOf("Refuse to start a second");
  const stop = RUN_JOB.indexOf("Release the exited unit");
  assert.ok(refuse > 0 && stop > refuse, "the refusal must come before anything stops the unit");
  assert.match(RUN_JOB, /that: job_before\.stdout \| trim != "running"/);
});

test("there is no way to pass a command — only a job NAME from the catalogue", () => {
  // This plays against the box holding the corpus, the corpus deploy key, the release weights and
  // `fleet:wake`. `ansible/README.md` rejected a mutating route on a WORKER as "unauthenticated remote
  // code execution on twelve boxes"; a free-form command parameter here would be strictly worse, since
  // executing code is the point. Ansible being agentless removes the route — this keeps it removed.
  assert.ok(!/\{\{\s*command\s*\}\}/.test(LAB_JOB), "no `command` variable may reach argv");
  assert.ok(!/ansible\.builtin\.shell/.test(LAB_JOB + RUN_JOB), "no task may invoke a shell");
  assert.match(RUN_JOB, /ansible\.builtin\.command/, "argv-only, so quoting cannot be got wrong");
  assert.match(LAB_JOB, /job in lab_jobs/, "the job name must be checked against the catalogue");
});

test("a capture job names a worker from the inventory rather than taking a URL", () => {
  // `--worker=http://:8765` cost 29 minutes. Resolving a NAME through the inventory makes a malformed
  // address inexpressible rather than merely rejected — the same shape as `isValidCaptureId`.
  assert.match(LAB_JOB, /worker in groups\['a11y_workers'\]/);
  assert.match(LAB_JOB, /hostvars\[worker[^\]]*\]\.ansible_host/);
});

test("the environment is fixed by the runner, never supplied by the caller", () => {
  // `A11Y_PYTHON` is read at four sites in this repo and becomes the executed interpreter, so an env
  // passthrough is arbitrary code execution with a whitelisted job name and an empty argv.
  assert.match(RUN_JOB, /--setenv=PYTHONUNBUFFERED=1/,
    "without this a six-minute job shows nothing in journalctl until it exits");
  assert.ok(!/\{\{\s*job_env\s*\}\}/.test(RUN_JOB), "no caller-supplied environment may reach the child");
});

test("a job's environment additions come from the CATALOGUE, never from an extra var", () => {
  // `job_setenv` widens what can reach the child, so it needs the same scrutiny as `job_argv`. The rule it
  // must keep: the VALUE is a checked-in catalogue entry, and the one entry that exists is built from the
  // inventory and asserted before use. A caller still supplies only a job name and enumerated arguments.
  assert.match(RUN_JOB, /job_setenv \| default\(\[\]\)/,
    "a job with no setenv must contribute nothing, not an empty string argument");
  // Every setenv value in the catalogue must be a template over inventory-derived facts or a literal --
  // never a bare `{{ something }}` a caller could set with -e.
  for (const [, value] of LAB_JOB.matchAll(/setenv:\s*\[([^\]]*)\]/g)) {
    for (const [, expression] of value.matchAll(/\{\{\s*([a-z_]+)[^}]*\}\}/g)) {
      assert.equal(expression, "lab_fleet_workers",
        `setenv may only interpolate asserted facts; found ${expression}`);
    }
  }
});

test("the pooled corpus job addresses the whole fleet, and the value is proved before it is used", () => {
  // Extra vars have the highest precedence in Ansible, so a fact referenced from the catalogue is reachable
  // by `-e` even when it reads as inventory-derived. The assert is what makes an injected A11Y_WORKERS
  // inexpressible rather than merely unlikely -- the `--worker=http://:8765` lesson, which cost 29 minutes,
  // applied to the environment instead of to argv.
  assert.match(LAB_JOB, /A11Y_WORKERS=\{\{ lab_fleet_workers \}\}/,
    "the corpus capture must reach every worker, or the fleet sits idle for ~17.7 h instead of ~4.4 h");
  assert.match(LAB_JOB, /groups\['a11y_workers'\]\s*\n?\s*\| map\('extract', hostvars, 'ansible_host'\)/,
    "the addresses must come from the inventory, which ADR 0012 makes the single source of truth");
  assert.match(LAB_JOB, /lab_fleet_workers is match\('\^http:\/\/\[0-9\.\]\+:8765/,
    "and must be proved to be exactly an address list before it becomes an environment variable");

  const built = LAB_JOB.indexOf("lab_fleet_workers: >-");
  const proved = LAB_JOB.indexOf("lab_fleet_workers is match");
  const used = LAB_JOB.indexOf("Run {{ job }}");
  assert.ok(built < proved && proved < used,
    "build, then prove, then use — asserting after dispatch would prove nothing");
});

test("evidence-check takes ONE worker, by name, and a bounded sample", () => {
  // Single worker on purpose, unlike `capture`: this asks whether the evidence MOVED, so a second guest is
  // a second variable and a CHANGED verdict could not be told from "a different box took that case".
  assert.match(LAB_JOB, /evidence-check:/);
  assert.match(LAB_JOB, /when: job == 'evidence-check'/, "its arguments must be validated like any other");
  assert.match(LAB_JOB, /worker in groups\['a11y_workers'\]/);
  assert.match(LAB_JOB, /\(sample \| default\(24\)\) \| int <= 200/,
    "an unbounded sample is an unbounded run on hardware somebody else may want");
  // It runs under tsx because it applies gates that live in TypeScript, and from the binary rather than
  // `npx`, so a job cannot turn into a package install on the box holding the corpus.
  assert.ok(!/npx/.test(LAB_JOB), "no job may invoke npx");
});
