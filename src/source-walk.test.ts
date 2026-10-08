import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceFiles } from "./source-walk.mjs";

/**
 * `sourceFiles` lists what is on DISK, not what git tracks, so a directory some other test plants and removes
 * while the suite runs is listed and then read after it is gone: `mjs-parses.test.ts` failed `pnpm run verify`
 * with ENOENT on `packages/lab/.corpus-backup-mutation-*` (#3337, after #2876 and #1919). `.gitignore` cannot
 * help a walker that reads the filesystem, so the walker skips dot-directories the way git would.
 */
function withTree(files: string[], check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "source-walk-"));
  try {
    for (const rel of files) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "export {};\n");
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const listed = (root: string) => (sourceFiles({ root }) as Array<[string, string]>).map(([rel]) => rel).sort();

test("a dot-directory holding a .mjs is not listed (#3337)", () => {
  withTree(["lab/real.mjs", "lab/.corpus-backup-mutation-KAV69H/corpus-backup.mjs"], (root) => {
    assert.deepEqual(listed(root), ["lab/real.mjs"]);
  });
});

test("a dot-directory nested below an ordinary one is skipped too, and its sibling still lists", () => {
  withTree(["a/b/.hidden/deep/x.ts", "a/b/kept.ts"], (root) => {
    assert.deepEqual(listed(root), ["a/b/kept.ts"]);
  });
});

test("positive control: node_modules and dist stay skipped, ordinary directories stay listed", () => {
  withTree(["p/src/a.mjs", "p/node_modules/m/x.mjs", "p/dist/y.mjs", "p/src/a.test.ts"], (root) => {
    assert.deepEqual(listed(root), ["p/src/a.mjs"]);
  });
});
