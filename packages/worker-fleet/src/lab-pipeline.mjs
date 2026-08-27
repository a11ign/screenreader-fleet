/**
 * Produce evidence and prove it, as ONE command instead of six typed in the right order.
 *
 *   npm run lab:pipeline -- --pipeline=real-pages
 *   npm run lab:pipeline -- --pipeline=corpus --ref=my-branch
 *   npm run lab:pipeline -- --list
 *
 * ## What was hand-cranked, and what that cost
 *
 * Every stage below already exists, is supervised, and reports honestly. What did not exist was the
 * ORDER, and the order lived in somebody's head — the same defect `lab:retrain` was written to close one
 * layer down, where the comment reads: *"Every defect found that day existed because the pipeline had
 * never once been run end to end; a human silently works around what a script cannot."*
 *
 * Run by hand on 2026-08-25, this sequence produced: a fleet deployed at `main` while the lab ran a
 * branch, four boxes rebooted for nothing, an `ANSIBLE_EXIT=2` masked by `| tail`, and three jobs run at a
 * commit four behind the one asked for. None of those is a hard problem. All of them are what happens when
 * the sequence is retyped.
 *
 * ## Why a node script and not one Ansible playbook
 *
 * MEASURED, not assumed. The obvious shape is `import_playbook: deploy.yml` followed by the lab plays —
 * and it cannot work, because the two halves are in different credential domains and that split is ADR
 * 0012 rather than an accident:
 *
 *   - the WORKERS are reachable only from the control plane, which holds the fleet SSH key
 *     (`inventory.yml`: *"worker playbooks can only be run from here and not from a developer's Mac"*)
 *   - the LAB is reachable only with the `a11y-pve` key, which the control plane does NOT have — verified
 *     2026-08-25: `REDACTED-INTERNAL-ADDRESS:22` is open from the control plane and answers
 *     `Permission denied (publickey)` to the only key it holds
 *
 * So exactly one machine can drive both: this one. Giving the control plane the lab key would make a
 * single playbook possible and would put both halves of the split behind one credential, which is the
 * coupling the split exists to prevent.
 *
 * ## What this adds beyond running the stages in order
 *
 * ONE ref, resolved once and passed to both halves. That is not tidiness: `fleet:deploy` takes
 * `a11y_git_ref` and `lab:job` takes `ref`, they default independently, and on 2026-08-24 that put the
 * fleet on `main` while the lab ran a branch — `expected_code` computed from one commit and `served_code`
 * from another, failing with a mismatch that reads like a corrupted guest checkout.
 *
 * It adds no supervision of its own. Each stage is a `lab:job`, which is a systemd unit with a real
 * timeout, a durable handle and mutual exclusion by unit name; a pipeline that died halfway is resumed by
 * running the remaining stages, and a stage already running is REFUSED rather than duplicated.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./cli-flags.mjs";

/**
 * a mistyped `--ref=` falls back to the local branch, which is how the fleet and the lab came to be on
 * different commits.
 *
 * An unrecognised flag is otherwise IGNORED — every CLI here parses argv by looking for the flags it
 * knows — so it runs the default and reports success. See `cli-flags.mjs`.
 */
refuseUnknownFlags(["--pipeline=", "--ref=", "--only=", "--list"],
  { entry: import.meta.url, command: "npm run lab:pipeline" });

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The named pipelines. Each is an ORDER over jobs that already exist in `lab-job.yml`.
 *
 * The job names are not re-implemented here and must not be: `lab-pipeline.test.ts` parses the catalogue
 * and asserts every name below exists in it, because a pipeline naming a job that was renamed would fail
 * at the stage rather than at dispatch — after the expensive stages had already run.
 *
 * `fleet` says whether the run needs the WORKERS deployed first. It is stated rather than derived, and
 * pinned by the same test: a pipeline containing a job that reads `A11Y_WORKER(S)` must have `fleet: true`,
 * or it would capture with whatever the boxes happen to be running.
 */
