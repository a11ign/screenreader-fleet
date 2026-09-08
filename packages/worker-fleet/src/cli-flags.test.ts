/**
 * A flag this command does not read must be refused, not ignored.
 *
 * Every CLI in this repo parses argv by looking for the flags it knows, so anything else is silently
 * dropped and the command runs its default — the same defect as an Ansible extra var a job does not read,
 * one layer out. Measured twice here: a blocker told the reader to run `--write-baseline` when the flag is
 * `--update-baseline`, and `--only=route-title-stale` covered 1 of that family's 7 cases.
 *
 * ## Why this pins a list rather than deriving one
 *
 * The obvious test — read each CLI's source, regex out its `--flags`, assert the declared list matches —
 * CANNOT be trusted here, and finding that out is the reason this file is shaped as it is. `stability-gate`
 * builds its flags from a variable (`startsWith(`--${name}=`)`), and `repeat-capture` reads all seven of
 * its value flags through an `arg(name)` helper. A derivation reports ZERO flags for both, so the
 * assertion would pass having examined nothing — this repo's most-repeated defect, in the guard written
 * to prevent it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { stripComments } from "@a11ign/evidence/source-text";
import { unknownFlags, didYouMean, nameOf, refuseUnknownFlags, flagValue } from "./cli-flags.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The CLIs whose flags are guarded, and the cost each one's silent default has.
 *
 * NOT A PARTIAL ROLLOUT ANY MORE, and this sentence used to say it was — "these are the five where an
 * ignored flag has a MEASURED cost" outlived both its number and its premise, since `UNGUARDED` is empty
 * and every discovered CLI is here. The flag list is still READ OUT of each file rather than derived, for
 * the reason the header gives.
 *
 * WIDENED TO TOP-LEVEL `scripts/` ON 2026-09-07 (#164), which is where this census was blind. The walk
 * covered two packages, so the claim it backs — *every argv-reading module is guarded or exempted* — was
 * true of `packages/lab` and `packages/worker-fleet` and silent about a third location holding 22 CLIs,
 * eleven of them unguarded. Nothing was missed that this test was asked about; it was asked the wrong
 * question, and no result could have said so. `install-git-hooks.mjs`'s own header had already recorded
 * the identical gap in a SIBLING guard — *"entry-points.test.ts ... only matches paths under packages/,
 * so this scripts/ file was invisible to it"* — which is the same population boundary, written down and
 * never generalised.
 */
/** Shared by the `--json` reporters, whose only flag is the one that decides who the output is for. */
const JSON_REPORTER =
  "a mistyped `--json` prints for a human where a script expected a machine-readable answer, and the "
  + "caller then parses the prose";

