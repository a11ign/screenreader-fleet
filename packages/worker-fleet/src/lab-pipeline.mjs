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
export const PIPELINES = {
  // The chain that was run by hand all of 2026-08-25.
  "real-pages": {
    fleet: true,
    what: "recapture the real-page corpus and prove no conformant page gained a finding",
    jobs: ["capture-real-pages", "rules-real-pages", "rules-coverage"],
  },
  // The synthetic corpus and the gates that read it. `check-signals` FIRST among the gates, deliberately:
  // it is the one that says whether the corpus can express what the rules are scored on, and a rules score
  // over a corpus with a hole in it looks exactly like a good one.
  corpus: {
    fleet: true,
    what: "recapture the synthetic corpus, then score the rule layer against it",
    jobs: ["capture", "check-signals", "rules-gate", "rules-coverage", "rules-real-pages"],
  },
  // No capture, so no fleet, so it can run while the boxes are doing something else. This is the cheap
  // pipeline to run after a rule change: everything reads from disk and the venv.
  gates: {
    fleet: false,
    what: "score every gate against the corpus already on disk — no worker, minutes",
    jobs: ["check-signals", "rules-gate", "rules-coverage", "rules-real-pages", "release-gate"],
  },
};

/**
 * A commit or a simple branch name, and nothing else.
 *
 * Same containment as `fleet-playbook.mjs`, and needed for the same reason: this value is interpolated
 * into a command a remote shell interprets on the box holding the fleet key, and it becomes `-e ref=` on
 * an Ansible command line here. `;rm -rf /` is inexpressible rather than rejected.
 */
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
function assertPushed(ref) {
  const remote = execFileSync("git", ["ls-remote", "--heads", "--tags", "origin", ref],
    { encoding: "utf8" }).trim();
  if (remote) return;
  throw new Error(`'${ref}' is not on origin. Both halves of this pipeline fetch from origin, so nothing `
    + "would run at the code you are looking at. Push it first.");
}

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
const labJob = (job, ref) =>
  stage(job, "npm", ["run", "lab:job", "--", "-e", `job=${job}`, "-e", `ref=${ref}`]);

const fleetDeploy = (ref) =>
  stage("fleet:deploy — ship this ref to the workers and PROVE it",
    "npm", ["run", "fleet:deploy", "--", `--ref=${ref}`]);

function usage() {
  const names = Object.entries(PIPELINES)
    .map(([name, p]) => `  ${name.padEnd(12)} ${p.fleet ? "[fleet]" : "[no fleet]"}  ${p.what}\n`
      + `${" ".repeat(16)}${p.jobs.join(" -> ")}`)
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

  const ref = process.argv.find((a) => a.startsWith("--ref="))?.slice("--ref=".length) ?? localBranch();
  if (!validRef(ref)) {
    process.stderr.write(`refusing --ref=${ref}: a commit or simple branch name only.\n`);
    process.exit(2);
  }
  try {
    assertPushed(ref);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  const stages = [
    ...(pipeline.fleet ? [["fleet:deploy", () => fleetDeploy(ref)]] : []),
    ...pipeline.jobs.map((job) => [job, () => labJob(job, ref)]),
  ];

  process.stdout.write(`\n  pipeline: ${name} at ref ${ref}\n  ${stages.length} stage(s): `
    + `${stages.map(([label]) => label).join(" -> ")}\n`
    + (pipeline.fleet ? "" : "  no fleet stage: nothing here captures, so the workers are left alone.\n"));

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
  process.stdout.write(`\n  pipeline ${name} PASSED — ${stages.length} stage(s) in ${minutes} min, at ${ref}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