export { resolveOnOrigin };

/**
 * The job NAMES a pipeline runs, whichever form its stages are declared in.
 *
 * ONE reader, exported, because a stage may be a bare name or `{ job, vars }` and there are five places
 * that ask "which jobs does this pipeline run" — the runner, the `--only` check, `--list`, and two tests
 * that pin every named job against the real catalogue. Those tests are the ones that matter: they exist
 * so a renamed job fails here instead of at its STAGE, which for `corpus` is after a multi-hour capture.
 * A second spelling of this destructure is how such a test comes to examine `[object Object]` and pass.
 */
/** @param {{jobs?: Array<string | {job: string, vars?: Record<string, string>}>}} pipeline
 *  @returns {string[]} */
export function jobNames(pipeline) {
  return (pipeline?.jobs ?? []).map((entry) => (typeof entry === "string" ? entry : entry.job));
}

export const PIPELINES = {
  // The chain that was run by hand all of 2026-08-25.
  "real-pages": {
    fleet: true,
    what: "recapture EVERY real-page role and prove no conformant page gained a finding",
    // BOTH ROLES, NAMED, and that is the whole point of this entry.
    //
    // `capture-real-pages` DEFAULTS to `--role=training`, so this pipeline used to capture 39 of the 89
    // real pages and then score and rewrite the baseline against all of them. A default that is silently
    // a SUBSET is the shape this repo keeps paying for: the run reports success, and the corpus it
    // reasoned over was whatever happened to be on disk from some earlier run.
    //
    // Measured 2026-08-27, by hand-running the pieces this pipeline exists to hold: a calibration-only
    // capture followed by `rules:real-pages --update` took the baseline from 85 pages to 81 and erased
    // `events.bl.uk`'s known 2.4.3, silently. `check-real-page-findings.ts` now REFUSES that write, and
    // this names the roles so the refusal never has cause to fire from a pipeline run.
    //
    // `fixture` is deliberately absent: those four pages are not scored as conformant real pages.
    jobs: [
      { job: "capture-real-pages", vars: { role: "calibration" } },
      { job: "capture-real-pages", vars: { role: "training" } },
      "rules-real-pages",
      "rules-coverage",
    ],
  },
  // The synthetic corpus and the gates that read it. `check-signals` FIRST among the gates, deliberately:
  // it is the one that says whether the corpus can express what the rules are scored on, and a rules score
  // over a corpus with a hole in it looks exactly like a good one.
  corpus: {
    fleet: true,
    what: "recapture the synthetic corpus, then score the rule layer against it",
    jobs: ["capture", "check-signals", "rules-gate", "rules-coverage", "rules-real-pages"],
  },
  // CLOSING A SCHEMA MIGRATION, which is the sequence release:gate refuses until it is done.
  //
  // The order is not obvious and getting it wrong is silent. `lab:retrain` stops after `build-realism` --
  // it produces a DATASET and never trains -- so a retrain followed by a promote would promote the
  // previous candidate against a fresh corpus and report success.
  //
  // `export-acceptance` is here, and it is the step that is easy to miss. The featurizer reads a `parsed`
  // block that `annotateCapture` bakes into the records at EXPORT time, so any change to the announcement
  // grammar in `packages/evidence` changes the model input without changing a line of Python. Measured
  // 2026-08-25: six commits to `announcement.ts` landed after the 24 August export, so the v15 candidate
  // on disk was stamped with the right schema STRING and fitted to a parse that no longer exists.
  // `FEATURE_SCHEMA_VERSION` cannot see that -- it is a version, not a content hash -- so re-exporting
  // both corpora before training is the only thing standing between here and weights fitted to a
  // vanished input space. Acceptance is re-EXPORTED and never re-captured: the captures on disk are raw
  // evidence and unaffected; it is the parse over them that moved.
  candidate: {
    fleet: true,
    what: "re-export both corpora under the current parse, train, audit and promote a candidate",
    jobs: ["retrain", "export-acceptance", "train", "shortcuts", "acceptance", "promote"],
  },
  // THE MODEL CODE CHANGED AND THE EVIDENCE DID NOT — so re-derive the model and nothing else.
  //
  // `candidate` re-captures and re-exports first, which is right when the corpus or the announcement
  // grammar has moved and pure waste when only the trainer has. A threshold-selection fix or a
  // calibration rule changes what the weights ARE, not what they were fitted to, so the dataset on disk
  // is still the right input and re-verifying it costs a capture sweep for no information.
  //
  // Deliberately still ends at `promote`, which gates itself: `promote:gated` runs the candidate gate
  // first and writes nothing on a failure. A pipeline that trains and stops leaves the interesting
  // question — is it shippable? — to a separate command somebody has to remember.
  recalibrate: {
    fleet: false,
    what: "re-derive and re-gate the model from the dataset already on disk — no capture, no export",
    jobs: ["train", "shortcuts", "acceptance", "promote"],
  },
  // PROVE A CORPUS CHANGE ON ONE SUBTYPE BEFORE PAYING FOR THE WHOLE CORPUS.
  //
  // A full recapture is ~4 h on this fleet and a corpus change usually targets one subtype's evidence.
  // Running four hours to discover the fix did not move the number is the wrong order — and it was the
  // only order available, because `capture` was all-or-nothing.
  //
  // So: capture just the cases named by `-e only=`, then run the audits that would SEE the change.
  // If the audit still reports the same finding, the fix is wrong and it cost minutes. If it clears,
  // the full `corpus` run is worth starting.
  //
  // The audits come after deliberately: a targeted capture that reports success proves only that NVDA
  // read some pages. Whether the EVIDENCE moved is a different question, and it is the one being asked.
  verify: {
    fleet: true,
    what: "capture one subtype (-e only=<ids>) and re-run the audits that would see the change",
    jobs: ["capture-only", "grants-audit", "check-signals"],
  },
  // EVERYTHING, IN ORDER — corpus, model, gates. The one command that demonstrates the whole thing passes
  // together rather than in three runs somebody has to sequence and remember the order of.
  //
  // It exists because "each defect verified individually" is not the same claim as "they all pass", and
  // the second is the one that matters: a fix can clear its own audit and break a gate three stages later.
  // Proving that meant running `corpus`, then `candidate`, then `gates`, reading each result and starting
  // the next — the hand-crank `lab:pipeline` was built to remove, left in place at the top level.
  //
  // `retrain` re-captures, and that is not waste: it hits cache for everything `capture` just did, and
  // the ONE thing it adds is regenerating pages from the checkout — which is how a corpus run comes to
  // test the previous commit. Idempotent stages are what make a long chain restartable.
  full: {
    fleet: true,
    what: "corpus, model and gates in one run — the whole thing, proven together",
    jobs: ["capture", "retrain", "export-acceptance", "train", "shortcuts", "acceptance", "promote",
           "grants-audit", "applicability-audit", "rules-gate", "rules-coverage", "rules-real-pages",
           "release-gate"],
  },
  // No capture, so no fleet, so it can run while the boxes are doing something else. This is the cheap
  // pipeline to run after a rule change: everything reads from disk and the venv.
  gates: {
    fleet: false,
    what: "score every gate against the corpus already on disk — no worker, minutes",
    // `grants-audit` and `applicability-audit` are IN the chain, and that is the point of adding them.
    // Both were written on 2026-08-25, both found real defects the same day, and neither gated anything —
    // they ran when somebody remembered, which is this repo's own definition of a check that does not
    // happen. `capture-check` was mandatory and never ran once; `release:gate` was broken from the day it
    // was written. A pipeline that passes without its sharpest audits is a pipeline that passes partly by
    // not asking.
    //
    // Cheap and offline: both read the corpus already on disk, seconds each, no worker.
    jobs: ["check-signals", "grants-audit", "applicability-audit",
           "rules-gate", "rules-coverage", "rules-real-pages", "release-gate"],
  },
};