const GUARDED: Record<string, string> = {
  "packages/lab/scripts/check-preregistered-verdict.mjs":
    "takes NO flags -- it reads docs/board/reported.json and nothing else -- so it calls refuseUnknownFlags([]) with an EMPTY list. That is the case worth guarding rather than skipping: a command with no flags is exactly where a mistyped one would otherwise be discarded in silence and the default reported as success.",
  "scripts/board-only-check.mjs":
    "takes no flags; it decides whether a change is board-only, and an ignored argument would answer "
    + "about a different change than the one asked about",
  "scripts/prune-stale-workspace-scope.mjs":
    "takes NO flags -- it runs from `prepare` on every plain `npm install` (#376) to remove a stale "
    + "workspace scope's node_modules symlinks, and it already calls refuseUnknownFlags([]). Classified "
    + "here so the census records it as checked rather than unseen; it predates the census widening to "
    + "top-level scripts/ (#164) and so was invisible to this test until now, which is the shape #164's "
    + "own header already names -- a population boundary written down and never generalised.",
  "scripts/piped-exit-status-guard.mjs":
    "takes the command to inspect POSITIONALLY (argv[2]) and no flags. It exists because a piped exit "
    + "status reads as the pipe's -- a tool built to end that class must not join it by discarding an "
    + "argument and reporting on the default",
  "scripts/ready-label-audit.mjs":
    "already guards its own flags; classified here so the census records it as checked rather than "
    + "unseen. It takes none, and audits which rows are pickable -- a discarded argument would report on "
    + "a different label set than the one asked for",
  "scripts/board-snapshot.mjs":
    "takes no flags at all -- run directly it only ever takes a snapshot of the Project board, and there "
    + "is nothing for a flag to configure. Guarded anyway (#399): a mistyped flag discarded silently would "
    + "still write a snapshot and report success, and this file exists specifically because a board "
    + "mutation once reported success while destroying 112 rows' Status.",
  "scripts/auto-arm-sweep.mjs":
    "takes NO flags -- it arms every open, non-draft, unheld, tested PR against `main` that nothing has "
    + "armed (#344) -- so it calls refuseUnknownFlags([]) with an EMPTY list, the same case as "
    + "check-preregistered-verdict.mjs. An argument handed to it means the caller wanted something other "
    + "than `arm the standing queue`, and a discarded one would have it sweep the whole queue while the "
    + "caller believed they had narrowed it. Its import is RELATIVE rather than the package specifier, "
    + "because its workflow job has only actions/checkout -- no npm ci, no build, no dist (#330/#331).",
  "scripts/queue-stalled.mjs":
    "takes NO flags -- it REPORTS which armed, green open PRs cannot ever merge as-is against `main` "
    + "(#361), and never acts (no rebase, no branch update, no close). A discarded argument means the "
    + "caller wanted something narrower than `examine the standing queue`, and running it anyway silently "
    + "reports on a different population than the one asked about. Its import is RELATIVE rather than the "
    + "package specifier, for the same reason as auto-arm-sweep.mjs: it rides the same pull_request "
    + "trigger, whose job has only actions/checkout -- no npm ci, no build, no dist (#330/#331).",
  "scripts/merge-guard.mjs":
    "it decides whether a PR has actually been TESTED, so a discarded argument would answer about a "
    + "different PR than the one asked about -- and its whole reason for existing is that a confident "
    + "answer to the wrong question reads exactly like a correct one. It takes the PR number "
    + "POSITIONALLY and no flags, which is why the guarded list is empty rather than absent. Added to "
    + "this table the same night it merged, because it landed on `main` from #167 while #164's own "
    + "branch was open and turned that branch red: a derived count is only true of one commit range",
  "scripts/trunk-revert.mjs":
    "decides whether a push to main that just failed its own gate is safe to REVERT, so a discarded "
    + "--push-sha or --before-sha would decide about the wrong commit while reading as a correct answer "
    + "-- the identical hazard `merge-guard.mjs` is guarded against, one door over. It takes "
    + "--push-sha=/--before-sha=/--run-url= and no positional argument (unlike merge-guard.mjs's PR "
    + "number), because a push event carries no PR to number.",
  "scripts/trunk-revert-guard.mjs":
    "decides whether a merge onto main silently deleted work already there, so a discarded --merge would "
    + "check the wrong commit while reading as a clean pass -- the identical hazard trunk-revert.mjs is "
    + "guarded against, and this one runs BEFORE the revert decision even exists: a false PASS here is "
    + "how the #411 incident happened in the first place. Takes only --merge=<sha>, no positional.",
  "scripts/row-claim.mjs":
    "THE COMMAND THE PULL LOOP RESTS ON. Measured 2026-09-07, before the guard: `check 161 --jsonn` "
    + "printed the ordinary claim line and exited 0, and so did `--format=json` -- both read as a "
    + "machine-readable request that was honoured. Two workers pulled one row twice today; a claim tool "
    + "that discards a flag is the same failure waiting on the command that coordination runs through",
  "scripts/merge-queue.mjs":
    "it MERGES. `--merge` takes the PR number as the next argv entry, so a mistyped flag does not "
    + "merely run the default -- it drops the target and the command acts on whatever the default is",
  "scripts/close-rows-for-merged-pr.mjs":
    "takes the PR number POSITIONALLY and no flags, so refuseUnknownFlags([]) with an EMPTY list -- the "
    + "same case as merge-guard.mjs, and for a sharper reason: it CLOSES ISSUES. A discarded argument "
    + "would have it answer about a different PR than the one that merged, and closing the wrong row is "
    + "not a wrong answer you can read and dismiss, it is a write. Its import is RELATIVE rather than the "
    + "package specifier, because its workflow job has only actions/checkout -- no npm ci, no build, no "
    + "dist (#330/#331).",
  "scripts/close-rows-sweep.mjs":
    "it CLOSES ISSUES, the identical reason close-rows-for-merged-pr.mjs is guarded -- takes an OPTIONAL "
    + "--window (minutes), refuseUnknownFlags([\"--window\"]). A mistyped flag silently running the "
    + "default window is comparatively low-risk here since the window is generous by design (#394), but "
    + "the discovery test does not carve out exceptions for low-risk writes. Its import is RELATIVE, "
    + "same reason as its sibling: the job it runs in has only actions/checkout.",
  "scripts/trunk-sweep.mjs":
    "it TRIGGERS a real workflow run (`gh workflow run trunk-guard.yml`) when main's tip has zero check "
    + "runs -- takes NO flags, so refuseUnknownFlags([]) with an EMPTY list, the same case as auto-arm-"
    + "sweep.mjs. A discarded argument means the caller wanted something narrower than `check and trigger "
    + "the standing gate`, and running it anyway silently acts on a different question than the one asked.",
  "scripts/close-merged-rows.mjs":
    "it CLOSES issues. Takes a positional commit range; the `--json`/`--jq` in the file are passed "
    + "onward to `gh` and are not this command's own",
  "scripts/prune-worktrees.mjs":
    "it REMOVES worktrees. Takes a positional repo root; the `--is-ancestor`/`--porcelain`/`--verify` "
    + "in the file go onward to git",
  "scripts/isolation-gate.mjs":
    "`--all`, plus positional package directories. The npm flags in the file (`--pack-destination`, "
    + "`--omit=`, `--no-workspaces`) are passed to npm and are not accepted from a caller -- a derived "
    + "flag list would have accepted all of them",
  "scripts/known-gaps-index.mjs":
    "`--write` is the difference between reporting the index and rewriting a tracked document",
  "scripts/build-packages.mjs":
    "takes no flags; the `--build` in the file is passed to tsc. Guarded rather than exempted because "
    + "a build that silently ignores an argument is how a stale `dist` gets shipped, which this repo "
    + "has paid for twice",
  "scripts/acceptance-commands.mjs":
    "takes no flags at all -- it reads the PR body from PR_BODY (an env var, never argv, because a PR "
    + "body is adversarial input) and runs the author's own stated Acceptance: commands, which is the "
    + "one thing standing between a row's claim and its evidence. A discarded flag here would be the "
    + "identical shape this whole job exists to end, one layer up.",
  "scripts/changed-packages.mjs":
    "takes no flags; `--name-only` goes onward to git. Its output selects which CI jobs run, so a "
    + "discarded argument narrows a test run silently",
  "scripts/check-retired-heads.mjs":
    "takes no flags at all, and it gates a promotion -- the cheapest possible guard on the most "
    + "expensive possible mistake",
  "scripts/install-git-hooks.mjs":
    "takes no flags; `--get` goes to `git config`. Guarded at the entry rather than inside the "
    + "exported `installHooks`, which tests drive with injected dependencies",
  "scripts/update-primary.mjs":
    "takes no flags; `--detach`/`--quiet` go onward to git",
  "scripts/board-document.mjs":
    "renders the PDF a board reads; a discarded flag publishes the wrong document",
  "scripts/board-report.mjs":
    "publishes the daily edition as an issue comment",
  "scripts/board-schedule-liveness.mjs":
    "reports whether the scheduled board jobs are alive",
  "scripts/board-summary-check.mjs":
    "the 21:00 check; `--post` is the difference between reporting and commenting",
  "scripts/check-scheduled-jobs.mjs":
    "reports on scheduled jobs",
  "scripts/ci-changed.mjs":
    "decides which CI jobs run for a change",
  "scripts/control-plane-hygiene.mjs":
    "audits the control plane",
  "scripts/mutation-check.mjs":
    "MUTATES A FILE ON DISK and restores it; a discarded `--file` or `--test` would mutate or verify "
    + "the wrong thing",
  "scripts/npm-token-liveness.mjs":
    "checks the publish token",
  "scripts/reconstitution-drill.mjs":
    "the recovery drill",
  "packages/lab/scripts/collect-promotion.mjs":
    "it OVERWRITES the shipped model weights, so an unrecognised flag running the default is not a "
    + "wasted run but a promotion installed when somebody asked for --dry-run. It takes exactly one "
    + "flag, which is the whole reason a typo is plausible",
  "packages/lab/scripts/explain-capture.mjs":
    "it exists BECAUSE a mistyped question gets a confident wrong answer. Every enquiry into a capture "
    + "used to be ssh plus hand-written Python plus a guess at the JSON shape, and that produced four "
    + "wrong answers in one session — a wrapper read instead of `capture` reported 0 of 20 tab stops. A "
    + "tool built to end that class must not join it: an unrecognised flag here would run the default "
    + "report and look like the one that was asked for",
  "packages/lab/scripts/gate-probe-order.mjs":
    "a mistyped `--pages=` would silently fall back to localhost:5050 and compare a DIFFERENT set of "
    + "pages from the one asked for, then report PASS. This gate exists to prove the tool gives the same "
    + "answer twice; a pass over pages nobody requested is that claim made about the wrong subject, which "
    + "is the exact defect it was written to catch",
  "packages/lab/scripts/fleet-hours.mjs":
    "--dir picks a corpus other than runs/, and a mistyped one would silently report the DEFAULT "
    + "corpus's hours under the name of the run you asked about — a cost figure attributed to the "
    + "wrong run, which is the defect this whole tool was written around",
  "packages/lab/scripts/emit-unclosable-vetoes.mjs":
    "it takes NO flags, and an ignored one would emit the wrong set silently — a veto report that "
    + "forgave the wrong pairs reads as a shorter work list rather than as an error",
  "packages/lab/scripts/check-shipped-provenance.mjs":
    "it takes NO flags, and that is the case worth guarding rather than the one to skip: an argument "
    + "that looks like it narrows a release gate (`--allow-stale`, `--skip`) would be ignored, and the "
    + "gate would report a pass having been asked for something it never did",
  "packages/lab/src/training/capture-screenreader-dataset.mjs":
    "a typo costs a full corpus run — `--resmue` silently means a fresh capture of 1,061 pairs",
  "packages/lab/src/training/capture-real-pages.mjs":
    "THE script that ran four shards against `--worker=http://:8765` for 29 minutes. Its `--shard=` "
    + "arrives through `parseShard`, so a regex over this file would not find it",
  "packages/control/src/lab-pipeline.mjs":
    "a mistyped `--ref=` falls back to the local branch, which is how the fleet and the lab came to be "
    + "on different commits, failing with a hash mismatch that reads like a corrupted checkout",
  "packages/lab/scripts/promote-model.mjs":
    "the most dangerous silent default in the repo: a mistyped `--dry-run` PROMOTES",
  "packages/lab/src/training/check-signals.mjs":
    "a mistyped `--require-complete` scores whatever is on disk and passes",
  "packages/lab/src/training/repeat-capture.mjs":
    "`--probe-forms` and `--probe-tables` are how a canary reaches the fields carrying interaction "
    + "evidence, and a canary that cannot express the fault is worthless",
  "packages/lab/scripts/everything-pipeline.mjs":
    "hours long and unattended — a mistyped `--dry-run` would run the real thing",
  "packages/lab/scripts/build-realism-tier.mjs":
    "run by the `build-realism` job and by `training:train`; a mistyped `--out=` writes the realism tier somewhere the trainer will not read, and the train",
  "packages/lab/scripts/calibrate-abstention.mjs":
    "takes NO flags — it is configured entirely by environment, so any flag passed to it today is discarded in silence. The `--model` in its output is `-e",
  "packages/lab/scripts/evidence-check.mjs":
    "the check that decides whether 2,122 cached captures survive a change. It also takes worker URLs POSITIONALLY, which this guard does not touch",
  "packages/lab/scripts/stability-gate.mjs":
    "the canaries that must pass before a corpus run. `--probe-forms`, `--task` and `--url` appear in this file because it PASSES them to repeat-capture; t",
  "packages/lab/src/training/export-screenreader-dataset.mjs":
    "a mistyped `--out=` exports where nothing downstream reads, and the trainer then fits on the "
    + "PREVIOUS export — which looks exactly like a successful run",
  "packages/worker-fleet/src/deploy-worker.mjs":
    "`--vm=` mistyped deploys to EVERY guest rather than the one named, and `--allow-protocol-change` "
    + "is the flag that lets a CAPTURE_PROTOCOL_VERSION bump ship, invalidating 2,122 cached captures",
  "packages/control/src/fleet-playbook.mjs":
    "`--serial=` and `--limit=` decide how many of twelve machines an operation touches at once, and "
    + "`--ref=` decides what code they end up running",
  "packages/worker-fleet/src/check-worker-code.mjs":
    "takes NO flags — it asks every worker what code it is running and compares. Any flag passed to it today is discarded in silence",
  "packages/worker-fleet/src/guest-run.mjs":
    "takes a VM name and a script POSITIONALLY, which this guard does not touch, plus `--timeout=`; a mistyped timeout silently falls back to 600s on an op",
  "packages/lab/src/harnesses/capture-check.mjs":
    "the capture-layer regression check; a mistyped --worker= falls back to in-process mode, which REFUSES while a worker is serving",
  "packages/lab/src/harnesses/page-identity-rate.mjs":
    "asks whether a capture ever reads the WRONG page; --rounds= sets the width of the 95% upper bound a zero count is reported as",
  "packages/lab/src/harnesses/occurrence-verdict-stability.mjs":
    "takes its worker positionally and no flags at all",
  "packages/lab/src/harnesses/capture-fixtures.mjs":
    "recaptures the eval fixtures; --ff-only appears in the file because it is passed to GIT",
  "packages/worker-fleet/src/compare-workers.mjs":
    "--runs= is a documented alias of --rounds=, so a guard listing one would refuse a spelling the code supports",
  "packages/lab/scripts/check-dataset-distribution.mjs":
    "a mistyped --data would silently check the DEFAULT export and report it clean, which is the "
    + "examined-nothing failure this command exists to catch, committed by the command itself",
  "packages/lab/scripts/audit-corpus-urls.mjs":
    "a mistyped --timeout= silently uses 15s, and a slow government host then reports as MOVED when it "
    + "merely did not answer in time",
  "packages/lab/scripts/audit-corpus-starvation.mjs":
    "takes no flags; any passed today is discarded",
  "packages/lab/scripts/audit-observation-ambiguity.mjs":
    "a mistyped --captures= silently audits the DEFAULT corpus root, so an answer about the wrong "
    + "captures reads exactly like an answer about the right ones",
  "packages/lab/scripts/audit-size-sensitivity.mjs":
    "--evaluating and --stdin are passed ONWARD to the Python scorer, not read here",
  "packages/lab/scripts/bench-capture.mjs":
    "a mistyped --from-disk silently drives the fleet when you meant to replay a file",
  "packages/lab/scripts/compare-layers.mjs":
    "takes its sites POSITIONALLY; the flags in the file are passed onward",
  "packages/lab/scripts/corpus-backup.mjs":
    "--verify-only is the difference between checking a backup and WRITING one",
  // Its ONLY flag, and the one that decides whether it destroys anything. A mistyped `--aply` must be
  // refused rather than silently running the reporting default and reading as "nothing to prune".
  "packages/lab/scripts/corpus-prune-orphans.mjs": "--apply",
  "packages/lab/scripts/corpus-snapshot.mjs":
    "a mistyped --out= writes the snapshot where you will not look for it",
  "packages/lab/scripts/corpus-release.mjs":
    "a typo'd --dryrun UPLOADS the corpus while the operator believes they are rehearsing — the flag is "
    + "the whole difference between describing an upload and performing one, and an ignored flag runs "
    + "the default",
  "packages/lab/scripts/emit-grants-map.mjs":
    "takes no flags",
  "packages/lab/scripts/explain-scorer.mjs":
    "--name, --case and --weights appear in its prose, not its argv",
  "packages/lab/scripts/retrain-pipeline.mjs":
    "a mistyped --dry-run runs the REAL retrain",
  "packages/lab/scripts/verify-safetensors.mjs":
    "--inference decides which contract is verified, so a typo checks the wrong one and passes",
  "packages/lab/src/harnesses/assert-action-report.mjs":
    "the flags ARE the assertion: a mistyped --require-wcag= asserts nothing and reports success",
  "packages/lab/src/training/generate-screenreader-acceptance.mjs":
    "takes no flags",
  "packages/lab/src/training/generate-screenreader-dataset.mjs":
    "takes no flags",
  "packages/lab/src/training/preflight-screenreader-dataset.mjs":
    "takes no flags",
  "packages/control/src/fleet-discover.mjs":
    "--enroll WRITES to inventory.yml; mistyped it scans and enrols nothing",
  "packages/worker-fleet/src/fleet-env.mjs":
    "its output is eval-ed by a shell, so a wrong shape is executed rather than read",
  "packages/control/src/fleet-wake.mjs":
    "takes no flags",
  "packages/worker-fleet/src/normalise-fleet.mjs":
    "takes no flags",
  "packages/lab/src/training/wait-for-capture.mjs":
    "its EXIT CODE is the contract — 0 clean, 1 failures, 2 no run, 3 wedged — so a caller reading it "
    + "has already committed to an output shape, and a mistyped `--json` gives it the other one",
  "packages/worker-fleet/src/doctor.mjs": JSON_REPORTER,
  "packages/control/src/fleet-status.mjs": JSON_REPORTER,
  "packages/lab/src/training/capture-status.mjs": JSON_REPORTER,
  "packages/lab/scripts/lab-inventory.mjs": JSON_REPORTER,
  "scripts/owned-path-signoff.mjs":
    "it decides whether a change to a CORPUS-INVALIDATING path may merge (#356). `--diff` and `--body` "
    + "are the two things it compares; a discarded one leaves it comparing an empty set and "
    + "reporting SATISFIED -- a check passing having examined nothing, on the paths where a mistake "
    + "costs a corpus rather than a revert",
  "scripts/pr-hold.mjs":
    "it WRITES a `session:` label that decides whether `merge-guard` refuses a PR (#266). `--session` "
    + "says who is taking the hold and `--steal` displaces whoever has it, so a discarded flag either "
    + "takes a hold in nobody's name or fails to displace the person it just announced displacing",
  "scripts/stash-whose.mjs":
    "it reports who holds each stash in a pile SHARED between every worktree (#290). It takes no "
    + "flags, and a discarded argument would answer about a different question than the one asked -- "
    + "on the command a worker consults before deciding whether a stash is safe to pop",
  // Landed on `main` while this branch was open — the third such batch, which is itself the argument for
  // #205: a census pinned to a hand-written number is stale the moment anyone else merges a CLI.
  "scripts/changeset-precise.mjs":
    "its answer decides whether the pre-push FAST gate demands a changeset at all. It takes its base ref "
    + "POSITIONALLY and no flags, so a mistyped one would be dropped while the positional is read from "
    + "the wrong slot — guarded with an empty list here, same shape as `merge-guard.mjs`",
  "scripts/coverage-failure-classifier.mjs":
    "`--ci-outcome`, `--build-outcome`, `--log` and `--run-url` are the four facts it classifies a "
    + "nightly failure FROM; a discarded one silently narrows the evidence and the comment then "
    + "describes a failure nobody had",
  "scripts/stranded-branches.mjs":
    "it reports pushed branches with no PR — the invisible-work check. It takes no flags, and a "
    + "discarded argument would report on a population other than the one asked about, which is exactly "
    + "the fault it exists to find",
  // Landed on `main` while this branch was open, and all three arrived ALREADY GUARDED — which is the
  // census working in the direction it was built for: the failing assertion is what told this branch they
  // existed at all, and the source it then had to read said the guard was already there.
  "scripts/mark-primary-checkout.mjs":
    "`--set` and `--unset` are OPPOSITE ACTS on a repo-local git config, and it writes when it sees one — "
    + "a mistyped `--unser` that ran the default would leave the operator believing a checkout was marked",
  "scripts/row-reachability.mjs":
    "`--row=<n>` decides WHICH row is examined; ignoring a mistyped one falls back to the number it finds "
    + "positionally, so the answer would describe a different row than the one asked about",
  "scripts/workflow-run-liveness.mjs":
    "`--sha` falls back to $GITHUB_SHA, so a mistyped flag silently answers about a DIFFERENT commit — "
    + "and the question it answers is whether that commit was tested before it reached main",
  "scripts/history-secret-scan.mjs":
    "`--all` is required and not optional -- a mistyped or dropped flag would run neither branch, since "
    + "the script REFUSES rather than defaulting when it is absent, precisely because scanning only the "
    + "current branch would silently miss the branches with more instances of the defect than main has "
    + "(measured: 72 vs 48, #310). `--repo` decides WHICH repository is scanned; a discarded one falls "
    + "back to this checkout, reporting on the wrong tree entirely for a rehearsal clone.",
  "scripts/history-purge-rehearsal.mjs":
    "`--source` names the real repository to mirror-clone from; a discarded flag would fail closed "
    + "(refuses without one) rather than silently rewriting the wrong tree, but `--clone-into` and "
    + "`--replacements` deciding the WRONG path or pattern set silently is exactly the failure this tool "
    + "exists to make impossible for a history rewrite, #310",
  "scripts/assert-glob-not-empty.mjs":
    "`--min` decides the floor a test glob must clear (#355); a discarded typo would silently check "
    + "against the default of 1 instead of the real floor, passing a glob that lost most of its files. "
    + "`--run` and `--test-concurrency` decide whether this command executes `tsx --test` on the globs it "
    + "just checked, or only checks them -- a discarded `--run` would make a caller believe the real "
    + "suite ran when only the vacuity check did, which is silence exactly where this tool exists to "
    + "refuse it.",
};


