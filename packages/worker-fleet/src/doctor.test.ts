/**
 * `doctor.mjs` never asked WHOSE dist a cross-package import resolves to (#256). Measured 2026-09-07: 5
 * of 26 live worktrees resolved `@a11ign/*` to the PRIMARY checkout's `dist` via a shared
 * `node_modules` symlink. Two agents running the identical command in adjacent worktrees could get
 * answers built from different code, and nothing anywhere said so.
 *
 * The remedy CLAUDE.md already recorded and nothing automated: "Verify WHOSE, by resolving the exact
 * specifier you import" -- not the package name, since a package can export subpaths from elsewhere and
 * resolving `@a11ign/judge` does not prove `@a11ign/judge/rules` came from the same tree.
 *
 * FRESHNESS IS `tsc --build --dry`, NEVER A RAW MTIME COMPARISON -- a wrong first version of this file
 * compared `newestMtimeMs(srcDir)` against `newestMtimeMs(distDir)`, and the row's own filer retracted
 * their initial "36 hours stale" claim once it was measured against a directory mtime (which does not
 * move on rewrite) rather than a real one. The corrected, LIVE measurement: `git checkout` resets file
 * mtimes on every file it touches with no content change at all, so switching branches alone makes
 * several source files read newer than an already-correct `dist` -- and `tsc --build --dry` still
 * correctly reports "is up to date" in exactly that case, because it is content-addressed, not mtime-
 * addressed. A raw mtime comparison would flag every worktree as stale the moment `git checkout` runs,
 * permanently -- the "readiness command that cries wolf" `advise`'s own doc warns against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolvesToThisCheckout, checkoutRootFor, tscProjectUpToDate, fleetAgreementLine,
} from "./doctor.mjs";
import { MUST_MATCH } from "./fleet-consistency.mjs";

// --- resolvesToThisCheckout: pure ---

test("resolvesToThisCheckout: a path under the checkout's own root is this checkout", () => {
  assert.equal(
    resolvesToThisCheckout("/Users/x/wt-a/packages/judge/dist/rules.js", "/Users/x/wt-a"),
    true,
  );
});

test("resolvesToThisCheckout: a path under a DIFFERENT checkout is not, even a sibling with a shared prefix", () => {
  // The trap this function exists to avoid: naive prefix matching would call `/Users/x/wt-ab` a match for
  // root `/Users/x/wt-a` because the STRING `/Users/x/wt-a` is a prefix of it -- the trailing `/` in the
  // comparison is what a bare `startsWith(root)` misses.
  assert.equal(
    resolvesToThisCheckout("/Users/x/wt-ab/packages/judge/dist/rules.js", "/Users/x/wt-a"),
    false,
  );
});

test("resolvesToThisCheckout: the root itself, with no trailing content, is still this checkout", () => {
  assert.equal(resolvesToThisCheckout("/Users/x/wt-a", "/Users/x/wt-a"), true);
});

test("MUTATION target: a resolution genuinely OUTSIDE the checkout is genuinely false, not vacuously true", () => {
  // If this ever reads true unconditionally (the mutation this row's acceptance names -- "make the
  // resolution check always report own-tree"), this assertion is exactly what catches it.
  assert.equal(
    resolvesToThisCheckout("/Users/x/a11ign/packages/judge/dist/rules.js", "/Users/x/wt-a"),
    false,
  );
});

// --- checkoutRootFor: pure ---

test("checkoutRootFor: everything before the first /packages/ segment", () => {
  assert.equal(
    checkoutRootFor("/Users/x/a11ign/packages/judge/dist/rules.js"),
    "/Users/x/a11ign",
  );
});

test("checkoutRootFor: null for a path that does not look like this repo's own layout", () => {
  assert.equal(checkoutRootFor("/usr/local/lib/node_modules/something/index.js"), null);
});

// --- tscProjectUpToDate: the real authority, mocked at the run() boundary ---

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "doctor-dist-fixture-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tscOutput(tsconfigPath: string, verdict: "up to date" | "would build"): string {
  const line = verdict === "up to date"
    ? `08:00:00 - Project '${tsconfigPath}' is up to date`
    : `08:00:00 - A non-dry build would build project '${tsconfigPath}'`;
  return `${line}\n`;
}

test("tscProjectUpToDate: TRUE when tsc's own report says 'is up to date' for THIS project", () => {
  const tsconfigPath = "/repo/packages/judge/tsconfig.json";
  const run = () => tscOutput(tsconfigPath, "up to date");
  assert.equal(tscProjectUpToDate(tsconfigPath, { run }), true);
});

test("tscProjectUpToDate: FALSE when tsc reports this project would (re)build", () => {
  const tsconfigPath = "/repo/packages/judge/tsconfig.json";
  const run = () => tscOutput(tsconfigPath, "would build");
  assert.equal(tscProjectUpToDate(tsconfigPath, { run }), false);
});

test("tscProjectUpToDate reads the line for THIS project, not a referenced dependency's", () => {
  // `tsc --build --dry` reports on the whole reference chain in one run -- a dependency reading "up to
  // date" must never be read as THIS project's own verdict.
  const tsconfigPath = "/repo/packages/judge/tsconfig.json";
  const run = () => [
    tscOutput("/repo/packages/evidence/tsconfig.json", "up to date"),
    tscOutput(tsconfigPath, "would build"),
  ].join("");
  assert.equal(tscProjectUpToDate(tsconfigPath, { run }), false);
});

test("tscProjectUpToDate: NULL when tsc's report never mentions this project at all -- never guessed", () => {
  const tsconfigPath = "/repo/packages/judge/tsconfig.json";
  const run = () => tscOutput("/repo/packages/evidence/tsconfig.json", "up to date");
  assert.equal(tscProjectUpToDate(tsconfigPath, { run }), null);
});

test("MUTATION target: tscProjectUpToDate is NULL when the run throws with no usable stdout, never coerced to true or false", () => {
  const run = () => { throw new Error("npx: command not found"); };
  assert.equal(tscProjectUpToDate("/repo/packages/judge/tsconfig.json", { run }), null);
});

test("tscProjectUpToDate reads stdout off a thrown error too -- --dry can exit non-zero on a real config problem and still report", () => {
  const tsconfigPath = "/repo/packages/judge/tsconfig.json";
  const run = () => {
    const error = new Error("tsc exited 1") as Error & { stdout?: string };
    error.stdout = tscOutput(tsconfigPath, "would build");
    throw error;
  };
  assert.equal(tscProjectUpToDate(tsconfigPath, { run }), false);
});

test("LIVE: tscProjectUpToDate against this repo's own freshly built judge package reads TRUE", () => {
  // Not a fixture -- the real package, the real tsconfig, right after this suite's own `pretest` build.
  // If this ever reads anything but true on a clean build, the parsing itself has drifted from tsc's
  // real output shape, which no fixture can catch on its own.
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const tsconfigPath = join(repoRoot, "packages/judge/tsconfig.json");
  assert.equal(tscProjectUpToDate(tsconfigPath), true);
});

// --- END TO END: whose dist a resolution reaches is a SEPARATE fact from whether that dist is current ---

test("THE #256 SHAPE: a foreign checkout's dist is detected as foreign, and its freshness is asked independently", () => {
  withTempDir((dir) => {
    const foreignRoot = join(dir, "a11ign");
    mkdirSync(join(foreignRoot, "packages", "judge", "dist"), { recursive: true });
    const resolvedRealPath = join(foreignRoot, "packages", "judge", "dist", "rules.js");
    const thisCheckoutRoot = join(dir, "wt-mine");

    assert.equal(resolvesToThisCheckout(resolvedRealPath, thisCheckoutRoot), false,
      "the whole incident starts here -- a worktree reading a DIFFERENT checkout's compiled output");
    assert.equal(checkoutRootFor(resolvedRealPath), foreignRoot);

    const tsconfigPath = join(foreignRoot, "packages", "judge", "tsconfig.json");
    const run = () => tscOutput(tsconfigPath, "would build");
    assert.equal(tscProjectUpToDate(tsconfigPath, { run }), false,
      "the half a resolution check ALONE misses -- the foreign dist is also not up to date");
  });
});

// --- #1997/#2034: the agreement sentence names the fields EVERY compared guest reported ---

/**
 * The coverage `fleetConsistency` returns for a whole fleet: every MUST_MATCH field, reported by all of
 * them. DERIVED from `MUST_MATCH` for the reason the first test below gives about its own assertion --
 * a hand-typed list here is the same staleness one file over.
 */
