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
import { parse as parseYaml } from "yaml";

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
  assert.match(RUN_JOB, /argv: \[git, rev-parse, --short, HEAD\]/,
    "and the commit must be READ BACK, not assumed from what we asked for");

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