/**
 * A commit or a simple branch name, and nothing else.
 *
 * Same containment as `fleet-playbook.mjs`, and needed for the same reason: this value is interpolated
 * into a command a remote shell interprets on the box holding the fleet key, and it becomes `-e ref=` on
 * an Ansible command line here. `;rm -rf /` is inexpressible rather than rejected.
 */
/** Jobs that accept `-e only=`. Named, so a var cannot be silently ignored by a stage that has no use for it. */
const TAKES_ONLY = new Set(["capture-only"]);

/**
 * Case ids, contained by SHAPE — the same rule as `validRef`, and needed for the same reason: this value
 * becomes an `-e` on an Ansible command line. `lab-job.yml` validates it a second time at the far end,
 * deliberately, because a malformed id there means capturing the wrong cases rather than none.
 */
export function validOnly(only) {
  return /^[a-z0-9][a-z0-9.+-]{0,80}\+?(,[a-z0-9][a-z0-9.+-]{0,80}\+?)*$/.test(String(only));
}

export function validRef(ref) {
  return /^[0-9a-zA-Z._/-]{1,64}$/.test(String(ref)) && !String(ref).includes("..");
}

/**
 * The current BRANCH, not the commit.
 *
 * `deploy.yml` fast-forwards each guest with `git merge --ff-only origin/{{ a11y_git_ref }}`, so the ref
 * has to be something `origin/<ref>` resolves to. A commit does not — this repo has already spent a run on
 * `-e ref=<sha>` becoming an unresolvable `origin/<sha>`.
 */
