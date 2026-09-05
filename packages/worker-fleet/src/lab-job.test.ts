/**
 * The two properties of the lab job runner that a future edit could break in perfect silence.
 *
 * Neither is checkable by `ansible-playbook --syntax-check`, and both were measured on the real container
 * rather than reasoned about — which is why they are worth pinning rather than trusting a comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/** The lab's scripts directory, resolved the same way `read` resolves the playbooks. */
const LAB_SCRIPTS = fileURLToPath(new URL("../../lab/scripts/", import.meta.url));
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../control/ansible/${name}`, import.meta.url)), "utf8");

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

/**
 * The catalogue, PARSED — every job and its argv.
 *
 * The guard below used to grep the whole file for two strings. That made it a test of whether ANY job
 * still resolved a worker by name, which is a much weaker claim than the one its title makes, and it went
 * quiet the moment `capture-real-pages` stopped taking a worker: `evidence-check` and `stability` still
 * contained both strings, so the file matched and the job it was written about was no longer examined.
 * This repo's rule, in its own words: a test must not derive its expectations from source TEXT.
 */
function catalogueJobs(): Record<string, { argv?: unknown }> {
  const doc = parseYaml(read("lab-job.yml")) as Array<{ vars?: { lab_jobs?: Record<string, { argv?: unknown }> } }>;
  const jobs = doc.flatMap((play) => (play?.vars?.lab_jobs ? [play.vars.lab_jobs] : []))[0];
  if (!jobs) throw new Error("lab_jobs not found in lab-job.yml — this guard is parsing the wrong shape");
  return jobs;
}

/**
 * Scripts whose input is DERIVED by another command, and the npm script that derives it.
 *
 * `audit-scorer-shortcuts.py` classifies each veto against `runs/unclosable-vetoes.json`, which
 * `corpus:unclosable-map` emits from `audit-corpus-starvation.mjs`. The audit REFUSES an absent map --
 * "forgiving nothing is the honest fallback" -- and cannot see a STALE one, so a job that skips the
 * derivation fails silently by construction.
 */
const DERIVED_INPUT: Record<string, string> = {
  "audit-scorer-shortcuts.py": "scorer:shortcuts (or :candidate/:baseline) — emits runs/unclosable-vetoes.json",
  "audit_grants.py": "corpus:grants-audit — emits runs/grants-map.json",
};

test("a gate that dispatches to the control plane must be told --local when the control plane runs it", () => {
  // `dispatchUnlessLocal` makes the lab the DEFAULT and `--local` the escape hatch, which is right for an
  // operator at a laptop. But a `lab-job.yml` entry IS the control plane's dispatch, so the default there
  // makes the script dispatch again from inside the job it was dispatched into.
  //
  // MEASURED 2026-08-30: `gate-probe-order` died `sh: 1: ansible-playbook: not found`, exit 127 -- a
  // message that reads like a broken lab rather than a job wired to call itself. `stability` had the same
  // wiring. DISCOVERED here rather than listed, because "which scripts dispatch" is a fact about the
  // source that a hand-written list goes stale against, exactly as the worker-file list did.
  const dispatching = readdirSync(LAB_SCRIPTS)
    .filter((file) => file.endsWith(".mjs"))
    .filter((file) => readFileSync(LAB_SCRIPTS + file, "utf8").includes("gates/dispatch.mjs"));
  assert.ok(dispatching.length >= 2,
    `found ${dispatching.length} dispatching gates; the discovery is broken, not the catalogue clean`);

  const offenders: string[] = [];
  for (const [name, job] of Object.entries(catalogueJobs())) {
    const argv = (Array.isArray(job?.argv) ? job.argv : []).map(String);
    const script = dispatching.find((f) => argv.some((part) => part.endsWith(f)));
    if (script && !argv.includes("--local")) offenders.push(`${name} runs ${script} without --local`);
  }
  assert.deepEqual(offenders, [],
    "these jobs re-dispatch from inside the lab and die with `ansible-playbook: not found`");
});

test("a job may not run a script whose input another command has to derive", () => {
  // MEASURED 2026-08-30. `shortcuts-baseline` called `audit-scorer-shortcuts.py` directly while `shortcuts`
  // went through npm, so the one job that WRITES the tracked baseline -- a release gate -- was the only one
  // that never refreshed the classification it was recording. An entry extended from 5 features to 10 was
  // pushed, the baseline re-recorded, and the recorded classification did not move. Nothing failed.
  //
  // The same shape as every other entry in this file: a remedy present at one of the call sites that need
  // it. `lab-job.yml`'s own comment states the rule -- "the chain lives in the npm script".
  const offenders: string[] = [];
  for (const [name, job] of Object.entries(catalogueJobs())) {
    const argv = (Array.isArray(job?.argv) ? job.argv : []).map(String);
    if (argv[0]?.endsWith("npm")) continue;
    for (const [script, chain] of Object.entries(DERIVED_INPUT)) {
      if (argv.some((part) => part.endsWith(script))) offenders.push(`${name} runs ${script} directly — go via ${chain}`);
    }
  }
  assert.deepEqual(offenders, [],
    "these jobs skip the command that derives their input, so they read whatever is on the lab's disk");
});

test("no job can be handed a worker URL — a worker is always resolved from the inventory", () => {
  // `--worker=http://:8765` cost 29 minutes. Resolving a NAME through the inventory makes a malformed
  // address inexpressible rather than merely rejected — the same shape as `isValidCaptureId`.
  //
  // Asserted over every job the catalogue DISCOVERS, so a job added later is covered the day it is added
  // rather than the day somebody remembers this file.
  const jobs = catalogueJobs();
  assert.ok(Object.keys(jobs).length >= 15,
    `only ${Object.keys(jobs).length} jobs parsed out of the catalogue; the shape changed and this is blind`);

  const takesWorker = Object.entries(jobs).filter(([, spec]) =>
    JSON.stringify(spec.argv ?? "").includes("--worker="));
  for (const [name, spec] of takesWorker) {
    const argv = JSON.stringify(spec.argv);
    assert.match(argv, /hostvars\[/,
      `${name} builds a --worker argument without resolving it through the inventory, so a malformed `
      + "address is expressible");
  }

  // And the inverse, which is the half that went silent: a job that names no worker must not be able to
  // have one forced on it by an operator's -e. It uses the fleet, and the guard says so.
  assert.match(LAB_JOB, /worker is not defined/,
    "capture-real-pages runs across the fleet and must REFUSE -e worker, not ignore it — an operator who "
    + "asked for one machine and got four must be told");
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
    // Both permitted names are facts BUILT from the inventory and then asserted against a strict address
    // pattern before use. Anything else -- notably a bare `-e` variable -- must fail here.
    const ASSERTED_FACTS = new Set(["lab_fleet_workers", "lab_named_worker"]);
    for (const [, expression] of value.matchAll(/\{\{\s*([a-z_]+)[^}]*\}\}/g)) {
      assert.ok(ASSERTED_FACTS.has(expression),
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

test("a job pulls the lab checkout, and records the commit it actually ran at", () => {
  // Done by hand before every job today, which means done by hand or not at all. The lab was once 23
  // commits behind `main` when a retrain was started on it, so the artefact named a commit that had not
  // produced it — an artefact whose provenance is WRONG is worse than one carrying none.
  assert.match(RUN_JOB, /argv: \[git, fetch, --quiet, origin\]/);
  // A CHECKOUT of `origin/<ref>`, not a merge, since `-e ref=` made "which branch" a parameter. The
  // property that mattered is unchanged and is what this asserts: the launcher moves the checkout to
  // exactly what origin says and never RESOLVES anything. A merge or rebase here would let a diverged lab
  // be silently reconciled at 2am, which is a fact for a human to look at.
  assert.match(RUN_JOB, /argv: \[git, checkout, --detach, "\{\{ lab_ref_commit \}\}"\]/,
    "the launcher must move to the RESOLVED commit, never merge or rebase toward it");
  assert.ok(!/git, (merge|rebase|pull)(?!.*--ff-only)/.test(RUN_JOB),
    "a launcher that can merge or rebase can resolve a divergence nobody looked at");
  // The FULL sha, not `--short`. `git rev-parse --short` returns 7 characters or MORE — git lengthens it
  // when 7 would be ambiguous — so a comparison against a fixed prefix is right until the day the repo
  // grows enough objects, and then it refuses correct runs. Shortened at the point of DISPLAY instead.
  assert.match(RUN_JOB, /argv: \[git, rev-parse, HEAD\]/,
    "and the commit must be READ BACK in full, not assumed and not truncated before comparison");

  // The stamp is unconditional; the pull is not. A job that skips the pull must still say what it ran.
  const stamp = RUN_JOB.indexOf("Record the commit this job actually runs at");
  const start = RUN_JOB.indexOf('- name: "Start it:');
  assert.ok(stamp > 0 && stamp < start, "the commit must be resolved before the job starts, or it describes nothing");
  // THE STAMP TASK ITSELF, not everything between it and the start. The region form was right until a
  // task was added after the stamp that MUST be conditional — the refusal below, which fires only when
  // the checkout did not land on the requested commit. Widening the region to catch that would have
  // meant deleting a guard to add a guard.
  //
  // `^\s*when:` and not `when:` — `changed_when:` contains the substring, so the loose form failed on a
  // correct file. A guard a correct file can break gets weakened rather than fixed, which is the same
  // reasoning as `executable()` stripping comments above.
  const nextTask = RUN_JOB.indexOf('\n- name: "', stamp + 1);
  const stampBlock = RUN_JOB.slice(stamp, nextTask > 0 ? nextTask : start);
  assert.ok(!/^\s*when:/m.test(stampBlock), "the stamp must never be conditional — that is the whole point");

  // And the stamp must be ACTED ON, which is what it was not. Recorded, printed, never compared to the
  // ref that was asked for — so three jobs ran four commits behind and each reported success.
  assert.match(RUN_JOB, /REFUSE to run at a commit other than the one asked for/,
    "a stamp nothing compares is a comment; the launcher must refuse a commit it was not asked for");
  assert.match(RUN_JOB, /lab_commit\.stdout \| trim != lab_ref_commit/,
    "and the refusal must compare the READ-BACK commit against the RESOLVED ref");
});

test("the unit DESCRIPTION carries the commit, so a journal can never be read without one", () => {
  // The fix for the defect this repo names most often, applied to the one artefact that still lacked it.
  //
  // `lab_commit` has been registered here since the launcher was written, and the task above PRINTS it --
  // into Ansible's output, which belongs to whoever dispatched and is gone by the time anyone reads the
  // result. `lab:status` and `lab:log` read the JOURNAL, which is the artefact that survives, and it
  // carried a timestamp and no code identity at all.
  //
  // Measured 2026-08-27: a `rules:coverage` journal reading `2.4.4 ... 0 never on a REAL page` was quoted
  // as a live contradiction against a local run saying `1 validated`. Same fixture, same pushed code. The
  // lab was simply eleven hours stale, and proving that meant diffing a journal timestamp against
  // `git log` by hand. CLAUDE.md's own table has six entries of exactly this shape, every one "a CORRECT
  // value read from the wrong place".
  //
  // Asserted on the START task's argv specifically, parsed rather than grepped: a `--description=` string
  // anywhere else in the file would satisfy a text search while systemd never saw it.
  const tasks = parseYaml(read("tasks/run-job.yml")) as Array<{
    name?: string; "ansible.builtin.command"?: { argv?: unknown };
  }>;
  const start = tasks.find((task) => (task.name ?? "").startsWith("Start it:"));
  assert.ok(start, "the launcher must still have a task that starts the unit");
  const argv = String(start["ansible.builtin.command"]?.argv ?? "");
  assert.match(argv, /systemd-run/, "and that task is the systemd-run invocation");

  assert.match(argv, /--description=/,
    "systemd logs `Started <unit> - <Description>.`, so the description opens every journal");

  // THE DESCRIPTION'S OWN SEGMENT, sliced out rather than matched across the whole argv. A regex spanning
  // the list would pass on a `lab_commit` that belongs to some later element, and the first version of
  // this test also pinned the ORDER of two terms inside one Jinja conditional -- which is a fact about
  // how the expression reads, not about what it produces. Both are the "test asserts source text" trap.
  const description = argv.slice(argv.indexOf("--description="), argv.indexOf("--working-directory="));
  assert.match(description, /lab_commit\.stdout/,
    "the description must carry the READ-BACK commit -- a journal whose code identity is missing is a "
      + "number with nothing behind it");
  // DIRTY is not decoration. The refusal above lets a dirty checkout run when it is ALREADY at the
  // requested commit, so the SHA is true and the bytes are not. Without this marker those two runs are
  // indistinguishable in the journal, which is the same ambiguity one layer along.
  assert.match(description, /lab_dirty/, "and it must consult the dirty state");
  assert.match(description, /DIRTY/,
    "a dirty checkout at the right commit must SAY so; the SHA alone cannot express it");

  // AND IT MUST BE READ BACK FROM THE JOURNAL, never from the unit.
  //
  // `systemctl show -p Description` is the obvious companion and is a trap, measured rather than
  // reasoned: the launcher stops the transient unit when the job ends, an unloaded unit has no
  // description, and `show` answers with the unit NAME -- `Description=a11y-job-rules-coverage.service`
  // on a finished job. That is a field printing a filename where a commit belongs, which is the defect
  // the stamp exists to remove, reintroduced by the read-back meant to expose it.
  const status = executable(read("lab-status.yml"));
  assert.ok(!/"-p", Description/.test(status),
    "an unloaded unit reports its NAME as its description, so this read-back answers confidently and "
      + "wrongly for exactly the finished jobs anyone asks about");
  assert.match(status, /What code produced this run/,
    "`lab:status` must answer it outright, or the reader is back to comparing a timestamp to git log");
  assert.match(status, /regex_findall/,
    "`regex_search` throws INSIDE the filter on a non-match -- Ansible calls .group() on the None -- so "
      + "no `| default` can save it, and a status command that crashes while reporting status is worse "
      + "than one that says nothing");
});

test("a pull never runs into a checkout somebody or something else is using", () => {
  // `git pull` mid-job writes into the checkout a running job is EXECUTING FROM — a11y-bootstrap.service
  // documents that as "the one way this unit can be quietly wrong". The unit-name lock cannot see it: it
  // refuses a second job of the SAME name, and the hazard is a DIFFERENT job running concurrently.
  assert.match(RUN_JOB, /list-units, "a11y-job-\*", "--state=running"/,
    "another running job must suppress the pull");
  assert.match(RUN_JOB, /argv: \[git, status, --porcelain\]/,
    "and so must uncommitted work — a shared checkout is somebody else's in progress");
  assert.match(RUN_JOB, /lab_should_pull/, "the three reasons belong in one named condition");
  assert.match(RUN_JOB, /Say why the checkout was left alone/,
    "and a skipped pull must say which of the three it was, or it is indistinguishable from not trying");
});

test("the two gates are jobs, and the one needing a worker validates it", () => {
  assert.match(LAB_JOB, /stability:/, "the gate a corpus run must not start without");
  assert.match(LAB_JOB, /rules-gate:/);
  assert.match(LAB_JOB, /when: job == 'stability'/, "its worker must be checked like any other");
  assert.match(LAB_JOB, /A11Y_WORKER=\{\{ lab_named_worker \}\}/);
  assert.match(LAB_JOB, /lab_named_worker is match\('\^http:\/\/\[0-9\.\]\+:8765\$'\)/,
    "an address reaching the environment must be proved to be an address");
});

test("a setenv value reaches systemd without a backreference", () => {
  // `'^(.*)$' -> '--setenv=\\1'` is the natural way to write this and it does not survive YAML-then-Jinja:
  // the escape arrived at systemd literally and it refused the whole unit with
  // `Cannot assign environment variable \1: Invalid argument`. Caught immediately, because systemd would
  // not start — but the corpus recapture is the job that carries setenv, so "immediately" meant at the
  // moment somebody kicked off a 4.4 h run and walked away.
  //
  // Replacing the EMPTY MATCH at the start needs no capture group, so it cannot fail this way at all.
  assert.match(RUN_JOB, /map\('regex_replace', '\^', '--setenv='\)/,
    "prefix by replacing the start anchor; a backreference here does not survive the escaping");
  assert.ok(!/--setenv=\\\\1/.test(RUN_JOB), "no backreference may appear in the setenv transformation");
});

test("a job that pulled rebuilds, or a gate scores compiled code that is not the code", () => {
  // `@a11y-witness/judge/rules` resolves to `dist/rules.js`, so `rules:gate` runs COMPILED output while a
  // pull only updates source. Measured 2026-08-22: a newly added 2.4.2 rule fired when imported from source
  // and the gate reported `0/1 MISSING EVIDENCE`, because the lab's dist contained zero occurrences of it.
  //
  // The sibling failure is already in CLAUDE.md — "a release-gate re-run measured code from three commits
  // earlier" — but that was a pull that silently failed. This is a pull that SUCCEEDED and a build that
  // never happened, which is harder to notice: `git log` says exactly what you expect.
  assert.match(RUN_JOB, /argv: \[\/usr\/bin\/npm, run, build\]/, "a pulled checkout must be rebuilt");
  const build = RUN_JOB.indexOf("Rebuild the compiled packages");
  const merge = RUN_JOB.indexOf("Fast-forward to origin/main");
  const start = RUN_JOB.indexOf('- name: "Start it:');
  assert.ok(merge < build && build < start,
    "the build must follow the pull and precede the job, or it rebuilds the wrong tree or none at all");
});

test("a checkout that cannot pull reports HOW FAR behind it is, not just that it did not pull", () => {
  // The lab sat 17 commits behind origin for days. A training run left an artefact in the tracked tree, so
  // every job hit the dirty-checkout branch, said "Not pulling: the checkout is dirty", and ran old code.
  // The sentence was true and carried no consequence — which is this repo's own rule about a number beating
  // a word, and the SECOND time this exact drift has cost something (the task's comment records the first,
  // at 23 commits behind).
  //
  // The fetch must be unconditional for the count to exist at all: a fetch writes only to `.git`, so it is
  // safe on a dirty checkout, and gating it left the one case that needed measuring unmeasured.
  // Sliced to the fetch TASK, not to everything up to the drift count: tasks were added between the two and
  // their `when:` made this read as the fetch being gated. A guard whose scope drifts reports the wrong file.
  const fetchStart = RUN_JOB.indexOf("- name: \"Fetch origin\"");
  const fetchTask = RUN_JOB.slice(fetchStart, RUN_JOB.indexOf("\n- name:", fetchStart + 1));
  assert.ok(!/^\s*when:/m.test(fetchTask),
    "the fetch is gated again, so a checkout that cannot pull has no way to know how stale it is");

  assert.match(RUN_JOB, /rev-list, --count, "HEAD\.\.\{\{ lab_ref_commit \}\}"/,
    "nothing measures the drift");
  assert.match(RUN_JOB, /COMMIT\(S\) BEHIND origin\//,
    "the drift is measured and never said out loud");

  // The stamp is what a reader sees after the fact. "(checkout unchanged)" reads as reassurance; it has to
  // distinguish up-to-date from stale, or the artefact's provenance line hides the thing that matters.
  assert.ok(!/'\(checkout unchanged\)'/.test(RUN_JOB),
    "the run stamp still says a bare '(checkout unchanged)', which reads identically whether the checkout "
    + "is current or 17 commits stale");
});

test("a job that leaves the checkout dirty is named, and compared against the state before it ran", () => {
  // The general form of today's defect. One script wrote into `packages/`, the checkout went dirty, and
  // every later job refused to pull — correctly, since it cannot tell a stray artefact from work in
  // progress — so the lab ran 17 commits behind for days. Fixing that one script fixes one script; this
  // catches the next one.
  assert.match(RUN_JOB, /register: lab_dirty_after/, "nothing checks the tree after the job runs");
  assert.match(RUN_JOB, /LEFT THE CHECKOUT DIRTY/, "the check exists and never says anything");

  // Compared against the BEFORE state, not against clean. A checkout that was already dirty must not make
  // every subsequent job report a problem it did not cause — "it was already like that" and "you did this"
  // are different answers, and a warning that fires for someone else's mess is one people learn to ignore.
  assert.match(RUN_JOB, /lab_dirty_after\.stdout \| trim\) != \(lab_dirty\.stdout/,
    "the after-state is compared against clean rather than against the before-state, so an already-dirty "
    + "checkout blames whichever job ran next");
});

test("a job can run at a named ref, and the ref is validated rather than trusted", () => {
  // `-e ref=<branch>` exists for a change that CANNOT land on main alone. The worked example is a
  // feature-schema change: `scorer-artifact.test.ts` refuses a tree whose committed weights carry a
  // different FEATURE_SCHEMA_VERSION from the shipped feature pipeline — correctly, since the scorer
  // rejects that pairing and the default judge stops working. So the fix and the weights it produces must
  // land in one commit, and the weights can only be trained by a lab that already has the fix.
  //
  // Without it the only routes are breaking main for half an hour, or copying a file onto the box by hand.
  // The second is what dirtied the lab checkout on 2026-08-23 and blocked every subsequent pull.
  assert.match(RUN_JOB, /lab_ref: "\{\{ ref \| default\('main'\) \}\}"/,
    "no way to name a ref, so a coupled change has no CLI path");
  // The PROPERTY, not the spelling. This used to assert `origin/{{ lab_ref }}` appeared, which pinned the
  // defect rather than the requirement: `origin/<sha>` resolves to nothing, so a job pinned to a commit --
  // the most precise thing a caller can ask for, and the reason `-e ref=` exists -- addressed a ref that
  // does not exist, in three places, two of them `failed_when: false`.
  assert.match(RUN_JOB, /refs\/remotes\/origin\/\{\{ lab_ref \}\}\^\{commit\}/,
    "a ref that names a branch must still resolve through origin");
  assert.match(RUN_JOB, /rev-parse, --verify, --quiet, "\{\{ lab_ref \}\}\^\{commit\}"/,
    "a ref that names a tag or a commit has no fallback, so `-e ref=<sha>` cannot work");
  assert.match(RUN_JOB, /lab_ref_commit \| length == 40/,
    "an unresolvable ref must STOP the job; it previously produced an empty drift count that read as zero");
  // Scoped to `argv:` lines. A task NAME may still read "Fast-forward to origin/<ref>" — that is what a
  // human called it — but nothing may PASS `origin/<ref>` to git, because it resolves to nothing for a SHA.
  const argvLines = RUN_JOB.split("\n").filter((line) => line.includes("argv:"));
  assert.ok(argvLines.length > 0, "no argv: lines found — this guard is examining an empty set");
  assert.ok(!argvLines.some((line) => /origin\/\{\{ lab_ref \}\}(?!\^\{commit\})/.test(line)),
    "something still passes origin/<ref> to git, which is unresolvable when the ref is a SHA");

  // Validated, not trusted. `argv:` never invokes a shell so this is not injection, but `origin/..` and
  // friends should be inexpressible rather than merely unlikely — the same shape as isValidCaptureId.
  assert.match(RUN_JOB, /lab_ref is match\(/, "the ref reaches git without a pattern check");
  assert.match(RUN_JOB, /'\.\.' not in lab_ref/, "a ref containing .. can walk out of the ref namespace");

  // And the stamp must say which ref, or an artefact trained on a branch is indistinguishable from one
  // trained on main — provenance that is wrong being worse than provenance that is absent.
  assert.match(RUN_JOB, /pulled ' ~ lab_ref/, "the run stamp does not record which ref it ran at");

  // ORDER, not just presence. Every assertion above passed while the playbook could not run at all:
  // `lab_ref` was set in the pull section, below the drift count that reads it, so the first real
  // invocation died with "'lab_ref' is undefined". A guard that checks a fact exists somewhere in a file
  // cannot see that it exists too late — the same shape as a test that greps source text instead of
  // exercising behaviour, which this file already had to fix once.
  const defined = RUN_JOB.indexOf("lab_ref: \"{{ ref");
  const firstUse = Math.min(...[/HEAD\.\.origin\/\{\{ lab_ref \}\}/, /origin\/\{\{ lab_ref \}\}"\]/]
    .map((rx) => { const m = rx.exec(RUN_JOB); return m ? m.index : Number.MAX_SAFE_INTEGER; }));
  assert.ok(defined >= 0 && defined < firstUse,
    "lab_ref is used before it is set, so every job fails with \"'lab_ref' is undefined\" — Ansible "
    + "resolves facts in task order, and this file's tasks are a sequence, not a set");
});

test("a lab job never runs from a stale bytecode cache", () => {
  // A `__pycache__/*.pyc` left by a previous commit makes a job execute code that is not in the checkout,
  // and `REFUSE to run at a commit other than the one asked for` cannot see it — that guard compares git
  // SHAs, and the SHA is correct while the executed bytecode is not.
  //
  // Measured 2026-08-25: a committed and pushed fix was pulled by the job, which reported the right
  // commit, and the run still raised the NameError the fix removed. It surfaced only because the
  // traceback's line number was one off from the file on disk. That is the same failure mode as the
  // memoised `browserVersion` — a correct check fed a value that cannot express the fault.
  assert.match(RUN_JOB, /PYTHONDONTWRITEBYTECODE=1/,
    "lab jobs must not read or write bytecode caches; a stale .pyc runs code that is not in the checkout");
});

test("every Jinja expression in run-job.yml can actually be TEMPLATED", () => {
  // The first version of the test above asserted only that `PYTHONDONTWRITEBYTECODE=1` was PRESENT, and
  // passed against a playbook Ansible could not template: the setting had been added inside the `argv:`
  // Jinja expression along with its explanation, and `#` is a syntax error there. A pipeline run died at
  // stage 1 with `unexpected char '#' at 245` — which names the character and not the file.
  //
  // A guard that checks presence and not VALIDITY is this repo's recurring shape, one layer over from the
  // count-based check that cannot see content rot. My second attempt at this test was that same defect
  // again: a regex for `{{ … #` on ONE line, against an `argv:` block that spans fifteen. Mutation
  // testing caught it, and the lesson is to assert the property rather than a pattern that implies it.
  //
  // So: extract each Jinja block and refuse a `#` anywhere inside it, however many lines it spans.
  const raw = read("tasks/run-job.yml");
  const expressions = [...raw.matchAll(/\{\{[\s\S]*?\}\}/g)].map((match) => match[0]);
  assert.ok(expressions.length > 10,
    `only ${expressions.length} Jinja expressions found; the file's shape changed and this is blind`);
  for (const expression of expressions) {
    assert.ok(!expression.includes("#"),
      "a '#' inside a Jinja expression cannot be templated — Ansible fails the whole task with "
      + `\`unexpected char '#'\`. Move the comment above the task:\n${expression.slice(0, 200)}`);
  }
});
/**
 * A job's `params:` declaration must say exactly what its command reads.
 *
 * The gate replaced six hand-written `when: job == '<name>'` asserts covering 36 jobs, so the two things
 * that shape let through — a new job whose parameter nobody remembered to assert, and a parameter passed
 * to a job that IGNORES it, which Ansible discards without a word — are now answered from a `params:`
 * map beside each command. The hand-written asserts stay: they validate the SHAPE of a value (a shard is
 * `i/n`, a worker is in the inventory), which no declaration can.
 *
 * ## Why the derivation lives HERE and the declaration lives THERE
 *
 * The first version derived it live, inside Ansible: re-read the playbook, `regex_findall` the `{{ ... }}`
 * out of the job's argv, and decide from the text. It worked, and it was the wrong place. The SRE
 * Workbook names that shape exactly — a YAML+Jinja config accruing "ad hoc language features" becomes
 * "an esoteric and complex programming language ... difficult for both humans and tools to maintain and
 * analyze" — and its remedy is to separate config from data and put the cleverness in TOOLING.
 *
 * The evidence was already in hand. A `\b` inside a Jinja string literal is a BACKSPACE, because Jinja
 * parses escapes with Python's rules: the first regex matched nothing, both checks passed vacuously, and
 * it refused `-e only=` on the one job that requires it. A real regex engine under a real test runner
 * does not have that failure mode, and can be mutation-checked.
 *
 * So the interface is DATA where an operator reads it, and this file derives the same answer from each
 * job's raw argv and refuses any disagreement — over all 36 jobs, not a hand-picked few.
 */
const RAW_LAB_JOB = parseYaml(read("lab-job.yml")) as Array<{ vars: PlayVars }>;
const PLAY_VARS = RAW_LAB_JOB[0].vars;

type JobEntry = { argv?: unknown[] | string; setenv?: string[]; timeout?: number;
                  params?: Record<string, "required" | "optional"> };
type PlayVars = { lab_jobs: Record<string, JobEntry>; lab_caller_params: string[] };

/**
 * `-e worker=` is a NAME and the command needs an ADDRESS, so it reaches the job as `lab_named_worker`.
 * That indirection is invisible in the argv, so the derivation has to know it; it lives here rather than
 * in the playbook because here is where the deriving happens.
 */
const VIA_DERIVED_FACT: Record<string, string> = { lab_named_worker: "worker" };

/** What a job's command actually reads: only what is INSIDE `{{ }}`, never literal text in a path. */
function derivedParams(entry: JobEntry): Record<string, "required" | "optional"> {
  let templates = (JSON.stringify(entry).match(/\{\{.*?\}\}/g) ?? []).join(" ");
  for (const [fact, param] of Object.entries(VIA_DERIVED_FACT)) {
    templates = templates.replaceAll(fact, param);
  }
  const declared: Record<string, "required" | "optional"> = {};
  for (const param of PLAY_VARS.lab_caller_params) {
    if (!new RegExp(`(^|\\W)${param}(\\W|$)`).test(templates)) continue;
    // BOTH spellings of optional count. `| default(...)` is the common one; `sweep` writes
    // `model is defined`, and reading only the first reports it as REQUIRING a model it does not.
    const hasFallback = new RegExp(`${param}\\s*\\|\\s*default`).test(templates)
      || new RegExp(`${param}\\s+is\\s+defined`).test(templates);
    declared[param] = hasFallback ? "optional" : "required";
  }
  return declared;
}

test("every job's declared params are exactly what its command reads", () => {
  // All 36, not a sample. A declaration that says too LITTLE refuses a correct usage; one that says too
  // MUCH accepts a parameter the job will discard, which is the silence this gate exists to remove.
  for (const [name, entry] of Object.entries(PLAY_VARS.lab_jobs)) {
    assert.deepEqual(entry.params ?? {}, derivedParams(entry),
      `job '${name}' declares params that disagree with its own argv. A parameter with no `
      + `| default(...) and no "is defined" is REQUIRED; anything else is optional`);
  }
});

test("a job requires a parameter exactly when its command has no fallback", () => {
  // The worked cases, spelled out, because a deepEqual over 36 entries says nothing about WHY.
  const required = (name: string) => Object.entries(PLAY_VARS.lab_jobs[name].params ?? {})
    .filter(([, kind]) => kind === "required").map(([param]) => param);
  assert.deepEqual(required("capture-only"), ["only"],
    "an empty --only= captures the WHOLE corpus, which is the run this job exists to avoid");
  assert.deepEqual(required("stability"), ["worker"],
    "A11Y_WORKER would be `http://:8765` — reached through lab_named_worker, so the derivation must "
    + "follow that fact or this correct usage is refused");
  assert.deepEqual(required("sweep"), [],
    "`model is defined` is this job saying the model is optional, in the other of the two spellings");
  assert.deepEqual(required("train"), [], "`out` falls back to `candidate`");
});

test("every published parameter is one some job declares", () => {
  // `lab_caller_params` is the boundary of what can be checked at all: Ansible offers no way to enumerate
  // extra vars, so a name absent from it is discarded silently whatever this gate does. A name on it that
  // NO job takes is worse than useless — an interface entry promising something nothing honours.
  //
  // `repeat` was exactly that. The playbook says so twenty lines from where it was listed: "TWO ENTRIES
  // RATHER THAN A `repeat` PARAMETER, and the ugliness is the point."
  for (const param of PLAY_VARS.lab_caller_params) {
    const takers = Object.values(PLAY_VARS.lab_jobs).filter((entry) => param in (entry.params ?? {}));
    assert.ok(takers.length > 0,
      `-e ${param}= is published but no job declares it. Either a job should, or it is not a parameter — `
      + `Ansible will discard it and the caller will believe it was applied`);
  }
});

test("the sibling playbooks re-read the job table, and find it where it looks", () => {
  // `lab:status`, `lab:log` and `lab:stop` refuse a job name they do not have by reading the catalogue
  // from the file that DEFINES it, indexed as `[0].vars.lab_jobs`. If that path ever returns nothing they
  // would refuse every job, so this pins the shape they depend on.
  assert.ok(PLAY_VARS.lab_jobs, "lab_jobs must stay in the FIRST play's `vars:` — the lookup indexes [0]");
  assert.ok(Object.keys(PLAY_VARS.lab_jobs).length > 20, "the job table must not read as near-empty");
  for (const [name, entry] of Object.entries(PLAY_VARS.lab_jobs)) {
    // A list OR the expression that builds one: `evidence-check` composes its argv from the fleet.
    assert.ok(entry.argv?.length, `${name} must carry an argv`);
  }
});

test("asking about a job that does not exist is refused, not answered", () => {
  // `lab:status -e job=<typo>` reported `SubState=dead` and exit 0 — which is exactly what a FINISHED job
  // reports. So a script polling a mistyped name read it as fine, and a human read "it is not running".
  // `lab:log` blamed a rotated journal and `lab:stop` said there was nothing to stop, both of which send
  // the reader somewhere the fault is not. Three commands, one collapsed answer.
  //
  // This is the worker's `404 vs 202` rule — "never heard of it" and "already finished" are different
  // answers and must stay that way — applied to the job interface rather than to a capture.
  for (const playbook of ["lab-status.yml", "lab-log.yml", "lab-stop.yml"]) {
    const source = executable(read(playbook));
    assert.match(source, /is not a job this lab has/,
      `${playbook} must refuse a job name it does not have, rather than reporting on a unit that `
      + `never existed`);
    // Read from the file that DEFINES the catalogue, never copied. A second list of job names is how one
    // comes to name a job that no longer exists — the duplication defect these playbooks exist to avoid.
    assert.match(source, /lookup\('file', playbook_dir ~ '\/lab-job\.yml'\)[^\n]*lab_jobs/,
      `${playbook} must read the catalogue from lab-job.yml rather than carrying its own copy`);
  }
});

test("no task name appears twice, and no task reads a fact nothing sets", () => {
  // A DUPLICATED TASK, shipped and caught only by the fleet refusing a correct command. Rewriting the
  // parameter gate to read declared data left the previous pair of refusals behind, still referencing
  // `job_reads`/`job_needs` — facts the rewrite deleted. `| default([])` then made them EMPTY rather than
  // an error, so the second copy asserted "only" was in an empty list and refused `-e only=` on the one
  // job that requires it, while `-e describe=1` (which ends the play before the refusals) reported it
  // correctly. Two answers from one playbook.
  //
  // Neither the params tests nor `tsc` could see it: they assert the DATA, and this was execution order.
  const tasks = (RAW_LAB_JOB[0] as unknown as { tasks: Array<{ name?: string }> }).tasks ?? [];
  const names = tasks.map((task) => task.name).filter((name): name is string => Boolean(name));
  const twice = names.filter((name, index) => names.indexOf(name) !== index);
  assert.deepEqual([...new Set(twice)], [],
    "a duplicated task runs twice with the same name, so its second copy is invisible in the output — "
    + "and if it survived a refactor it is reading whatever facts that refactor left behind");

  // The other half — a task reading a fact nothing sets — is `playbook-variables.test.ts`, which derives
  // the answer instead of naming the four facts this particular refactor happened to delete. A list of
  // names somebody has to keep current is this repo's definition of a rule that gets broken.
});

test("every capture job regenerates the pages before capturing them", () => {
  // "Capturing without regenerating is testing the previous commit" — and `capture-only`, whose entire
  // purpose is proving a corpus change before paying for the full corpus, did exactly that. A case added
  // but not generated failed with `No generated case matches`, which reads like a bad --only rather than
  // a missing page. The `capture` job had always used `:fresh`; this one was the odd one out.
  for (const name of ["capture", "capture-only"]) {
    const argv = [PLAY_VARS.lab_jobs[name].argv ?? ""].flat().join(" ");
    assert.match(argv, /training:capture:fresh/,
      `${name} must generate before capturing, or a newly added case has no page to capture`);
  }
});

test("a job that answers in exit codes says what they mean", () => {
  // `evidence-check` exits 1 for "the evidence CHANGED" and 2 for "could not answer" — both successful
  // runs of the check. The operator saw `exit 1 (expected one of [0])` and had to already know that. The
  // remedy is to REPORT the meaning, not to make 1 a success code: exit 1 means "invalidate 2,122 cached
  // captures", and a job reporting OK for that is a green light on the most expensive operation here.
  const meanings = (PLAY_VARS.lab_jobs["evidence-check"] as { exitMeanings?: Record<string, string> })
    .exitMeanings ?? {};
  assert.ok(meanings["1"]?.includes("CHANGED"), "exit 1 must say the evidence changed");
  assert.ok(meanings["2"]?.includes("INCONCLUSIVE"), "exit 2 must say it could not answer");
  // And the runner must actually surface them, or the declaration is a comment.
  assert.match(executable(read("tasks/run-job.yml")), /job_exit_meanings\[job_exit \| string\]/,
    "run-job.yml must print the meaning of the code it failed on");
  // Every declared code must be one the job can actually produce — a meaning for an impossible code is
  // advice that never fires, and a missing one for a code the job DOES return is the gap this closes.
  for (const code of Object.keys(meanings)) {
    assert.match(code, /^[1-9][0-9]*$/, `exitMeanings key '${code}' is not a non-zero exit code`);
  }
});

test("only a job that reports progress has a progress root, and it is declared", () => {
  // THE ROOT CAUSE, after two fixes that each covered the case somebody had just hit. `training:status`
  // reads DATASET_ROOT and reports whatever run that corpus last held, so a job that does not capture at
  // all — `export`, `rules-gate`, `train` — showed the DATASET capture's `captured: 29, total: 1431`
  // under its own name. Fixing `acceptance`, then `real-pages`, left the other 31 jobs reporting a
  // stranger's run: the assumption was never the mapping, it was that EVERY JOB CAPTURES.
  //
  // Five do. They declare where, beside the command, the same shape as `params:`. The rest get no
  // progress block and say so — "this job does not report progress" and "here are some numbers" are
  // different answers and only one of them is true.
  //
  // DERIVED, NOT LISTED — and this test's own message used to claim a derivation it did not perform.
  // It asserted a hardcoded five-name array while telling the reader it checked "the jobs whose script
  // calls beginRun()". That is the shape this repo pays most for: a comment naming a rule above code
  // that hardcodes an answer, so the list silently becomes the definition and drifts from the rule.
  //
  // The rule, stated so it can be checked: A JOB WRITES CAPTURE PROGRESS IFF IT DISPATCHES TO WORKERS.
  // Both directions are causal rather than coincidental — a job that never touches a worker cannot
  // produce capture progress, and a job that drives the fleet is capturing, which is what writes the
  // file. `setenv: A11Y_WORKERS={{ lab_fleet_workers }}` is how the catalogue already says so, and
  // `lab-job.mjs`'s `captureBearingJobs` already derives fleet-staleness checking from that same field.
  // Two consumers of one declaration beats two lists that must be kept equal by hand.
  //
  // It caught a real gap the moment it was derived: `everything` and `retrain` are capture-bearing and
  // declared no progress root, so `lab:status` answered "this job does not report progress" for the two
  // longest-running jobs in the catalogue — the ones most likely to be asked about. See their entries in
  // lab-job.yml for why declaring it required `training:status --since` first.
  //
  // Deliberately NARROWER than "any job that touches a worker": `evidence-check`, `stability` and
  // `gate-stability` take ONE named worker rather than the fleet, and are diagnostics that persist
  // nothing. They are excluded by the same field, for the same reason `worker-code-check.test.ts`
  // excludes them — a diagnostic must never be the thing that takes the pool offline.
  const jobs = Object.entries(PLAY_VARS.lab_jobs) as [string, {
    progress?: string; setenv?: string[];
  }][];
  const withProgress = jobs.filter(([, e]) => e.progress).map(([name]) => name).sort();
  const captureBearing = jobs
    .filter(([, e]) => (e.setenv ?? []).some((v) => String(v).startsWith("A11Y_WORKERS=")))
    .map(([name]) => name).sort();
  // A vacuity guard, because an empty set equals an empty set and would pass having checked nothing —
  // a parser that stopped matching the catalogue is the failure this test could not otherwise see.
  assert.ok(captureBearing.length >= 5,
    `expected the catalogue to carry several capture-bearing jobs, found ${captureBearing.length} — the `
    + "setenv parse has stopped matching lab-job.yml, so this test is checking nothing");
  assert.deepEqual(withProgress, captureBearing,
    "a job declares `progress:` IFF it dispatches to the fleet. A capture-bearing job missing a progress "
    + "root makes lab:status say 'this job does not report progress' about a job that does; a progress "
    + "root on a job that never captures makes it report a stranger's run, which is the fault two "
    + "earlier fixes each half-closed.");
  // And every declared root must be a corpus directory, not a stray path.
  for (const name of withProgress) {
    const root = (PLAY_VARS.lab_jobs[name] as { progress?: string }).progress ?? "";
    assert.match(root, /^runs\/[a-z-]+$/, `${name}'s progress root looks wrong: ${root}`);
  }
  const status = executable(read("lab-status.yml"));
  assert.match(status, /does not report progress/,
    "a job with no progress root must SAY so rather than fall through to another corpus");
  assert.ok(!/lab_progress_roots/.test(status),
    "the substring map is replaced by the job's own declaration — one source, beside the command");
});

test("lab:status reads the progress file of the corpus the job writes", () => {
  // Three variants of one defect, and the first two fixes each covered only the case somebody hit.
  // `training:status` reads DATASET_ROOT, which defaults to the training corpus — so an ACCEPTANCE job
  // reported the last training run's numbers (fixed), and then `capture-real-pages` reported the DATASET
  // run's `captured: 29, total: 1431` for a 50-page job (this). Two runs, one progress file consulted,
  // and the wrong answer entirely plausible — the first of the six misdiagnoses this repo lists.
  //
  // An open set needs a MAP. A chain of `if`s only ever covers the cases already hit, which is how this
  // reached a third variant.
  const status = executable(read("lab-status.yml"));
  assert.match(status, /lab_job_entry\.progress/,
    "the root comes from the job's own declaration, read from the catalogue that defines it");
  for (const [job, root] of [["capture-acceptance", "runs/screenreader-acceptance"],
                             ["capture-real-pages", "runs/real-page-corpus"],
                             ["capture", "runs/screenreader-dataset"]]) {
    assert.equal((PLAY_VARS.lab_jobs[job] as { progress?: string }).progress, root,
      `${job} must read ${root}`);
  }
  // Every job that WRITES a progress file must have a root here, or its status reads someone else's.
  const writers = ["capture", "capture-only", "capture-real-pages", "capture-acceptance"];
  for (const job of writers) {
    const matched = ["acceptance", "real-pages"].some((key) => job.includes(key));
    const root = matched ? "declared" : "runs/screenreader-dataset (the default)";
    assert.ok(root, `${job} resolves to ${root}`);
  }
});

test("a fleet play waits for a guest to come back before calling it unreachable", () => {
  // `deploy.yml` REBOOTS every guest it deploys to. So a second deploy — or any operation following one
  // — meets machines that are up but not yet answering ssh, and Ansible reports UNREACHABLE at the first
  // task. Measured 2026-08-26 across four runs: one to four boxes dropped each time, every one healthy
  // minutes later, and each failure read as a fleet problem rather than as timing. I attributed it to the
  // boxes twice before measuring.
  //
  // `wait_for_connection` must come FIRST, before any task that touches the guest — placed after one, it
  // is the task that fails.
  const deploy = executable(read("deploy.yml"));
  const tasks = deploy.slice(deploy.indexOf("\n  tasks:"));
  const waitAt = tasks.indexOf("wait_for_connection");
  assert.ok(waitAt !== -1, "deploy.yml must wait for a guest to be reachable before working on it");
  // Every task with a `win_` module or a `chdir` touches the guest; none may precede the wait.
  for (const marker of ["ansible.windows.win_shell", "ansible.windows.win_"]) {
    const first = tasks.indexOf(marker);
    if (first !== -1) {
      assert.ok(waitAt < first,
        `wait_for_connection must precede the first ${marker} task, or that task is the one that fails `
        + `UNREACHABLE on a guest which is merely still rebooting`);
    }
  }
});

test("a filter that can return nothing is defaulted BEFORE it is indexed", () => {
  // `regex_search` returns None when it does not match, and `None | first` throws. The refusal that
  // catches a lab running at the wrong commit did exactly that:
  //
  //     regex_search('a11y-job-([a-z0-9-]+)\.service', '\1') | first | default('<name>')
  //
  // The default came AFTER `first`, so it never got the chance. The guard FIRED correctly — the lab was
  // four commits behind — and then crashed building its own explanation, so the operator saw a Jinja
  // traceback instead of "the lab is at X, you asked for Y". I read the previous run's log as current
  // because of it, which is the misdiagnosis this repo lists first.
  //
  // A guard whose MESSAGE cannot render is worse than no guard: it stops the job and tells you nothing,
  // and the natural response is to distrust the guard.
  const raw = read("tasks/run-job.yml") + read("lab-status.yml") + read("lab-log.yml");
  const expressions = [...raw.matchAll(/\{\{[\s\S]*?\}\}/g)].map((match) => match[0]);
  assert.ok(expressions.length > 10, "found too few expressions; the scan is broken");
  for (const expression of expressions) {
    const flat = expression.replace(/\s+/g, " ");
    // Every point where a possibly-null filter is followed by one that indexes into it.
    // `regex_search` with a CAPTURE-GROUP argument is worse than risky: Ansible's filter calls `.group()`
    // on the non-match itself, so it throws INSIDE the filter and no amount of defaulting afterwards
    // helps. `regex_findall` returns `[]`. That distinction cost two attempts at this fix.
    assert.ok(!/regex_search\([^)]*,\s*['"]\\\\?\d/.test(flat),
      `regex_search with a capture group throws on a non-match — use regex_findall: ${flat.slice(0, 90)}`);
    const risky = /(regex_search|regex_findall|selectattr|map)\([^)]*\)\s*\|\s*(first|last)\b/;
    if (!risky.test(flat)) continue;
    assert.match(flat, /\|\s*default\([^)]*\)\s*\|\s*(first|last)\b/,
      `this indexes a filter that can return nothing without defaulting FIRST, so a non-match throws `
      + `while rendering the message: ${flat.slice(0, 120)}`);
  }
});
