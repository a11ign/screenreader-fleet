import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_FILE, checkMjsRatchet, findBaselineRoot } from "@a11ign/toolchain/mjs-ratchet";

// THIS REPOSITORY COUNTS ITS .js/.mjs/.cjs SOURCE AGAINST A COMMITTED BASELINE (a11ign/a11ign#4264; the function is the toolchain's, #4243).
// The baseline is found by walking up from THIS FILE, so the layout flatten (#4216) moves the test and edits nothing. The cases for the
// check itself are the toolchain's; what is pinned here is that THIS tree passes, and that the call bites on this repository's own layout.

const here = fileURLToPath(import.meta.url);

type Baseline = { files: string[]; exceptions: { path: string; why: string }[] };

/** A copy of the repository's tracked files, with `edit` applied to its baseline: the real tree is never written. */
function withBaselineCopy(edit: (baseline: Baseline) => Baseline, check: (copyRoot: string) => void): void {
  const root = findBaselineRoot(here);
  const copy = mkdtempSync(join(tmpdir(), "mjs-ratchet-"));
  try {
    cpSync(root, copy, { recursive: true, filter: (source) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(source.slice(root.length)) });
    const baseline = JSON.parse(readFileSync(join(copy, BASELINE_FILE), "utf8")) as Baseline;
    writeFileSync(join(copy, BASELINE_FILE), JSON.stringify(edit(baseline)));
    check(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

test("the repository's .mjs/.js/.cjs source does not exceed its committed baseline", () => {
  const result = checkMjsRatchet({ from: here });
  assert.equal(result.ok, true, result.message);
  // The positive control: the read found this repository's own scripts, so 'ok' is not 'the walk read nothing'.
  assert.ok(result.count > 0, `the ratchet counted ${result.count} files in ${result.root}`);
});

test("the baseline is at the repository root, found from this file", () => {
  assert.equal(findBaselineRoot(here), fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""));
});

test("a baseline with one name removed fails and names the file", () => {
  withBaselineCopy(
    (baseline) => ({ ...baseline, files: baseline.files.filter((name) => name !== "eslint.config.mjs") }),
    (copy) => {
      const result = checkMjsRatchet({ from: copy });
      assert.equal(result.ok, false);
      assert.match(result.message, /eslint\.config\.mjs/);
    },
  );
});

test("an emptied baseline fails and names every file the tree holds", () => {
  withBaselineCopy(
    (baseline) => ({ ...baseline, files: [] }),
    (copy) => {
      const result = checkMjsRatchet({ from: copy });
      assert.equal(result.ok, false);
      for (const name of ["eslint.config.mjs", "rstest.config.mjs", "rslib.config.mjs", "isolation-smoke.mjs"]) assert.match(result.message, new RegExp(name.replace(".", "\\.")));
    },
  );
});

test("a baseline listing a file the tree lacks passes and says it can be lowered", () => {
  withBaselineCopy(
    (baseline) => ({ ...baseline, files: [...baseline.files, "gone-since.mjs"] }),
    (copy) => {
      const result = checkMjsRatchet({ from: copy });
      assert.equal(result.ok, true, result.message);
      assert.match(result.message, /can be lowered/);
    },
  );
});

test("an exception with no why fails", () => {
  withBaselineCopy(
    (baseline) => ({ ...baseline, exceptions: [{ path: "rstest.config.mjs", why: "" }] }),
    (copy) => {
      const result = checkMjsRatchet({ from: copy });
      assert.equal(result.ok, false);
      assert.match(result.message, /why/);
    },
  );
});
