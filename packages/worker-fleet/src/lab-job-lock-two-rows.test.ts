/**
 * #1829 (Gap 1 of #1817's precondition list): does the per-job-name lock in `tasks/run-job.yml` serialise
 * TWO DIFFERENT fleet-gated rows dispatching the same job name, or only a literal repeat of one?
 *
 * `packages/control/CLAUDE.md`: "a job of a given name is refused, not killed, while one is running" — the
 * unit name (`a11y-job-{{ job_name }}`) is the lock. Before this file, `lab-job.test.ts`'s "a running job
 * is refused, not killed" pinned that claim as TEXT — the shape of the guard, never that it actually
 * serialises two dispatches carrying different, row-specific arguments. That was fine while one session
 * dispatched at a time; #1817 makes a second session (`worker-capture`) able to dispatch `job=capture` at
 * the same moment `orchestrator` might, so "has this ever been exercised as two different rows" stops
 * being hypothetical.
 *
 * This exercises the REAL `tasks/run-job.yml`, unmodified, twice — with two different `job_argv`/
 * `job_setenv` payloads standing in for two rows' distinct `--dataset=`/`--shard=` arguments, the same job
 * NAME both times — and proves, by running it, that:
 *   1. the second dispatch is refused BEFORE it ever runs its own job body (never silently dropped, never
 *      interleaved with the first's output),
 *   2. the refusal names the unit and a retry command, and
 *   3. the first dispatch's own progress file is untouched by the second's attempt.
 *
 * It runs against `ansible-playbook` for real, with `systemctl`/`systemd-run`/`journalctl` replaced by
 * small fakes on `PATH` — no root, no real systemd unit, no fleet. No test in this repo has spawned a real
 * `ansible-playbook` before (every other ansible test here reads the YAML as text); this is the one claim
 * in this row that static text cannot establish, because it is a claim about what happens when two
 * dispatches actually race, not about what the file says.
 *
 * CI's `ts`/`trunk` jobs never install `ansible-core` (only the separate `ansible` syntax-check job does,
 * and it runs no node tests) — so this test SKIPS, honestly, wherever `ansible-playbook` is not on `PATH`,
 * the same pattern `npm run test:python` already uses for `pytest`. It ran for real in the sandbox that
 * built it. The real fleet's own two-dispatch proof — actual `lab:job` invocations against real boxes — is
 * `orchestrator`'s to run and report, per this row's own "does the acceptance need the fleet" answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./git-safe-env.mjs";

const RUN_JOB_PATH = fileURLToPath(new URL("../../control/ansible/tasks/run-job.yml", import.meta.url));
const RUN_JOB_TEXT = readFileSync(RUN_JOB_PATH, "utf8");

const HAS_ANSIBLE = spawnSync("ansible-playbook", ["--version"]).status === 0;
const SKIP_REASON = [
  "ansible-playbook is not on PATH -- this proof needs it. An honest skip, not a pass, ",
  "matching `npm run test:python`'s own pattern for a missing pytest. CI's ts/trunk jobs never install ",
  "ansible-core; run this locally or in a session that has it to exercise the real claim.",
].join("");

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
set -euo pipefail
STATE="$FAKE_SYSTEMD_STATE"
cmd="$1"; shift
case "$cmd" in
  show)
    props=(); unit=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -p) props+=("$2"); shift 2 ;;
        --value) shift ;;
        *) unit="$1"; shift ;;
      esac
    done
    dir="$STATE/$unit"
    for p in "\${props[@]}"; do
      case "$p" in
        SubState) [ -f "$dir/substate" ] && cat "$dir/substate" || echo dead ;;
        Result) [ -f "$dir/result" ] && cat "$dir/result" || echo success ;;
        ExecMainStatus) [ -f "$dir/execmainstatus" ] && cat "$dir/execmainstatus" || echo 0 ;;
        InvocationID) echo "fakeinv-$unit" ;;
      esac
    done
    ;;
  reset-failed) exit 0 ;;
  stop) exit 0 ;;
  list-units)
    for d in "$STATE"/*/; do
      [ -d "$d" ] || continue
      u=$(basename "$d")
      if [ -f "$d/substate" ] && [ "$(cat "$d/substate")" = "running" ]; then
        echo "$u.service loaded active running $u"
      fi
    done
    ;;
  *) exit 0 ;;