/**
 * Not yet guarded. THIS LIST MAY ONLY SHRINK.
 *
 * It is not an exemption — every one of these ignores an unrecognised flag today. It exists so that a NEW
 * CLI cannot join them without a test failing, which is the difference between a known gap and an unknown
 * one. Guarding one means deleting its line.
 */
const UNGUARDED: Record<string, string> = {
  // NO LONGER EMPTY, as of 2026-09-07 (#164), and the single entry is a real constraint rather than an
  // oversight — which is exactly what this set exists to record.
  //
  // `check-schema-migration.mjs` is COPIED INTO A THROWAWAY DIRECTORY AND RUN THERE by
  // `migration-gate-refuses.test.ts`, which is how that gate is proved end to end rather than by reading
  // its source. A copied script has no `node_modules`, so importing `@a11ign/worker-fleet/cli-flags`
  // makes it die on startup: measured, `ERR_MODULE_NOT_FOUND: Cannot find package
  // '@a11ign/worker-fleet'`, three tests red. Guarding it would trade a real proof that the
  // migration gate refuses for a guard against a mistyped flag, which is the worse bargain.
  //
  // The alternative — a second copy of `refuseUnknownFlags` with no workspace import — is the
  // fact-stated-twice shape this repo pays for most, and `git-safe-env.mjs` is the one place a duplicate
  // was accepted, under a documented publish-boundary constraint that does not apply here.
  //
  // ITS ONE FLAG IS `--evaluating`, read at the top of `main()`. A mistyped one is discarded and the
  // command answers the stricter question instead — which fails closed, and is the reason this exemption
  // is affordable at all.
  "scripts/check-schema-migration.mjs":
    "copied into a throwaway directory and run there by `migration-gate-refuses.test.ts`, so a workspace "
    + "import of `cli-flags.mjs` dies on startup with ERR_MODULE_NOT_FOUND. Its one flag, `--evaluating`, "
    + "fails CLOSED when discarded -- the command answers the stricter question -- which is what makes "
    + "this exemption affordable rather than a hole",
};

