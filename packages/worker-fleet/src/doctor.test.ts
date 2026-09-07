/**
 * `doctor.mjs` never asked WHOSE dist a cross-package import resolves to (#256). Measured 2026-09-07: 5
 * of 26 live worktrees resolved `@a11y-witness/*` to the PRIMARY checkout's `dist` via a shared
 * `node_modules` symlink. Two agents running the identical command in adjacent worktrees could get
 * answers built from different code, and nothing anywhere said so.
 *
 * The remedy CLAUDE.md already recorded and nothing automated: "Verify WHOSE, by resolving the exact
 * specifier you import" -- not the package name, since a package can export subpaths from elsewhere and
 * resolving `@a11y-witness/judge` does not prove `@a11y-witness/judge/rules` came from the same tree.
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
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolvesToThisCheckout, checkoutRootFor, tscProjectUpToDate,
} from "./doctor.mjs";

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
    resolvesToThisCheckout("/Users/x/a11y-witness/packages/judge/dist/rules.js", "/Users/x/wt-a"),
    false,
  );
});

// --- checkoutRootFor: pure ---

test("checkoutRootFor: everything before the first /packages/ segment", () => {
  assert.equal(
    checkoutRootFor("/Users/x/a11y-witness/packages/judge/dist/rules.js"),
    "/Users/x/a11y-witness",
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
    const foreignRoot = join(dir, "a11y-witness");
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