const wholeCoverage = (guests: number) =>
  MUST_MATCH.map(({ path }) => ({ field: path, reported: guests, asked: guests }));

/** ...and the whole-fleet `fields`, the shape every one of these cases starts from. */
const wholeFields = (guests: number) => ({
  compared: MUST_MATCH.map(({ path }) => path), unchecked: [], coverage: wholeCoverage(guests),
});

/**
 * The whole fleet with ONE field lowered to `guests` of `of` reporters -- the fixture this family turns
 * on. At `guests: 0` it is #1997's zero case and at `guests: 1` it is #2034's partial one, and the point
 * of building both from one helper is that the two differ by that number and by nothing else.
 */
const reportedBy = ({ field, guests, of }: { field: string, guests: number, of: number }) =>
  wholeCoverage(of).map((entry) => (entry.field === field ? { ...entry, reported: guests } : entry));

/** `fleetConsistency`'s own TRUE-IF-ANYBODY lists, so the fixtures carry what the real caller passes. */
const namesExcept = (field: string) => MUST_MATCH.map(({ path }) => path).filter((p) => p !== field);

test("#1997: every MUST_MATCH field reaches doctor's agreement line, so a new one cannot leave it stale", () => {
  // The line used to read "agree on browser, screen reader, OS and protocol": FOUR names, typed by hand,
  // beside a `MUST_MATCH` that has ten. `guidepupVersion`, `architecture`, `browserProfile`,
  // `screenReaderSettings`, `provisionRevision` and `displayMode` were all compared and none was
  // mentioned -- so the sentence made a POSITIVE, false claim about its own scope from the fifth field on,
  // and no test noticed because nothing tied the words to the list.
  //
  // DERIVED FROM `MUST_MATCH` IN THE ASSERTION TOO. A test that listed the ten names here would be the
  // same defect in a second place: adding a field would need this line edited, and an editor who forgot
  // would get green. This loop grows with the list.
  const line = fleetAgreementLine({ agreeing: 10, configured: 10, fields: wholeFields(10) });
  for (const { path } of MUST_MATCH) {
    assert.ok(line.includes(path), `doctor's agreement line does not name ${path}, which it compared: ${line}`);
  }
  assert.match(line, new RegExp(`10 of 10 guests agree on ${MUST_MATCH.length} of ${MUST_MATCH.length} field\\(s\\)`),
    "with both denominators -- the guests (#920) and the fields (#1997)");

  // The positive control for the loop: it passes on any line that happens to contain the names, so a case
  // where a field is NOT named must fail it. This is that case, one field short.
  const short = fleetAgreementLine({ agreeing: 10, configured: 10,
    fields: { compared: MUST_MATCH.slice(1).map(({ path }) => path), unchecked: [],
      coverage: wholeCoverage(10).slice(1) } });
  assert.ok(!short.includes(MUST_MATCH[0].path),
    "the loop above cannot fail if every line names every field whatever it was given");
});