/**
 * Does this file take a command line? The guard itself reads argv, and is the implementation.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not a nicety. This matched the raw source, so a module that
 * merely MENTIONED `process.argv` in a comment was classified as a CLI — which happened on 2026-08-29 to
 * `gates/dispatch.mjs`, a library whose comment said it deliberately does NOT read `process.argv`. The
 * test's own subject, in the test: this repo's rule is that a check must not derive its expectations from
 * source TEXT, because text includes the prose about the code as well as the code.
 *
 * The direction of the change is safe: stripping comments can only REMOVE a file from the set, and a file
 * whose only mention is in prose is not a command line. Verified against the real tree — the discovered
 * set is unchanged apart from `dispatch.mjs`, which is the false positive.
 */
function isCommandLine(rel: string): boolean {
  if (!rel.endsWith(".mjs")) return false;
  const source = stripComments(readFileSync(join(REPO, rel), "utf8"));
  return source.includes("process.argv") && !source.includes("export function refuseUnknownFlags");
}

/** Every `.mjs` that reads argv — DISCOVERED, so a new one cannot arrive unnoticed. */
function commandLineModules(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "node_modules") walk(rel);
      else if (!entry.isDirectory() && isCommandLine(rel)) found.push(rel);
    }
  };
  // TOP-LEVEL `scripts/` IS IN THE POPULATION, and its absence was this census's own defect (#164).
  //
  // The walk covered two packages, so `**ALL N are guarded** … DISCOVERS every argv-reading module` was
  // true of `packages/lab` and `packages/worker-fleet` and SILENT about a third location holding 22
  // argv-reading CLIs, eleven of them unguarded — `row-claim.mjs` among them, the command the whole pull
  // loop rests on, where a mistyped `--jsonn` was discarded and the default ran at exit 0. Nothing was
  // missed that this test was asked about; it was asked the wrong question, and no result could say so.
  //
  // Found while adding a CLI under `scripts/` for #161 and noticing this census did not react to it.
  const roots = ["scripts", ...["packages/lab", "packages/worker-fleet"]
    .flatMap((pkg) => ["src", "scripts"].map((sub) => `${pkg}/${sub}`))];
  for (const root of roots) {
    // A package without a `scripts/` directory is not a fault; anything else is, and must not be swallowed.
    try { statSync(join(REPO, root)); } catch { continue; }
    walk(root);
  }
  return found;
}