esac
`;

// A JOB LAUNCHED IN THE BACKGROUND, exactly as the real `systemd-run` parents work to PID 1: the caller
// gets an invocation id back immediately, and the job's own exit is read later by polling `substate`.
const FAKE_SYSTEMD_RUN = `#!/usr/bin/env bash
set -uo pipefail
STATE="$FAKE_SYSTEMD_STATE"
unit=""
wd="."
setenvs=()
argv=()
dashdash=false
for arg in "$@"; do
  if $dashdash; then argv+=("$arg"); continue; fi
  case "$arg" in
    --unit=*) unit="\${arg#--unit=}" ;;
    --working-directory=*) wd="\${arg#--working-directory=}" ;;
    --setenv=*) setenvs+=("\${arg#--setenv=}") ;;
    --) dashdash=true ;;
    *) ;;
  esac
done
dir="$STATE/$unit"
mkdir -p "$dir"
echo running > "$dir/substate"
rm -f "$dir/result" "$dir/execmainstatus"
(
  cd "$wd"
  env "\${setenvs[@]}" "\${argv[@]}" > "$dir/stdout.log" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then echo success > "$dir/result"; else echo exit-code > "$dir/result"; fi
  echo "$code" > "$dir/execmainstatus"
  echo exited > "$dir/substate"
) &
disown
echo "Running as unit: \${unit}.service; invocation ID: fakeinv-\${unit}"
`;

const FAKE_JOURNALCTL = `#!/usr/bin/env bash
set -uo pipefail
STATE="$FAKE_SYSTEMD_STATE"
invid=""
for arg in "$@"; do
  case "$arg" in
    _SYSTEMD_INVOCATION_ID=*) invid="\${arg#_SYSTEMD_INVOCATION_ID=}" ;;
  esac
done
unit="\${invid#fakeinv-}"
dir="$STATE/$unit"
[ -f "$dir/stdout.log" ] && cat "$dir/stdout.log" || echo "(no output)"
`;

const JOB_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
echo "START $ROW_LABEL $*" >> "$PROGRESS_FILE"
sleep "\${SLEEP_SECS:-1}"
echo "DONE $ROW_LABEL $*" >> "$PROGRESS_FILE"
`;

/** Fake `systemctl`/`systemd-run`/`journalctl` on a scratch `bin/`, so no root and no real unit is needed. */
function writeFakeSystemd(bin: string) {
  writeFileSync(join(bin, "systemctl"), FAKE_SYSTEMCTL, { mode: 0o755 });
  writeFileSync(join(bin, "systemd-run"), FAKE_SYSTEMD_RUN, { mode: 0o755 });
  writeFileSync(join(bin, "journalctl"), FAKE_JOURNALCTL, { mode: 0o755 });
}

/** A scratch git checkout at `tmp/repo`, tracking `tmp/origin.git` -- something real for run-job.yml's own
 * fetch/checkout tasks to act on. Returns the checkout's path. */
