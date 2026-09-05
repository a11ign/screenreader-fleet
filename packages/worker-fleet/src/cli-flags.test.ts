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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "@a11y-witness/evidence/source-text";
import { unknownFlags, didYouMean, nameOf, refuseUnknownFlags } from "./cli-flags.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The CLIs whose flags are guarded, and the cost each one's silent default has.
 *
 * A partial rollout, deliberately: these are the five where an ignored flag has a MEASURED cost, and the
 * flag list was read out of each file rather than derived. `UNGUARDED` below is the rest, listed so the
 * gap is countable instead of invisible.
 */
/** Shared by the `--json` reporters, whose only flag is the one that decides who the output is for. */
const JSON_REPORTER =
  "a mistyped `--json` prints for a human where a script expected a machine-readable answer, and the "
  + "caller then parses the prose";

const GUARDED: Record<string, string> = {
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
    "takes NO flags — it is configured entirely by environment, so any flag passed to it today is discarded in silence. The `--model` in its output is `-e ",
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
  "packages/lab/scripts/corpus-snapshot.mjs":
    "a mistyped --out= writes the snapshot where you will not look for it",
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
  "packages/worker-fleet/src/fleet-discover.mjs":
    "--enroll WRITES to inventory.yml; mistyped it scans and enrols nothing",
  "packages/worker-fleet/src/fleet-env.mjs":
    "its output is eval-ed by a shell, so a wrong shape is executed rather than read",
  "packages/worker-fleet/src/fleet-wake.mjs":
    "takes no flags",
  "packages/worker-fleet/src/normalise-fleet.mjs":
    "takes no flags",
  "packages/lab/src/training/wait-for-capture.mjs":
    "its EXIT CODE is the contract — 0 clean, 1 failures, 2 no run, 3 wedged — so a caller reading it "
    + "has already committed to an output shape, and a mistyped `--json` gives it the other one",
  "packages/worker-fleet/src/doctor.mjs": JSON_REPORTER,
  "packages/worker-fleet/src/fleet-status.mjs": JSON_REPORTER,
  "packages/lab/src/training/capture-status.mjs": JSON_REPORTER,
  "packages/lab/scripts/lab-inventory.mjs": JSON_REPORTER,
};


/**
 * Not yet guarded. THIS LIST MAY ONLY SHRINK.
 *
 * It is not an exemption — every one of these ignores an unrecognised flag today. It exists so that a NEW
 * CLI cannot join them without a test failing, which is the difference between a known gap and an unknown
 * one. Guarding one means deleting its line.
 */
const UNGUARDED = new Set<string>([
  // EMPTY, as of 2026-08-27. Every `.mjs` that reads argv refuses a flag it does not know.
  //
  // Kept rather than deleted: the test below discovers every argv-reading module and requires each to be
  // guarded or listed here WITH A REASON. An empty set means the discovery has nothing to forgive, and
  // deleting it would remove the only place a future exemption has to justify itself.
]);

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
  const roots = ["packages/lab", "packages/worker-fleet"]
    .flatMap((pkg) => ["src", "scripts"].map((sub) => `${pkg}/${sub}`));
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
    assert.ok(!UNGUARDED.has(path), `${path} is guarded; delete its UNGUARDED line`);
  }
});

test("the unguarded list names files that exist", () => {
  // A stale entry is a list that lies: it silently exempts nothing while making the gap look larger than
  // it is, and it would hide a rename — the renamed file would fail the next test as a surprise, and the
  // obvious fix would be to add it rather than to notice it was already meant to be there.
  for (const path of UNGUARDED) {
    assert.ok(existsSync(join(REPO, path)), `${path} is on the unguarded list and does not exist`);
  }
});

test("a new CLI cannot quietly join the unguarded ones", () => {
  // The rollout is partial and that is a decision, but an UNCOUNTED gap is not one. Anything discovered
  // that is neither guarded nor on the known list fails here, so the list can only shrink.
  const surprises = commandLineModules()
    .filter((path) => !(path in GUARDED) && !UNGUARDED.has(path));
  assert.deepEqual(surprises, [],
    "these read argv and neither refuse unknown flags nor appear in UNGUARDED. Guard them "
    + "(preferred — an ignored flag runs the default and reports success), or add them with a reason");
});

test("CLAUDE.md states the real guarded count, and that nothing is exempt", () => {
  // I updated this number by hand three times and TWICE the edit silently did not match, so the doc read
  // "Guarded on the five" through several commits whose messages said otherwise. A number a human retypes
  // is a number that drifts — this repo's own rule, which I broke while applying it elsewhere.
  const doc = readFileSync(join(REPO, "CLAUDE.md"), "utf8");
  const stated = doc.match(/\*\*ALL (\d+) are guarded/);
  assert.ok(stated, "CLAUDE.md must state the count as `**ALL N are guarded`");
  assert.equal(Number(stated[1]), Object.keys(GUARDED).length, "CLAUDE.md's guarded count is stale");
  // And the claim that nothing is exempt must be true, not just written.
  assert.equal(UNGUARDED.size, 0,
    "CLAUDE.md says the exemption list is empty; if you add one, say so there and give a reason here");
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

test("positionals are still not this guard's business", () => {
  // The reason the filter cannot simply be `startsWith("-")`: these commands take URLs, worker addresses
  // and page paths, and refusing one would break correct usage — the failure mode the derived-flag-list
  // note in CLAUDE.md records for five other commands. `-` followed by a LETTER is the discriminator.
  assert.deepEqual(unknownFlags(["https://example.com"], ["--ref="]), []);
  assert.deepEqual(unknownFlags(["/pages/index.html"], ["--ref="]), []);
  assert.deepEqual(unknownFlags(["--"], ["--ref="]), []);          // npm's separator
  assert.deepEqual(unknownFlags(["-5"], ["--ref="]), []);          // a negative number is not a flag
});