test("#1997: a field NO guest reported is named as not compared, never folded into the agreement", () => {
  // Measured 2026-09-22T20:09Z: `displayMode` at 0 of 10 guests while the fleet read CONSISTENT and
  // interchangeable. `doctor` did not merely fail to say so -- its sentence enumerated four other fields
  // and so asserted a scope it did not have.
  const line = fleetAgreementLine({ agreeing: 10, configured: 10,
    fields: { compared: namesExcept("displayMode"), unchecked: ["displayMode"],
      coverage: reportedBy({ field: "displayMode", guests: 0, of: 10 }) } });
  assert.match(line, /NOT compared on any guest[^:]*: displayMode/,
    "named, so a reader knows which deploy would close it");
  assert.match(line, /agree on 9 of 10 field\(s\)/, "and the agreement is stated over NINE, not ten");

  // The other direction: a fully-reporting fleet must not carry the caveat at all, or the line cries wolf
  // on every healthy reading and gets skipped.
  const clean = fleetAgreementLine({ agreeing: 10, configured: 10, fields: wholeFields(10) });
  assert.ok(!clean.includes("NOT compared"), clean);
});

test("#1997: the subset denominator survives -- agreement among the reachable is not agreement", () => {
  // #920's rule, which this line already carried and must keep: unreachable guests are skipped by the
  // caller, so without "of N configured" three agreeing guests read as a whole fleet of five.
  const fields = wholeFields(3);
  assert.match(fleetAgreementLine({ agreeing: 3, configured: 5, fields }),
    /3 of 5 guests agree .* — the rest could not be asked/);
  assert.ok(!fleetAgreementLine({ agreeing: 5, configured: 5, fields }).includes("could not be asked"));
});

