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

// Row A's job stays running until the TEST writes its release file, not for a fixed number of seconds
// (#2598): row B's `ansible-playbook` must reach the lock check while A is still running, and how long B
// takes to get there depends on the runner's load (a merge-queue run was ejected when a 2s sleep expired
// first). The timeout is generous and only exists so a hung test still ends -- and fails, exit 1, with a
// message the test reads through A's own output.
const JOB_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
echo "START $ROW_LABEL $*" >> "$PROGRESS_FILE"
deadline=$((SECONDS + RELEASE_TIMEOUT_SECS))
until [ -f "$RELEASE_FILE" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then echo "never released after $RELEASE_TIMEOUT_SECS s" >&2; exit 1; fi
  sleep 0.1
done
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
  shard: string, releaseFile: string, jobScript: string }): string {
  const path = join(tmp, `vars-${spec.label}.json`);
  writeFileSync(path, JSON.stringify({
    job_name: "capture",
    // Ansible polls the unit every 10s for job_timeout/10 retries, so this must outlast however long row A
    // is held running -- the fake unit ignores RuntimeMaxSec, and a poll budget shorter than the hold
    // would fail row A's own dispatch rather than exercise the lock.
    job_timeout: 600,
    pull: false,
    job_argv: ["/bin/bash", spec.jobScript, `--dataset=${spec.dataset}`, `--shard=${spec.shard}`],
    job_setenv: [`PROGRESS_FILE=${spec.progressFile}`, `ROW_LABEL=${spec.label}`, `RELEASE_FILE=${spec.releaseFile}`,
      `RELEASE_TIMEOUT_SECS=${RELEASE_TIMEOUT_SECS}`],
  }));
  return path;
}

const POLL_INTERVAL_MS = 50;
const RUNNING_TIMEOUT_MS = 15_000;
const RELEASE_TIMEOUT_SECS = 120;
/** Longer than the 2s row A used to live for (#2598), so a regression to a fixed lifetime cannot pass it. */
const PAST_OLD_LIFETIME_MS = 3_000;

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


type Dispatch = ReturnType<typeof dispatchInBackground>;
type TwoRows = { tmp: string, runEnv: NodeJS.ProcessEnv, progressFile: string, releaseA: string,
  varsB: string, rowA: Dispatch };

/** Row A running in the background (held there by its release file), row B's vars written, nothing else
 * started. Runs `body` and always releases A and reaps it before the scratch dir goes, so a failed
 * assertion cannot leave A's ansible-playbook polling a directory that no longer exists. */