const localBranch = () =>
  execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();

/**
 * Refuse a ref that is not on origin, BEFORE anything expensive runs.
 *
 * Both halves fetch from origin, so a ref that exists only locally makes every stage run at whatever the
 * remote already had — and `run-job.yml`'s commit refusal then fires at the far end, after the fleet has
 * been deployed and rebooted. Measured today: four boxes rebooted for a ref nobody had pushed.
 */
function resolveOnOrigin(ref) {
  const remote = execFileSync("git", ["ls-remote", "--heads", "--tags", "origin", ref],
    { encoding: "utf8" }).trim();
  if (!remote) {
    throw new Error(`'${ref}' is not on origin. Both halves of this pipeline fetch from origin, so nothing `
      + "would run at the code you are looking at. Push it first.");
  }
  // `ls-remote` answers `<sha>\t<refname>`, and asks the REMOTE — so it needs no fetch and cannot be stale
  // the way a local `origin/<branch>` can.
  const sha = remote.split("\n")[0].split("\t")[0].trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`origin answered something that is not a commit: ${sha}`);
  return sha;
}

/**
 * PIN THE COMMIT ONCE, and give every lab stage that SHA rather than the branch name.
 *
 * A branch is a moving target and each stage resolves it independently, at the moment that stage runs. So
 * a push landing mid-pipeline puts later stages on different code from earlier ones — a `train` fitted to
 * a corpus that a `capture` at another commit produced, with every stage reporting success. Nothing would
 * say so: `run-job.yml` refuses a commit other than the one ASKED FOR, and each stage would have asked for
 * a different one and got it.
 *
 * Not hypothetical. Twice today a push had to be held by hand for exactly this reason — once through
 * provisioning, where each box stamps the SHA it fast-forwarded to, and once through this pipeline. "Do
 * not push for the next six hours" is a rule that depends on somebody remembering it, which this file's
 * own header calls the thing it exists to remove.
 *
 * `run-job.yml` already resolves a SHA correctly — it tries `refs/remotes/origin/<ref>` first and falls
 * back to `<ref>^{commit}` — so the lab side needs no change to accept one.
 *
 * The FLEET stage still takes the branch, and that asymmetry is forced rather than sloppy: `deploy.yml`
 * fast-forwards each guest with `git merge --ff-only origin/{{ ref }}`, and `origin/<sha>` resolves to
 * nothing. This repo has already spent a run on that exact mistake. It is safe because the deploy is
 * stage ONE, seconds after the pin, and `fleet-playbook.mjs` reads back the control plane's HEAD and
 * refuses a mismatch — so a race there fails loudly instead of silently splitting the run.
 */