// --- #2034: a field ONE guest of three reported is not something three guests agree on ---

test("#2034: a partly-reported field is OUT of the agreement list and reported with its k of N", () => {
  // Measured 2026-09-22 at #2033's head, three guests with one reporting `displayMode`:
  //   coverage: {"field":"displayMode","reported":1,"asked":3}
  //   3 of 3 guests agree on 10 compared field(s) (..., displayMode)
  // One guest's display was read, and the line NAMED it inside "guests agree on" -- worse than a count,
  // because naming is what #1997 added to make the sentence actionable. The number contradicting it was
  // in the same return value the line was built from.
  //
  // THE FIXTURE CARRIES `compared` WITH `displayMode` IN IT, because that is what `fleetConsistency`
  // really returns: `compared` is TRUE-IF-ANYBODY. A fixture that quietly dropped it from that list would
  // pass against a function still reading the list, which is the defect.
  const line = fleetAgreementLine({ agreeing: 3, configured: 3,
    fields: { compared: MUST_MATCH.map(({ path }) => path), unchecked: [],
      coverage: reportedBy({ field: "displayMode", guests: 1, of: 3 }) } });

  // THE AGREEMENT LIST ONLY, not the whole line: `displayMode` is expected LATER in the sentence, with
  // its count, so a match anywhere would pass on the defect and fail on the fix.
  const agreed = line.match(/field\(s\) \(([^)]*)\)/)?.[1];
  assert.ok(agreed !== undefined, `no agreement list to read in: ${line}`);
  assert.ok(!agreed.includes("displayMode"),
    `a field 1 of 3 guests reported is named inside the agreement list: ${line}`);
  assert.match(line, /agree on 9 of 10 field\(s\)/, "and the agreement is stated over NINE, not ten");
  assert.match(line, /reported by only SOME of the compared guests[^:]*: displayMode \(1 of 3 reported it\)/,
    "REPORTED with its count, not silently dropped -- a field missing from the list reads as one that was "
    + "not compared at all, which is #1997's clause and a different fact");
});

test("#2034: every guest reporting it and ONE guest reporting it produce different output", () => {
  // The pair that must not look alike, and the reason an assertion on either alone passes with the defect
  // present: both are `consistent: true` with the same `compared` list, and they differ only in a count.
  const compared = MUST_MATCH.map(({ path }) => path);
  const call = (coverage: { field: string, reported: number, asked: number }[]) =>
    fleetAgreementLine({ agreeing: 3, configured: 3, fields: { compared, unchecked: [], coverage } });

  const whole = call(wholeCoverage(3));
  const partial = call(reportedBy({ field: "displayMode", guests: 1, of: 3 }));
  // #2019's three facts, three sentences: `N of N` agreement, `k of N` sends a reader to the BOXES,
  // `0 of N` sends them to the FIELD. No two of them may render alike.
  const none = call(reportedBy({ field: "displayMode", guests: 0, of: 3 }));

  assert.notEqual(partial, whole, "1 of 3 reporting reads exactly like 3 of 3 -- the defect #2034 is about");
  assert.notEqual(partial, none, "1 of 3 reporting reads like nobody reporting -- #1997's clause, not this one");
  assert.notEqual(whole, none, "#1997's own distinction, which this row must not cost");

  // The positive control for all three: they pass on any function returning three distinct strings, so
  // the whole case must also be the RIGHT string -- displayMode named as agreed only when all three
  // guests reported it.
  assert.ok(whole.includes("displayMode"), whole);
  assert.match(whole, /agree on 10 of 10 field\(s\)/,
    "the healthy reading must not acquire a caveat, or the line cries wolf and gets skipped");
  assert.ok(!whole.includes("reported by only SOME"), whole);
});

