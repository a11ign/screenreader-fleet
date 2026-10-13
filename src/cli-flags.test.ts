// Relocated from control/src/fleet-layer/cli-flags.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * A flag this command does not read must be refused, not ignored.
 *
 * Every CLI parses argv by looking for the flags it knows, so anything else is silently dropped and the command
 * runs its default -- the same defect as an Ansible extra var a job does not read, one layer out. Measured twice:
 * a blocker told the reader to run `--write-baseline` when the flag is `--update-baseline`, and
 * `--only=route-title-stale` covered 1 of that family's 7 cases.
 *
 * This file is the unit half of that guard (the functions in `cli-flags.ts`) and the one end-to-end proof that it
 * fires through a symlink. It does not walk any tree for the CLIs that call it: which commands are guarded is a
 * question about the consuming repository, not about this module.
 *
 * `fleet-env.test.ts` is the other half of the story: it pins that this copy and the toolchain's reach the same
 * verdict on every flag shape, and that this file loads with no install. Those prove EQUIVALENCE; the tests below
 * pin the BEHAVIOUR, so a bug fixed in one copy only is caught by the first and a bug in both is caught here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { unknownFlags, didYouMean, nameOf, refuseUnknownFlags, flagValue } from "./cli-flags.ts";

const CLI_FLAGS = fileURLToPath(new URL("./cli-flags.ts", import.meta.url));

test("only flags a command reads are accepted; the rest are named", () => {
  assert.deepEqual(unknownFlags(["--only=x", "--nope", "page.html", "--"], ["--only=", "--resume"]),
    ["--nope"], "a bare `--` is npm's separator, and a positional is not this guard's business");
  assert.deepEqual(unknownFlags(["--resume"], ["--only=", "--resume"]), []);
  assert.equal(nameOf("--shard=0/4"), "--shard", "`--shard=0/4` and `--shard` name the same flag");
});

test("a near miss is named, and a wild guess is not", () => {
  // The exact case recorded in the repository's CLAUDE.md: a blocker's own message named a flag that does not exist.
  assert.equal(didYouMean("--write-baseline", ["--update-baseline", "--json"]), "--update-baseline");
  assert.equal(didYouMean("--resmue", ["--resume", "--only="]), "--resume");
  assert.equal(didYouMean("--wildly-different-thing", ["--json"]), undefined,
    "suggesting anything for an unrelated flag sends the reader somewhere wrong with confidence");
});

test("the guard never fires on an IMPORTING command's flags", () => {
  // THE DEFECT THIS INTRODUCED, an hour after the guards went in. These calls sit at module top level, so
  // they run on IMPORT -- and then inspect the importing process's argv. `capture-real-pages
  // --role=calibration` imports `fleet-env`, whose guard woke up, saw `--role`, decided it did not
  // know it, and killed a 50-page capture with "unknown flag --role -- did you mean --list?".
  //
  // The guard was right about its own flags and asking the wrong process. A check that fails somebody
  // else's correct command is worse than no check: it is the crying-wolf failure that gets guards deleted.
  assert.doesNotThrow(() =>
    refuseUnknownFlags(["--list"], { entry: "file:///some/other/module.mjs", argv: ["--role=x"] }),
    "an imported module must ignore the importer's flags entirely");

  // `entry` is REQUIRED, not defaulted, for the reason `createHostThrottle`'s `minGapMs` is: a default
  // would silently restore this behaviour for any caller who forgot it.
  // Cast because the types REQUIRE `entry` -- TypeScript rejects this call outright, which is the
  // required-parameter design working. The runtime guard covers the callers nothing typechecks.
  assert.throws(() => refuseUnknownFlags(["--list"], { argv: ["--nope"] } as never),
    /needs \{ entry: import\.meta\.url \}/,
    "a call without entry must fail loudly rather than guard the wrong process");
});

test("a SINGLE-DASH flag is refused, because an ansible-shaped argument silently vanished", () => {
  // Measured 2026-09-05. `npm run fleet:provision -- -e worker_edge_allow_downgrade=true` passed this
  // guard untouched (it inspected only `--` arguments), was not forwarded by the wrapper (which builds
  // ansible's argv itself), and a 14-minute whole-fleet provision ran WITHOUT the authorisation the
  // operator believed they had given. The role then refused with a message naming the flag just passed.
  //
  // Several commands here wrap `ansible-playbook`, whose own arguments are single-dash, so this shape is
  // the one an operator is most likely to reach for by analogy -- and it was the one shape not checked.
  assert.deepEqual(unknownFlags(["-e", "job=train"], ["--ref="]), ["-e"]);
  assert.deepEqual(unknownFlags(["-l", "a11y-worker-3"], ["--limit="]), ["-l"]);
});

