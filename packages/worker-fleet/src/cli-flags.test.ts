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
import { unknownFlags, didYouMean, nameOf } from "./cli-flags.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The CLIs whose flags are guarded, and the cost each one's silent default has.
 *
 * A partial rollout, deliberately: these are the five where an ignored flag has a MEASURED cost, and the
 * flag list was read out of each file rather than derived. `UNGUARDED` below is the rest, listed so the
 * gap is countable instead of invisible.
 */
const GUARDED: Record<string, string> = {
  "packages/lab/src/training/capture-screenreader-dataset.mjs":
    "a typo costs a full corpus run — `--resmue` silently means a fresh capture of 1,061 pairs",
  "packages/worker-fleet/src/lab-pipeline.mjs":
    "a mistyped `--ref=` falls back to the local branch, which is how the fleet and the lab came to be "
    + "on different commits, failing with a hash mismatch that reads like a corrupted checkout",
  "packages/lab/scripts/promote-model.mjs":
    "the most dangerous silent default in the repo: a mistyped `--dry-run` PROMOTES",
  "packages/lab/src/training/check-signals.mjs":
    "a mistyped `--require-complete` scores whatever is on disk and passes",
  "packages/lab/src/training/repeat-capture.mjs":
    "`--probe-forms` and `--probe-tables` are how a canary reaches the fields carrying interaction "
    + "evidence, and a canary that cannot express the fault is worthless",
};

/**
 * Not yet guarded. THIS LIST MAY ONLY SHRINK.
 *
 * It is not an exemption — every one of these ignores an unrecognised flag today. It exists so that a NEW
 * CLI cannot join them without a test failing, which is the difference between a known gap and an unknown
 * one. Guarding one means deleting its line.
 */
const UNGUARDED = new Set([
  "packages/lab/scripts/audit-corpus-starvation.mjs", "packages/lab/scripts/audit-size-sensitivity.mjs",
  "packages/lab/scripts/bench-capture.mjs", "packages/lab/scripts/build-realism-tier.mjs",
  "packages/lab/scripts/calibrate-abstention.mjs", "packages/lab/scripts/compare-layers.mjs",
  "packages/lab/scripts/corpus-backup.mjs", "packages/lab/scripts/corpus-snapshot.mjs",
  "packages/lab/scripts/emit-grants-map.mjs", "packages/lab/scripts/evidence-check.mjs",
  "packages/lab/scripts/explain-scorer.mjs", "packages/lab/scripts/lab-inventory.mjs",
"packages/lab/scripts/retrain-pipeline.mjs",
  "packages/lab/scripts/stability-gate.mjs", "packages/lab/scripts/verify-safetensors.mjs",
  "packages/lab/src/harnesses/assert-action-report.mjs", "packages/lab/src/harnesses/capture-check.mjs",
  "packages/lab/src/harnesses/capture-fixtures.mjs",
  "packages/lab/src/harnesses/occurrence-verdict-stability.mjs",
  "packages/lab/src/harnesses/page-identity-rate.mjs",
  "packages/lab/src/training/capture-real-pages.mjs", "packages/lab/src/training/capture-status.mjs",
  "packages/lab/src/training/export-screenreader-dataset.mjs",
  "packages/lab/src/training/generate-screenreader-acceptance.mjs",
  "packages/lab/src/training/generate-screenreader-dataset.mjs",
  "packages/lab/src/training/preflight-screenreader-dataset.mjs",
  "packages/lab/src/training/wait-for-capture.mjs",
  "packages/worker-fleet/src/check-worker-code.mjs", "packages/worker-fleet/src/compare-workers.mjs",
  "packages/worker-fleet/src/deploy-worker.mjs", "packages/worker-fleet/src/doctor.mjs",
  "packages/worker-fleet/src/fleet-discover.mjs", "packages/worker-fleet/src/fleet-env.mjs",
  "packages/worker-fleet/src/fleet-playbook.mjs", "packages/worker-fleet/src/fleet-status.mjs",
  "packages/worker-fleet/src/fleet-wake.mjs", "packages/worker-fleet/src/guest-run.mjs",
  "packages/worker-fleet/src/normalise-fleet.mjs",
]);

/** Does this file take a command line? The guard itself reads argv, and is the implementation. */
function isCommandLine(rel: string): boolean {
  if (!rel.endsWith(".mjs")) return false;
  const source = readFileSync(join(REPO, rel), "utf8");
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