/** One stage, run to completion, with its exit status READ rather than piped away. */
function stage(label, command, args) {
  process.stdout.write(`\n${"=".repeat(78)}\n  ${label}\n  ${command} ${args.join(" ")}\n${"=".repeat(78)}\n`);
  // `spawnSync` with inherited stdio, never a pipe. This repo has masked a real `ANSIBLE_EXIT=2` twice in
  // one day with `| tail`, because a pipeline's status is the LAST command's — so the status is read from
  // the child directly and the output goes straight to the terminal.
  const result = spawnSync(command, args, { cwd: REPO, stdio: "inherit" });
  if (result.error) throw new Error(`${label}: ${result.error.message}`, { cause: result.error });
  return result.status ?? 1;
}

/**
 * A stage is the SAME command a human would type, not a second spelling of it.
 *
 * Spelling out `ansible-playbook -i inventory.yml lab-job.yml ...` here would work and would be a second
 * copy of the invocation — and it would already be wrong, because `lab:job` also sets `ANSIBLE_CONFIG`,
 * without which the collections path and host-key settings differ. This repo's rule for a fact stated
 * twice is to delete a copy; going through the npm script is how.
 */
const labJob = (job, ref, extra = []) =>
  stage(job, "npm", ["run", "lab:job", "--", "-e", `job=${job}`, "-e", `ref=${ref}`, ...extra]);

const fleetDeploy = (ref) =>
  stage("fleet:deploy — ship this ref to the workers and PROVE it",
    "npm", ["run", "fleet:deploy", "--", `--ref=${ref}`]);

/**
 * The `--only=` case ids, validated, or a refusal. Extracted because `main` grew past the complexity gate
 * as flags accumulated — the same signal `fleet-playbook.mjs` got, and the same answer: dispatching a
 * pipeline and deciding whether its arguments are usable are two things.
 */
function caseIds(name, pipeline) {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  if (only !== undefined && !validOnly(only)) {
    process.stderr.write(`refusing --only=${only}: case ids only, comma-separated.\n`);
    process.exit(2);
  }
  // A pipeline that NEEDS ids and got none would capture the WHOLE corpus — the four hours it exists to
  // avoid. Refused rather than defaulted, because the default is the expensive direction.
  if (jobNames(pipeline).some((job) => TAKES_ONLY.has(job)) && !only) {
    process.stderr.write(`pipeline '${name}' needs --only=<case-id[,case-id]> — it captures just those `
      + "cases to prove a change before the full corpus run. Paste what check-signals or an audit "
      + "printed.\n");
    process.exit(2);
  }
  return only;
}

function usage() {
  const names = Object.entries(PIPELINES)
    .map(([name, p]) => `  ${name.padEnd(12)} ${p.fleet ? "[fleet]" : "[no fleet]"}  ${p.what}\n`
      + `${" ".repeat(16)}${jobNames(p).join(" -> ")}`)
    .join("\n");
  return `\nnpm run lab:pipeline -- --pipeline=<name> [--ref=<branch>]\n\n${names}\n\n`
    + "  --ref defaults to the branch this checkout is on, and must be pushed: both halves fetch\n"
    + "  from origin, and the fleet and the lab are given the SAME ref rather than defaulting apart.\n";
}