function setupFixtureRepo(tmp: string): string {
  const originDir = join(tmp, "origin.git");
  const repoDir = join(tmp, "repo");
  const gitEnv = sandboxGitEnv({ HOME: tmp });
  const git = (args: string[], cwd: string) => {
    const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git(["init", "-q", "--bare", "-b", "main", originDir], tmp);
  git(["clone", "-q", originDir, repoDir], tmp);
  git(["config", "user.email", "a@b.c"], repoDir);
  git(["config", "user.name", "test"], repoDir);
  writeFileSync(join(repoDir, "README.md"), "fixture\n");
  git(["add", "README.md"], repoDir);
  git(["commit", "-q", "-m", "init"], repoDir);
  git(["push", "-q", "origin", "main"], repoDir);
  return repoDir;
}

/** The wrapper play that includes the REAL, unmodified `run-job.yml` directly against `hosts: localhost`. */
function writeWrapperPlaybook(tmp: string, repoDir: string) {
  writeFileSync(join(tmp, "wrapper.yml"), `---
- name: exercise run-job.yml's lock directly
  hosts: localhost
  connection: local
  gather_facts: false
  vars:
    lab_repo_path: "${repoDir}"
    lab_runs_path: "/tmp"
  tasks:
    - name: run it
      ansible.builtin.include_tasks: "${RUN_JOB_PATH}"
`);
}

/** One row's dispatch vars: a distinct --dataset/--shard, but the SAME job name every time. Returns the
 * `@<path>` extra-vars file path `ansible-playbook -e` takes. */
function writeRowVars(tmp: string, spec: { progressFile: string, label: string, dataset: string,
  shard: string, sleepSecs: number, jobScript: string }): string {
  const path = join(tmp, `vars-${spec.label}.json`);
  writeFileSync(path, JSON.stringify({
    job_name: "capture",
    job_timeout: 30,
    pull: false,
    job_argv: ["/bin/bash", spec.jobScript, `--dataset=${spec.dataset}`, `--shard=${spec.shard}`],
    job_setenv: [`PROGRESS_FILE=${spec.progressFile}`, `ROW_LABEL=${spec.label}`, `SLEEP_SECS=${spec.sleepSecs}`],
  }));
  return path;
}

const POLL_INTERVAL_MS = 50;
const RUNNING_TIMEOUT_MS = 15_000;

/** Poll the fake unit's `substate` file until it reads `running`, or give up. */
async function waitUntilRunning(unitDir: string) {
  const deadline = Date.now() + RUNNING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(join(unitDir, "substate"))
      && readFileSync(join(unitDir, "substate"), "utf8").trim() === "running") return;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

/** Row A: started and left running in the background, exactly like a real dispatch nobody waits beside. */
function dispatchInBackground(tmp: string, varsPath: string, runEnv: NodeJS.ProcessEnv) {
  const child = spawn("ansible-playbook", ["wrapper.yml", "-e", `@${varsPath}`], { cwd: tmp, env: runEnv });
  let output = "";
  child.stdout.on("data", (d) => { output += String(d); });
  child.stderr.on("data", (d) => { output += String(d); });
  const done = new Promise<number | null>((res) => child.on("close", (code) => res(code)));
  return { done, output: () => output };
}

test("the unit name is derived from job_name ALONE -- never from job_argv or job_setenv", () => {
  // The property that makes "two different rows collide" true at all: if the lock ever incorporated any
  // row-specific value (a dataset, a shard, a worker), two different rows would get two different locks
  // and never contend -- which is the literal-duplicate-only claim this row exists to move past.
  assert.match(RUN_JOB_TEXT, /job_unit:\s*"a11y-job-\{\{\s*job_name\s*\}\}"/,
    "the unit name must be exactly a11y-job-<job_name>, with nothing else folded in");
  const settleBlock = RUN_JOB_TEXT.slice(
    RUN_JOB_TEXT.indexOf("Settle the defaults"), RUN_JOB_TEXT.indexOf("What is this unit doing right now"));
  assert.ok(!/job_argv|job_setenv|dataset|shard|worker/.test(settleBlock),
    "job_unit's own derivation must not reference argv, setenv, a dataset, a shard or a worker -- any of "
    + "those would let two different rows avoid the lock instead of colliding on it");
});

test("the refusal happens before ANY task that could touch the checkout or start a job", () => {
  // Pins the ORDERING claim the real-execution test below depends on: the assert must fire strictly
  // before `git fetch`/checkout and before `systemd-run`, so a refused second dispatch can never have
  // written anything, race a checkout, or start its own unit under the name the first still holds.
  const refuse = RUN_JOB_TEXT.indexOf("Refuse to start a second");
  const fetch = RUN_JOB_TEXT.indexOf("Fetch origin");
  const checkout = RUN_JOB_TEXT.indexOf("Fast-forward to origin");
  const start = RUN_JOB_TEXT.indexOf("Start it:");
  assert.ok(refuse > 0 && refuse < fetch && refuse < checkout && refuse < start,
    "the refusal must come before fetch, before checkout, and before dispatch");
});

test("two DIFFERENT rows, one job name: the second is refused before it runs, and never touches the first's progress file", { skip: HAS_ANSIBLE ? undefined : SKIP_REASON }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-job-lock-two-rows-"));
  try {
    const bin = join(tmp, "bin");
    const state = join(tmp, "state");
    mkdirSync(bin);
    mkdirSync(state);
    writeFakeSystemd(bin);
    const repoDir = setupFixtureRepo(tmp);
    writeWrapperPlaybook(tmp, repoDir);

    const jobScript = join(tmp, "job.sh");
    writeFileSync(jobScript, JOB_SCRIPT, { mode: 0o755 });

    const progressFile = join(tmp, "progress.log");
    const runEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SYSTEMD_STATE: state };
    // Two DIFFERENT rows: distinct --dataset/--shard, the SAME job name ("capture") both times.
    const varsA = writeRowVars(tmp,
      { progressFile, label: "row-1829-a", dataset: "alpha", shard: "0/4", sleepSecs: 2, jobScript });
    const varsB = writeRowVars(tmp,
      { progressFile, label: "row-1829-b", dataset: "beta", shard: "2/4", sleepSecs: 1, jobScript });

    const rowA = dispatchInBackground(tmp, varsA, runEnv);
    // Wait for row A's fake unit to actually be running before dispatching row B -- a fixed sleep would
    // either race row A (flaky) or pad every run with dead time.
    const unitDir = join(state, "a11y-job-capture");
    await waitUntilRunning(unitDir);
    assert.equal(existsSync(join(unitDir, "substate")) && readFileSync(join(unitDir, "substate"), "utf8").trim(),
      "running", "row A never reached 'running' -- the harness itself is broken, not the lock");

    // Row B: a DIFFERENT row, same job name, dispatched while row A is still running.
    const rowB = spawnSync("ansible-playbook", ["wrapper.yml", "-e", `@${varsB}`],
      { cwd: tmp, env: runEnv, encoding: "utf8" });
    const rowBOutput = `${rowB.stdout}\n${rowB.stderr}`;

    // Refused, not silently dropped and not queued-forever: a real exit code the caller can act on.
    assert.notEqual(rowB.status, 0, "row B (a different row, same job name) must be refused, not accepted");
    assert.match(rowBOutput, /a11y-job-capture is already running/,
      "the refusal must name the unit two different rows collided on");
    assert.match(rowBOutput, /This is the lock working, not a fault/);
    // "refused with a message naming retry" -- the acceptance's own words.
    assert.match(rowBOutput, /journalctl -u a11y-job-capture/);
    assert.match(rowBOutput, /systemctl stop a11y-job-capture/);
    // Never reached dispatch: row B's own job body (which would print "row-1829-b") never ran.
    assert.ok(!rowBOutput.includes("Start it: capture"),
      "row B must be refused BEFORE the task that would start its job, not after");
    assert.ok(!rowBOutput.includes("row-1829-b"), "row B's own job body must never have run at all");

    // Row A finishes on its own, unaffected by row B's refused attempt.
    const rowAExit = await rowA.done;
    assert.equal(rowAExit, 0, `row A must complete normally: ${rowA.output()}`);
    assert.match(rowA.output(), /capture completed \(success, exit 0\)/);

    // The progress file is row A's alone -- never dropped, never corrupted, never interleaved.
    const progress = readFileSync(progressFile, "utf8");
    assert.equal(progress,
      "START row-1829-a --dataset=alpha --shard=0/4\nDONE row-1829-a --dataset=alpha --shard=0/4\n",
      `row B must never have written to row A's progress file: ${JSON.stringify(progress)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