async function withRowARunning(body: (rows: TwoRows) => Promise<void>) {
  const tmp = mkdtempSync(join(tmpdir(), "lab-job-lock-two-rows-"));
  let rowA: Dispatch | undefined;
  const releaseA = join(tmp, "release-row-1829-a");
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
    // ANSIBLE_HOME (default `$HOME/.ansible`) is where `local_tmp`, the galaxy cache and everything else
    // ansible-core writes outside the working directory live -- #1829's PR review: a sandbox whose `$HOME`
    // is read-only outside its own cwd/`/tmp` (Codex, sandbox_mode=workspace-write) leaves ansible unable
    // to create its own local temp dir there, which this test's fixed poll budget below reads as "row A
    // never reached running". Redirected into this test's own writable scratch dir, which every sandbox
    // that can run this test at all can already write to -- the same reasoning `sandboxGitEnv({ HOME: tmp
    // })` above already applies to the git calls.
    //
    // `remote_tmp` is a SEPARATE setting from `local_tmp` -- ansible's shell plugin doc fragment
    // (`ansible/plugins/doc_fragments/shell_common.py`) gives it its own default (`~/.ansible/tmp`) and its
    // own env vars (`ANSIBLE_REMOTE_TEMP`/`ANSIBLE_REMOTE_TMP`), and `HOME`/`ANSIBLE_HOME` do not reach it:
    // confirmed with `-vvvv` against this exact host's ansible-core -- even with `HOME` redirected, a
    // `connection: local` task's remote-side `mkdir -p` still targeted the REAL ambient `$HOME/.ansible/tmp`
    // until `ANSIBLE_REMOTE_TEMP` was set explicitly. `connection: local` still goes through the shell
    // plugin's remote_tmp staging even though the "remote" is the same host as the controller.
    const ansibleHome = join(tmp, "ansible-home");
    const remoteTmp = join(tmp, "ansible-remote-tmp");
    mkdirSync(ansibleHome);
    mkdirSync(remoteTmp);
    const runEnv = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SYSTEMD_STATE: state,
      HOME: tmp, ANSIBLE_HOME: ansibleHome, ANSIBLE_REMOTE_TEMP: remoteTmp, ANSIBLE_REMOTE_TMP: remoteTmp,
    };
    // Two DIFFERENT rows: distinct --dataset/--shard, the SAME job name ("capture") both times. Row B's
    // release file is never written: its job body must never run at all.
    const varsA = writeRowVars(tmp,
      { progressFile, label: "row-1829-a", dataset: "alpha", shard: "0/4", releaseFile: releaseA, jobScript });
    const varsB = writeRowVars(tmp, { progressFile, label: "row-1829-b", dataset: "beta", shard: "2/4",
      releaseFile: join(tmp, "release-row-1829-b"), jobScript });

    rowA = dispatchInBackground(tmp, varsA, runEnv);
    // Wait for row A's fake unit to actually be running before dispatching row B -- a fixed sleep would
    // either race row A (flaky) or pad every run with dead time.
    const unitDir = join(state, "a11y-job-capture");
    await waitUntilRunning(unitDir);
    assert.equal(existsSync(join(unitDir, "substate")) && readFileSync(join(unitDir, "substate"), "utf8").trim(),
      "running",
      `row A never reached 'running' within ${RUNNING_TIMEOUT_MS}ms -- its own ansible-playbook output so `
      + `far, which is the harness (or its environment), not the lock:\n${rowA.output()}`);

    await body({ tmp, runEnv, progressFile, releaseA, varsB, rowA });
  } finally {
    writeFileSync(releaseA, "");
    await rowA?.done;
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Row B: a DIFFERENT row, same job name, dispatched while row A is still running. */
function dispatchRowB(rows: TwoRows) {
  const rowB = spawnSync("ansible-playbook", ["wrapper.yml", "-e", `@${rows.varsB}`],
    { cwd: rows.tmp, env: rows.runEnv, encoding: "utf8" });
  return { status: rowB.status, output: `${rowB.stdout}\n${rowB.stderr}` };
}

function assertRowBRefused(rowB: { status: number | null, output: string }) {
  // Refused, not silently dropped and not queued-forever: a real exit code the caller can act on.
  assert.notEqual(rowB.status, 0, "row B (a different row, same job name) must be refused, not accepted");
  assert.match(rowB.output, /a11y-job-capture is already running/,
    "the refusal must name the unit two different rows collided on");
  assert.match(rowB.output, /This is the lock working, not a fault/);
  // "refused with a message naming retry" -- the acceptance's own words.
  assert.match(rowB.output, /journalctl -u a11y-job-capture/);
  assert.match(rowB.output, /systemctl stop a11y-job-capture/);
  // Never reached dispatch: row B's own job body (which would print "row-1829-b") never ran.
  assert.ok(!rowB.output.includes("Start it: capture"),
    "row B must be refused BEFORE the task that would start its job, not after");
  assert.ok(!rowB.output.includes("row-1829-b"), "row B's own job body must never have run at all");
}

/** Row A finishes on its own once released, unaffected by row B's refused attempt. */
async function assertRowAFinishesUnaffected(rows: TwoRows) {
  writeFileSync(rows.releaseA, "");
  const rowAExit = await rows.rowA.done;
  assert.equal(rowAExit, 0, `row A must complete normally: ${rows.rowA.output()}`);
  assert.match(rows.rowA.output(), /capture completed \(success, exit 0\)/);

  // The progress file is row A's alone -- never dropped, never corrupted, never interleaved.
  const progress = readFileSync(rows.progressFile, "utf8");
  assert.equal(progress,
    "START row-1829-a --dataset=alpha --shard=0/4\nDONE row-1829-a --dataset=alpha --shard=0/4\n",
    `row B must never have written to row A's progress file: ${JSON.stringify(progress)}`);
}

test("two DIFFERENT rows, one job name: the second is refused before it runs, and never touches the first's progress file", { skip: HAS_ANSIBLE ? undefined : SKIP_REASON }, async () => {
  await withRowARunning(async (rows) => {
    assertRowBRefused(dispatchRowB(rows));
    await assertRowAFinishesUnaffected(rows);
  });
});

// #2598's POSITIVE CONTROL: row A's lifetime used to be a literal `sleep 2`, so a row B dispatched later
// than that (a loaded runner) reached the lock check after A was gone and was correctly ACCEPTED -- the test
// failed although the lock had not. With A held by its release file, however long B takes, it is refused;
// restore a fixed 2s lifetime in JOB_SCRIPT and this is the case that turns red.
test("two DIFFERENT rows, one job name: the second is refused however long its dispatch takes after the first is running", { skip: HAS_ANSIBLE ? undefined : SKIP_REASON }, async () => {
  await withRowARunning(async (rows) => {
    await new Promise((res) => setTimeout(res, PAST_OLD_LIFETIME_MS));
    assertRowBRefused(dispatchRowB(rows));
    await assertRowAFinishesUnaffected(rows);
  });
});