test("flagValue: the five vectors measured across all fifteen pre-existing hand-rolled copies", () => {
  // audit §9 "argv parsing". These five are what distinguished the fourteen-file majority from the one
  // outlier (`fleet-discover.ts`'s `.split("=")[1]`) before this function existed.
  assert.equal(flagValue(["--url=http://host"], "url"), "http://host", "a normal value");
  assert.equal(flagValue([], "url"), undefined, "a missing flag is undefined, not an empty string");
  assert.equal(flagValue(["--url="], "url"), "", "an explicitly empty value is '', not undefined");
  assert.equal(flagValue(["--url=first", "--url=second"], "url"), "first", "first occurrence wins");
  assert.equal(flagValue(["--url=http://host?a=b"], "url"), "http://host?a=b",
    "a value containing its own '=' is preserved whole -- this is the vector fleet-discover.ts's "
    + "`.split(\"=\")[1]` got wrong, truncating to 'http://host?a'");
  assert.equal(flagValue(["--worker", "http://x"], "worker"), undefined,
    "the space-separated form is not supported by any of the fifteen originals, and this must not "
    + "silently start accepting it -- that would be a parsing behaviour change, not a deduplication");
});

test("positionals are still not this guard's business", () => {
  // The reason the filter cannot simply be `startsWith("-")`: these commands take URLs, worker addresses
  // and page paths, and refusing one would break correct usage. `-` followed by a LETTER is the discriminator.
  assert.deepEqual(unknownFlags(["https://example.com"], ["--ref="]), []);
  assert.deepEqual(unknownFlags(["/pages/index.html"], ["--ref="]), []);
  assert.deepEqual(unknownFlags(["--"], ["--ref="]), []);          // npm's separator
  assert.deepEqual(unknownFlags(["-5"], ["--ref="]), []);          // a negative number is not a flag
});

test("the guard fires through a SYMLINK, because npm's own .bin entries are symlinks", () => {
  // #237. An entry guard in the realpath'd form resolves `argv[1]`; `refuseUnknownFlags`'s OWN comparison
  // did not. So through a symlink the outer condition was TRUE and this one FALSE: `main()` ran and the
  // flag guard returned early having inspected nothing.
  //
  // Measured on `board-schedule-liveness`, same file, same flag, before and after:
  //
  //   before:  via symlink exit 0, "--bogusflag" IGNORED   |  direct exit 2, refused
  //   after:   via symlink exit 2, refused                 |  direct exit 2, refused
  //
  // Through the symlink the mistyped flag ran the default and reported success -- which is the sentence
  // the refusal itself prints as the reason it exists. A remedy whose TRIGGER is narrower than the thing
  // it guards, the `refreshBrowseBuffer` shape.
  //
  // It matters beyond a hand-made link: **npm creates `.bin` entries as symlinks**, so any CLI this package
  // ever exposes as a `bin` is invoked through one.
  //
  // Driven end to end through a REAL child process rather than by calling the function, because the whole
  // defect lives in `process.argv[1]` versus `import.meta.url` -- a unit call cannot express it.
  //
  // The DIRECT leg and the KNOWN-flag leg are this test's positive controls: the first proves the guard fires
  // at all in this harness (so exit 2 through the link is not an artefact of the script failing to start), the
  // last that a clean command still runs (so exit 2 is not "everything is refused").
  const dir = mkdtempSync(join(tmpdir(), "a11y-flagguard-"));
  try {
    const real = join(dir, "real-command.mjs");
    writeFileSync(real, [
      `import { realpathSync } from "node:fs";`,
      `import { pathToFileURL } from "node:url";`,
      `import { refuseUnknownFlags } from ${JSON.stringify(pathToFileURL(CLI_FLAGS).href)};`,
      `if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {`,
      `  refuseUnknownFlags(["--known"], { entry: import.meta.url, command: "real-command" });`,
      `  console.log("RAN");`,
      `}`,
    ].join("\n"));
    const link = join(dir, "via-symlink.mjs");
    symlinkSync(real, link);

    const direct = spawnSync(process.execPath, [real, "--bogus"], { encoding: "utf8" });
    assert.equal(direct.status, 2, `invoked directly, an unknown flag must be refused: ${direct.stderr}`);

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