test("#2034: `doctor` and `fleet:status` describe one fleet in the same words", () => {
  // Done-when 5: two commands reading one `fields` must not describe it differently. `fleet-status.mjs`
  // is READ, not imported -- `packages/control` takes no dependency on this package (ADR 0012), and the
  // sibling tests in this package read its Ansible defaults the same way.
  //
  // TWO-SIDED ON PURPOSE: the phrase is asserted against BOTH sources, so re-wording either command alone
  // fails this test and whoever re-words has to do both.
  // CONCATENATION JOINED FIRST. Both commands wrap their clause across a `\` + `\` boundary to stay
  // inside the line length, so the phrase they both PRINT appears in neither source contiguously -- a
  // plain `includes` on the raw text fails against code that says exactly the right thing.
  const joined = (source: string) => source.replace(/`\s*\+\s*`/g, "").replace(/\s+/g, " ");
  const status = joined(readFileSync(
    fileURLToPath(new URL("../../control/src/fleet-status.mjs", import.meta.url)), "utf8"));
  assert.match(status, /function partialClause\(/,
    "fleet-status.mjs no longer has the clause this parity is against -- the assertions below prove nothing");

  const line = fleetAgreementLine({ agreeing: 3, configured: 3,
    fields: { compared: MUST_MATCH.map(({ path }) => path), unchecked: [],
      coverage: reportedBy({ field: "displayMode", guests: 1, of: 3 }) } });
  for (const phrase of ["reported by only SOME of the compared guests", "${reported} of ${asked} reported it"]) {
    assert.ok(status.includes(phrase), `fleet:status no longer says "${phrase}"`);
  }
  assert.ok(line.includes("reported by only SOME of the compared guests"), line);
  assert.ok(line.includes("(1 of 3 reported it)"), line);
});

test("#2034: a caller with no coverage counts is a cannot-ask, never a pass", () => {
  // The pre-#2019 `fields` shape has answered "did anybody report each field" and not "how many", so it
  // cannot rule out the 1-of-3 case. Falling back to `compared` would restore the exact sentence this
  // family removed, and nothing would say so -- `fleet:status`' `fieldCoverageGap` takes the same line on
  // the same shape.
  const line = fleetAgreementLine({ agreeing: 3, configured: 3,
    fields: { compared: MUST_MATCH.map(({ path }) => path), unchecked: [] } });
  assert.match(line, /no field coverage was supplied/, line);
  assert.doesNotMatch(line, /agree on \d+ of \d+ field/,
    "a count nobody supplied must not be stated as one that was");
});

test("#1997: the CALL SITE uses the derived line -- an extracted helper leaves its only caller unpinned", () => {
  // `fleetAgreementLine` is pure and tested above, and that holds the FUNCTION. The three cases above all
  // pass on a `checkFleetConsistency` that ignores it and retypes the four names inline, because nothing
  // drives that function: it needs probed workers and it only ever calls `add()`. So the call is asserted
  // on the source, the same narrow exception `fleet-consistency.test.ts` states for `server.mjs`.
  const source = readFileSync(new URL("./doctor.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function checkFleetConsistency(");
  const end = source.indexOf("export function fleetAgreementLine(");
  assert.ok(start !== -1 && end > start, "doctor.mjs no longer has a checkFleetConsistency block to read");
  // COMMENTS STRIPPED, because a guard that reads source cannot tell a claim from a note ABOUT the claim:
  // the first version of this failed on the comment in `checkFleetConsistency` that QUOTES the phrase it
  // removed. Explaining a defect must not be indistinguishable from committing it.
  const isComment = (line: string) => /^\s*(\/\/|\/?\*)/.test(line);
  const block = source.slice(start, end).split("\n").filter((l) => !isComment(l)).join("\n");

  assert.match(block, /fleetAgreementLine\(\{/, "the agreement line must be DERIVED, never retyped here");
  // NEVER A FAIL, in either direction -- #2034 changes what this line SAYS, not whether `doctor` passes.
  // `checkFleetConsistency`'s own rule is that a mismatched pool is worse than a matched one and far
  // better than no pool, and a diagnostic must not be the thing that takes the fleet offline.
  assert.match(block, /add\("fleet", true, fleetAgreementLine\(/,
    "the agreement line must stay a PASS -- a coverage gap is reported, never failed");
  assert.doesNotMatch(block, /screen reader, OS/,
    "the hand-typed four-field claim is what #1997 removed -- a fifth field made it false and no test could see it");

  // The positive control for both: this matcher reads a REAL block, so it must find what is there.
  assert.match(block, /fleetConsistency\(guests\)/,
    "the slice above matched nothing recognisable, so neither assertion proves anything");
});