async function main() {
  const name = process.argv.find((a) => a.startsWith("--pipeline="))?.slice("--pipeline=".length);
  // `--list` is a question that was answered, so it exits 0. A missing --pipeline is a malformed request
  // and exits 2 — the same distinction the capture clients make, and collapsing the two would make
  // "show me the pipelines" indistinguishable from "you asked for nothing".
  if (process.argv.includes("--list")) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!name) {
    process.stderr.write(usage());
    process.exit(2);
  }
  const pipeline = PIPELINES[name];
  if (!pipeline) {
    process.stderr.write(`refusing --pipeline=${name}: one of ${Object.keys(PIPELINES).join(", ")}.\n`);
    process.exit(2);
  }

  const only = caseIds(name, pipeline);

  const ref = process.argv.find((a) => a.startsWith("--ref="))?.slice("--ref=".length) ?? localBranch();
  if (!validRef(ref)) {
    process.stderr.write(`refusing --ref=${ref}: a commit or simple branch name only.\n`);
    process.exit(2);
  }
  let pinned;
  try {
    pinned = resolveOnOrigin(ref);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  const stages = [
    ...(pipeline.fleet ? [["fleet:deploy", () => fleetDeploy(ref)]] : []),
    // PINNED, not `ref`. Every lab stage runs at the same commit no matter what lands on the branch while
    // the pipeline is going.
    // `-e only=` reaches the jobs that take it and nothing else. A pipeline that forwarded every extra
    // var to every stage would hand `only` to `check-signals`, which does not take it — and Ansible
    // ignores an unused extra var silently, so the operator would think it had been applied.
    ...pipeline.jobs.map((entry) => {
      // A stage is either a bare job name or `{ job, vars }` — the second form exists because one job can
      // need running more than once with different parameters, and a pipeline that cannot say so pushes
      // that knowledge back into the operator's head, which is what this file exists to stop.
      const { job, vars } = typeof entry === "string" ? { job: entry, vars: {} } : entry;
      const declared = Object.entries(vars ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
      const label = declared.length ? `${job} (${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(" ")})` : job;
      // `-e only=` reaches the jobs that take it and nothing else, for the reason below.
      const extra = [...declared, ...(TAKES_ONLY.has(job) && only ? ["-e", `only=${only}`] : [])];
      return [label, () => labJob(job, pinned, extra)];
    }),
  ];

  process.stdout.write(`\n  pipeline: ${name} at ${ref} -> PINNED ${pinned.slice(0, 12)}\n`
    + `  ${stages.length} stage(s): ${stages.map(([label]) => label).join(" -> ")}\n`
    + "  Every lab stage runs at that commit, so a push landing mid-run cannot split them.\n"
    + (pipeline.fleet
      ? `  The fleet stage takes the BRANCH (${ref}): deploy.yml fast-forwards each guest with\n`
        + "  `git merge --ff-only origin/<ref>`, and origin/<sha> resolves to nothing.\n"
      : "  no fleet stage: nothing here captures, so the workers are left alone.\n"));

  const started = Date.now();
  for (const [index, [label, run]] of stages.entries()) {
    const status = run();
    if (status === 0) continue;
    // STOPS at the first failure rather than carrying on, for the reason `lab:retrain` gives: a pipeline
    // that continues past a failed gate produces an artefact built on a corpus with a hole in it, and the
    // number at the end looks exactly like a good one.
    process.stderr.write(`\n  PIPELINE FAILED at stage ${index + 1}/${stages.length}: ${label} (exit ${status}).\n`
      + `  Nothing after it ran: ${stages.slice(index + 1).map(([l]) => l).join(", ") || "(it was the last)"}.\n`
      + "  The stage's own output is above and, for a lab job, all of it is still on the box:\n"
      + `    npm run lab:status -- -e job=${label}\n`
      + "  Fix what it named, then re-run this pipeline — every stage is idempotent, and a stage that\n"
      + "  already succeeded either hits its cache or re-runs cheaply.\n");
    process.exit(status);
  }
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  process.stdout.write(`\n  pipeline ${name} PASSED — ${stages.length} stage(s) in ${minutes} min, `
    + `every one at ${pinned.slice(0, 12)}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
