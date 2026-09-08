/**
 * A flag this command does not read must be refused, not ignored.
 *
 * Every CLI in this repo parses argv by looking for the flags it knows, so anything else is silently
 * dropped and the command runs its default — the same defect as an Ansible extra var a job does not read,
 * one layer out. Measured twice here: a blocker told the reader to run `--write-baseline` when the flag is
 * `--update-baseline`, and `--only=route-title-stale` covered 1 of that family's 7 cases.
 *
 * ## "guarded" is DERIVED from source, never a hand-typed census — A2, #453, 2026-09-08
 *
 * This file used to carry a `GUARDED: Record<path, reason>` map, one entry per CLI, and every new argv-
 * reading script needed a PR to THIS file adding one. That map was this repo's second-hottest hotspot: 20
 * PRs touched it, and five checks went blind to their own population in the same week for the identical
 * shape — a registry a human has to remember to update is a registry that falls behind the tree.
 *
 * `callsTheGuard()` below answers the only question that ever mattered — does this file's own source
 * contain a real call to `refuseUnknownFlags(` — by reading the file, not a list about the file. A new
 * guarded CLI registers itself by calling the guard; nothing here needs editing. What each entry's REASON
 * used to hold is not lost: every one of those ~100 reason strings duplicated commentary that already
 * lives in the file itself (verified before deleting the map — every file this test now derives against
 * carries well over a thousand characters of its own header prose), which is the fact-stated-twice shape
 * this repo's own `CLAUDE.md` names repeatedly. Comments explaining a specific flag's risk belong beside
 * that flag, in the file that has it — not in a second copy a reviewer has to trust is still current.
 *
 * `UNGUARDED` is the one list still hand-typed, deliberately: it is a small, closed set of GENUINE
 * exemptions, each a decision with a reason attached, not a population to enumerate. "Guarded or exempt"
 * is a fact about two different things — what the tree already does, and what somebody decided not to
 * require — and only the second one is the kind of fact worth a human writing down.
 *
 * ## Why the flag LIST inside a guarded file still pins rather than derives
 *
 * The obvious test — read each CLI's source, regex out its `--flags`, assert the declared list matches —
 * CANNOT be trusted here, and finding that out is the reason `unknownFlags`/`refuseUnknownFlags` take an
 * explicit list rather than inferring one. `stability-gate` builds its flags from a variable
 * (`startsWith(`--${name}=`)`), and `repeat-capture` reads all seven of its value flags through an
 * `arg(name)` helper. A derivation reports ZERO flags for both, so the assertion would pass having
 * examined nothing — this repo's most-repeated defect, in the guard written to prevent it. That is a
 * narrower claim than "never derive": WHICH FILES call the guard is safe to derive by reading for the
 * call itself; WHICH FLAGS a guard accepts is not, because a flag can be read through an alias, a loop or
 * a helper a regex cannot see through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { stripComments } from "@a11ign/evidence/source-text";
import { unknownFlags, didYouMean, nameOf, refuseUnknownFlags, flagValue } from "./cli-flags.mjs";
import { commandLineModules } from "./command-line-census.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Not yet guarded. THIS LIST MAY ONLY SHRINK.
 *
 * It is not an exemption — every one of these ignores an unrecognised flag today. It exists so that a NEW
 * CLI cannot join them without a test failing, which is the difference between a known gap and an unknown
 * one. Guarding one means deleting its line.
 */
const UNGUARDED: Record<string, string> = {
  "scripts/run.mjs":
    "the command DISPATCHER (A3). Its argv is `<command name> [everything the command takes]`, and "
    + "everything after the name belongs to the child, not to it -- `refuseUnknownFlags` here would "
    + "refuse `node scripts/run.mjs merge-guard --pr=123` for a flag that is `merge-guard`'s and is "
    + "perfectly valid. It refuses on its own terms instead, which is the same guarantee by the only "
    + "route open to it: an unrecognised command NAME is refused with the near miss named, never ignored, "
    + "because a dispatcher that ran nothing and exited 0 would make \"no such command\" and \"the "
    + "command found nothing\" the same observation. `command-dispatcher.test.ts` pins that refusal.",
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
 * `commandLineModules()` -- every `.mjs` under this repo's known CLI roots that reads argv -- now lives in
 * `command-line-census.mjs`, a sibling of `cli-flags.mjs` (A2, #453). Moved there rather than kept local
 * so a SECOND consumer asking a DIFFERENT question about the same population (A6b: which scripts declare
 * an entry-point guard) filters the same walk instead of writing its own `readdirSync` that could silently
 * narrow from this one's -- that file's own header has the full reasoning for why the walk is shared and
 * the predicate is not. `commandLineModules(REPO)` below is what this file was calling `commandLineModules()`
 * before the move; nothing about ITS behaviour changed.
 */

/**
 * IS THIS FILE ITSELF GUARDED? — read from its own source, never from a registry about it.
 *
 * This is the whole of A2/#453's fix for this census: "guarded" used to mean "has an entry in a
 * hand-typed `GUARDED` map", which meant every new guarded CLI needed a PR to THIS file. It now means
 * "its own source calls `refuseUnknownFlags(`", which a new CLI satisfies by calling the guard — nothing
 * here to edit. Comments are stripped first, for the identical reason `command-line-census.mjs`'s
 * `readsArgv` strips them: a file that only MENTIONS the call in prose (a README-style comment, a "TODO:
 * guard this") must not read as already guarded.
 */
function callsTheGuard(rel: string): boolean {
  const source = stripComments(readFileSync(join(REPO, rel), "utf8"));
  return /refuseUnknownFlags\s*\(/.test(source);
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

test("the unguarded list names files that exist and are not already guarded", () => {
  // A stale entry is a list that lies two different ways: it silently exempts nothing while making the
  // gap look larger than it is (a rename, checked below), or it goes on claiming an exemption for a file
  // that has since started calling the guard itself (checked here) — the second is the direction that
  // matters most now that "guarded" is derived, because nothing else would ever notice a stale UNGUARDED
  // line once its file was fixed.
  for (const path of Object.keys(UNGUARDED)) {
    assert.ok(existsSync(join(REPO, path)), `${path} is on the unguarded list and does not exist`);
    assert.ok(!callsTheGuard(path),
      `${path} now calls refuseUnknownFlags -- delete its UNGUARDED line, the file is guarded`);
  }
});

test("a new CLI cannot quietly join the unguarded ones", () => {
  // NO LIST TO EDIT for the guarded case, which is the entire point of A2/#453: a file is classified by
  // calling the guard, not by somebody adding it here. Only a DELIBERATE exemption still needs a line, in
  // UNGUARDED, with a reason.
  const surprises = commandLineModules(REPO)
    .filter((path) => !callsTheGuard(path) && !(path in UNGUARDED));
  assert.deepEqual(surprises, [],
    "these read argv and neither call refuseUnknownFlags nor appear in UNGUARDED. Call the guard in the "
    + "file itself (preferred — an ignored flag runs the default and reports success), or add an entry "
    + "to UNGUARDED with a reason.");
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
  // call sites that no test happens to execute. Iterates the DISCOVERED guarded set, not a registry --
  // a new guarded file is covered the moment it calls the guard, same as the census test above.
  const offenders: string[] = [];
  for (const path of commandLineModules(REPO).filter(callsTheGuard)) {
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
