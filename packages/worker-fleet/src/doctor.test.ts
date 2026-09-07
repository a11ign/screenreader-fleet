/**
 * `doctor.mjs` never asked WHOSE dist a cross-package import resolves to (#256). Measured 2026-09-07: 5
 * of 26 live worktrees resolved `@a11y-witness/*` to the PRIMARY checkout's `dist` via a shared
 * `node_modules` symlink, and the primary's own `dist` was older than its own source -- nine commits and
 * roughly 36 hours stale. Two agents running the identical command in adjacent worktrees got answers built
 * from code nine commits apart, and nothing anywhere said so.
 *
 * The remedy CLAUDE.md already recorded and nothing automated: "Verify WHOSE, by resolving the exact
 * specifier you import" -- not the package name, since a package can export subpaths from elsewhere and
 * resolving `@a11y-witness/judge` does not prove `@a11y-witness/judge/rules` came from the same tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolvesToThisCheckout, checkoutRootFor, newestMtimeMs, distIsStale,
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

// --- newestMtimeMs: real filesystem, real mtimes ---

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "doctor-dist-fixture-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("newestMtimeMs finds the newest file mtime recursively, across subdirectories", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "old.js"), "old");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "new.js"), "new");
    const oldTime = new Date("2020-01-01").getTime() / 1000;
    const newTime = new Date("2026-01-01").getTime() / 1000;
    utimesSync(join(dir, "old.js"), oldTime, oldTime);
    utimesSync(join(dir, "sub", "new.js"), newTime, newTime);
    const newest = newestMtimeMs(dir);
    assert.ok(newest !== null);
    assert.equal(Math.round(newest! / 1000), Math.round(newTime));
  });
});

test("newestMtimeMs returns null for a directory that does not exist -- distinct from 0", () => {
  assert.equal(newestMtimeMs("/does/not/exist/at/all"), null);
});

test("newestMtimeMs returns null for a genuinely empty directory, never 0 standing in for 'oldest possible'", () => {
  withTempDir((dir) => {
    assert.equal(newestMtimeMs(dir), null);
  });
});

// --- distIsStale: pure, and the null/false distinction is the whole point ---

test("distIsStale: source strictly newer than dist is TRUE", () => {
  assert.equal(distIsStale(2000, 1000), true);
});

test("distIsStale: dist newer than or equal to source is FALSE -- a fresh build", () => {
  assert.equal(distIsStale(1000, 2000), false);
  assert.equal(distIsStale(1000, 1000), false);
});

test("distIsStale: either side unreadable is NULL, never coerced to false -- 'could not tell' and 'fresh' need opposite responses", () => {
  assert.equal(distIsStale(null, 1000), null);
  assert.equal(distIsStale(1000, null), null);
  assert.equal(distIsStale(null, null), null);
});

// --- END TO END, real fixture: a stale dist under a foreign checkout, reproducing the #256 incident shape ---

test("THE #256 SHAPE: a foreign checkout whose dist predates its own source is BOTH detected -- wrong checkout AND stale", () => {
  withTempDir((dir) => {
    const foreignRoot = join(dir, "a11y-witness");
    const srcDir = join(foreignRoot, "packages", "judge", "src");
    const distDir = join(foreignRoot, "packages", "judge", "dist");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    const distTime = new Date("2026-09-05T17:21:00Z").getTime() / 1000;
    const srcTime = new Date("2026-09-07T04:58:00Z").getTime() / 1000; // newer -- source moved after the build
    writeFileSync(join(distDir, "rules.js"), "compiled");
    utimesSync(join(distDir, "rules.js"), distTime, distTime);
    writeFileSync(join(srcDir, "rules.ts"), "source");
    utimesSync(join(srcDir, "rules.ts"), srcTime, srcTime);

    const resolvedRealPath = join(foreignRoot, "packages", "judge", "dist", "rules.js");
    const thisCheckoutRoot = join(dir, "wt-mine");

    assert.equal(resolvesToThisCheckout(resolvedRealPath, thisCheckoutRoot), false,
      "the whole incident starts here -- a worktree reading a DIFFERENT checkout's compiled output");
    assert.equal(checkoutRootFor(resolvedRealPath), foreignRoot);

    const stale = distIsStale(newestMtimeMs(srcDir), newestMtimeMs(distDir));
    assert.equal(stale, true, "the half a resolution check ALONE misses -- the foreign dist is also stale");
  });
});