test("only flags a command reads are accepted; the rest are named", () => {
  assert.deepEqual(unknownFlags(["--only=x", "--nope", "page.html", "--"], ["--only=", "--resume"]),
    ["--nope"], "a bare `--` is npm's separator, and a positional is not this guard's business");
  assert.deepEqual(unknownFlags(["--resume"], ["--only=", "--resume"]), []);
  assert.equal(nameOf("--shard=0/4"), "--shard", "`--shard=0/4` and `--shard` name the same flag");
});

test("a near miss is named, and a wild guess is not", () => {
  // The exact case CLAUDE.md records: a blocker's own message named a flag that does not exist.
  assert.equal(didYouMean("--write-baseline", ["--update-baseline", "--json"]), "--update-baseline");
  assert.equal(didYouMean("--resmue", ["--resume", "--only="]), "--resume");
  assert.equal(didYouMean("--wildly-different-thing", ["--json"]), undefined,
    "suggesting anything for an unrelated flag sends the reader somewhere wrong with confidence");
});

test("every guarded CLI still calls the guard", () => {
  // A rename or a merge could drop the call, and nothing else would notice: the command would go back to
  // ignoring flags, which is silent by definition.
  for (const [path, why] of Object.entries(GUARDED)) {
    const source = readFileSync(join(REPO, path), "utf8");
    assert.match(source, /refuseUnknownFlags\(/, `${path} must refuse unknown flags — ${why}`);
    assert.ok(!(path in UNGUARDED), `${path} is guarded; delete its UNGUARDED line`);
  }
});

test("the unguarded list names files that exist", () => {
  // A stale entry is a list that lies: it silently exempts nothing while making the gap look larger than
  // it is, and it would hide a rename — the renamed file would fail the next test as a surprise, and the
  // obvious fix would be to add it rather than to notice it was already meant to be there.
  for (const path of Object.keys(UNGUARDED)) {
    assert.ok(existsSync(join(REPO, path)), `${path} is on the unguarded list and does not exist`);
  }
});

test("a new CLI cannot quietly join the unguarded ones", () => {
  // The rollout is partial and that is a decision, but an UNCOUNTED gap is not one. Anything discovered
  // that is neither guarded nor on the known list fails here, so the list can only shrink.
  const surprises = commandLineModules()
    .filter((path) => !(path in GUARDED) && !(path in UNGUARDED));
  assert.deepEqual(surprises, [],
    "these read argv and neither refuse unknown flags nor appear in UNGUARDED. Guard them "
    + "(preferred — an ignored flag runs the default and reports success), or add them with a reason");
});

test("every exemption declares its own reason HERE — no count, and CLAUDE.md is not read", () => {
  /*
   * #205. This test used to read CLAUDE.md for two figures: `**ALL N are guarded**` and a claim that the
   * exemption list was empty. Both were true when written and both went stale by ordinary merging.
   *
   * The count moved SIX times in one night — 75, 76, 77, 79, 82, 85 — each value correct at the commit
   * that wrote it. The last move happened TWENTY MINUTES after it was corrected, because three CLIs
   * landed on `main` in between. That is not a number going wrong; it is a number that cannot stay right
   * for longer than the interval between merges, and this repository's own rule already names the shape:
   * a derived artefact is true of exactly one commit range.
   *
   * So nothing here counts anything. The INVARIANT is asserted instead, by the discovery test above:
   * every argv-reading module is guarded or classified. That claim cannot go stale, because it is
   * recomputed from the tree on every run rather than compared against a sentence somebody retyped.
   *
   * What remains worth pinning is that an exemption is a DECISION with a reason attached, not a line
   * somebody added to make a test pass — so the reason lives beside the entry and is asserted to be
   * substantive. `git-spawn-classification.test.ts` classifies rather than counts for the same reason.
   */
  // Existence is NOT re-checked here: "the unguarded list names files that exist" above already does it,
  // and a second spelling of one fact is the shape this repo pays for most.
  for (const [path, why] of Object.entries(UNGUARDED)) {
    assert.ok(why.length > 40,
      `${path} is exempt from the flag guard with no real reason given. An exemption without one is `
      + "indistinguishable from an oversight, which is the whole thing this list exists to prevent.");
  }
});

test("the guard never fires on an IMPORTING command's flags", () => {
  // THE DEFECT THIS INTRODUCED, an hour after the guards went in. These calls sit at module top level, so
  // they run on IMPORT — and then inspect the importing process's argv. `capture-real-pages
  // --role=calibration` imports `fleet-env.mjs`, whose guard woke up, saw `--role`, decided it did not
  // know it, and killed a 50-page capture with "unknown flag --role — did you mean --list?".
  //
  // The guard was right about its own flags and asking the wrong process. A check that fails somebody
  // else's correct command is worse than no check: it is the crying-wolf failure that gets guards deleted.
  assert.doesNotThrow(() =>
    refuseUnknownFlags(["--list"], { entry: "file:///some/other/module.mjs", argv: ["--role=x"] }),
    "an imported module must ignore the importer's flags entirely");

  // `entry` is REQUIRED, not defaulted, for the reason `createHostThrottle`'s `minGapMs` is: a default
  // would silently restore this behaviour for any caller who forgot it.
  // Cast because the types REQUIRE `entry` — TypeScript rejects this call outright, which is the
  // required-parameter design working. The runtime guard covers the .mjs callers nothing typechecks.
  assert.throws(() => refuseUnknownFlags(["--list"], { argv: ["--nope"] } as never),
    /needs \{ entry: import\.meta\.url \}/,
    "a call without entry must fail loudly rather than guard the wrong process");
});

test("every call site passes its own import.meta.url", () => {
  // The runtime guard above fires wherever the call happens to run. This one fires here, and covers the
  // call sites that no test happens to execute.
  const offenders: string[] = [];
  for (const path of [...Object.keys(GUARDED)]) {
    const source = readFileSync(join(REPO, path), "utf8");
    const call = source.slice(source.indexOf("refuseUnknownFlags("));
    const args = call.slice(0, call.indexOf(");") + 2);
    if (!args.includes("entry: import.meta.url")) offenders.push(path);
  }
  assert.deepEqual(offenders, [],
    "these pass no `entry`, so if anything imports them their guard inspects the importer's flags");
});

test("a SINGLE-DASH flag is refused, because an ansible-shaped argument silently vanished", () => {
  // Measured 2026-09-05. `npm run fleet:provision -- -e worker_edge_allow_downgrade=true` passed this
  // guard untouched (it inspected only `--` arguments), was not forwarded by the wrapper (which builds
  // ansible's argv itself), and a 14-minute whole-fleet provision ran WITHOUT the authorisation the
  // operator believed they had given. The role then refused with a message naming the flag just passed.
  //
  // Several commands here wrap `ansible-playbook`, whose own arguments are single-dash, so this shape is
  // the one an operator is most likely to reach for by analogy — and it was the one shape not checked.
  assert.deepEqual(unknownFlags(["-e", "job=train"], ["--ref="]), ["-e"]);
  assert.deepEqual(unknownFlags(["-l", "a11y-worker-3"], ["--limit="]), ["-l"]);
});

test("flagValue: the five vectors measured across all fifteen pre-existing hand-rolled copies", () => {
  // audit §9 "argv parsing". These five are what distinguished the fourteen-file majority from the one
  // outlier (`fleet-discover.mjs`'s `.split("=")[1]`) before this function existed.
  assert.equal(flagValue(["--url=http://host"], "url"), "http://host", "a normal value");
  assert.equal(flagValue([], "url"), undefined, "a missing flag is undefined, not an empty string");
  assert.equal(flagValue(["--url="], "url"), "", "an explicitly empty value is '', not undefined");
  assert.equal(flagValue(["--url=first", "--url=second"], "url"), "first", "first occurrence wins");
  assert.equal(flagValue(["--url=http://host?a=b"], "url"), "http://host?a=b",
    "a value containing its own '=' is preserved whole -- this is the vector fleet-discover.mjs's "
    + "`.split(\"=\")[1]` got wrong, truncating to 'http://host?a'");
  assert.equal(flagValue(["--worker", "http://x"], "worker"), undefined,
    "the space-separated form is not supported by any of the fifteen originals, and this must not "
    + "silently start accepting it -- that would be a parsing behaviour change, not a deduplication");
});

test("positionals are still not this guard's business", () => {
  // The reason the filter cannot simply be `startsWith("-")`: these commands take URLs, worker addresses
  // and page paths, and refusing one would break correct usage — the failure mode the derived-flag-list
  // note in CLAUDE.md records for five other commands. `-` followed by a LETTER is the discriminator.
  assert.deepEqual(unknownFlags(["https://example.com"], ["--ref="]), []);
  assert.deepEqual(unknownFlags(["/pages/index.html"], ["--ref="]), []);
  assert.deepEqual(unknownFlags(["--"], ["--ref="]), []);          // npm's separator
  assert.deepEqual(unknownFlags(["-5"], ["--ref="]), []);          // a negative number is not a flag
});

test("the guard fires through a SYMLINK, because npm's own .bin entries are symlinks", () => {
  // #237. The entry guards at every call site realpath `argv[1]`; `refuseUnknownFlags`'s OWN comparison
  // did not. So through a symlink the outer condition was TRUE and this one FALSE: `main()` ran and the
  // flag guard returned early having inspected nothing.
  //
  // Measured on `board-schedule-liveness.mjs`, same file, same flag, before and after:
  //
  //   before:  via symlink exit 0, "--bogusflag" IGNORED   |  direct exit 2, refused
  //   after:   via symlink exit 2, refused                 |  direct exit 2, refused
  //
  // Through the symlink the mistyped flag ran the default and reported success — which is the sentence
  // the refusal itself prints as the reason it exists. A remedy whose TRIGGER is narrower than the thing
  // it guards, the `refreshBrowseBuffer` shape.
  //
  // It matters beyond a hand-made link: **npm creates `.bin` entries as symlinks**, so any CLI this repo
  // ever exposes as a `bin` is invoked through one.
  //
  // Driven end to end through a REAL child process rather than by calling the function, because the whole
  // defect lives in `process.argv[1]` versus `import.meta.url` — a unit call cannot express it, which is
  // exactly why the census (which asserts a file CONTAINS `refuseUnknownFlags(`) could not see it either.
  const dir = mkdtempSync(join(tmpdir(), "a11y-flagguard-"));
  try {
    const real = join(dir, "real-command.mjs");
    writeFileSync(real, [
      `import { realpathSync } from "node:fs";`,
      `import { pathToFileURL } from "node:url";`,
      `import { refuseUnknownFlags } from ${JSON.stringify(pathToFileURL(join(REPO, "packages/worker-fleet/src/cli-flags.mjs")).href)};`,
      `if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {`,
      `  refuseUnknownFlags(["--known"], { entry: import.meta.url, command: "real-command" });`,
      `  console.log("RAN");`,
      `}`,
    ].join("\n"));
    const link = join(dir, "via-symlink.mjs");
    symlinkSync(real, link);

    const direct = spawnSync(process.execPath, [real, "--bogus"], { encoding: "utf8" });
    assert.equal(direct.status, 2, "invoked directly, an unknown flag must be refused");

    const viaLink = spawnSync(process.execPath, [link, "--bogus"], { encoding: "utf8" });
    assert.equal(viaLink.status, 2,
      "through a symlink the guard must still fire; exit 0 here means the flag was IGNORED and the "
      + `command reported success. stdout: ${viaLink.stdout} stderr: ${viaLink.stderr}`);
    assert.match(viaLink.stderr, /unknown flag --bogus/);

    // AND THE NORMAL PATH IS UNTOUCHED: a known flag through the symlink still runs.
    const ok = spawnSync(process.execPath, [link, "--known"], { encoding: "utf8" });
    assert.equal(ok.status, 0, `a known flag must still run through the symlink: ${ok.stderr}`);
    assert.match(ok.stdout, /RAN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
