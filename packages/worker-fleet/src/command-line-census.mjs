// @ts-check
/**
 * Every `.mjs` under this repo's known CLI roots — DISCOVERED by walking the tree, never a hand-typed list.
 *
 * Extracted from `cli-flags.test.ts` (A2, #453) so a SECOND consumer with a DIFFERENT question about the
 * same population reuses the walk rather than re-deriving it — the identical shape `preInstallEntries()`
 * and `busy-worker-guard.test.ts` already follow, and the one this repo's own rule names: *"delete a copy,
 * or derive one from the other"* ranks above a second independent `readdirSync` walk of the same tree that
 * could silently narrow from this one's (a different root list, a missed `node_modules` exclusion).
 *
 * `allMjsFiles()` is the WALK ALONE, with no predicate applied — deliberately, because "reads argv" and
 * "is a runnable command" are DIFFERENT questions over an overlapping but non-identical population.
 * `cli-flags.test.ts` filters this walk with `readsArgv()` to classify flag-guard coverage; a consumer
 * asking "does this file declare the `if (import.meta.url === ...) main()` entry-point guard" (docs
 * generation, say) filters the SAME walk with its own predicate instead of importing `readsArgv` and
 * getting the wrong population — a script can guard `main()` with no flags at all (nothing to read from
 * argv), and in principle a pre-install script reads `process.argv` at import time with no guard at all.
 * Sharing the walk and NOT the predicate is what keeps those two questions from being silently conflated.
 *
 * A CONSUMER OF THIS FILE ALREADY HAS `node_modules` AND A BUILD. `cli-flags.mjs` itself deliberately
 * imports nothing but `node:path`/`node:fs`/`node:url`, because scripts like `auto-arm-sweep.mjs` are
 * invoked by a workflow job with only `actions/checkout` -- no `npm ci`, no `dist` (#330/#331). This file
 * is NOT that kind of dependency: `stripComments` is a real workspace import
 * (`@a11ign/evidence/source-text`), so anything importing THIS module needs to run where that package's
 * `dist` exists -- a test file, or tooling invoked after `npm run build`. Keeping `cli-flags.mjs` itself
 * free of that import is why this is a sibling file rather than an addition to it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "@a11ign/evidence/source-text";

/** Every top-level directory a `.mjs` command line can live under, relative to the repo root. */
const ROOTS = ["scripts", ...["packages/lab", "packages/worker-fleet"]
  .flatMap((pkg) => ["src", "scripts"].map((sub) => `${pkg}/${sub}`))];

/**
 * Every `.mjs` under the tree's known CLI roots, no predicate applied — the population itself, for a
 * caller to classify by whatever question is theirs.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @returns {string[]} repo-relative paths, unsorted (discovery order)
 */
export function allMjsFiles(repoRoot) {
  const found = /** @type {string[]} */ ([]);
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "node_modules") walk(rel);
      else if (!entry.isDirectory() && rel.endsWith(".mjs")) found.push(rel);
    }
  };
  for (const root of ROOTS) {
    // A package without a `scripts/` directory is not a fault; anything else is, and must not be swallowed.
    try { statSync(join(repoRoot, root)); } catch { continue; }
    walk(root);
  }
  return found;
}

/**
 * Does this file read argv? Comments stripped first, and that is not a nicety: matching raw source
 * classified a module as a CLI merely because a COMMENT mentioned `process.argv` — measured on
 * `gates/dispatch.mjs`, a library whose comment said it deliberately does NOT read `process.argv`. This
 * repo's own rule: a check must not derive its expectations from source TEXT, because text includes the
 * prose about the code as well as the code.
 *
 * Excludes `cli-flags.mjs` itself, the guard's OWN definition, which mentions `process.argv` in its
 * implementation without being a command line for anything to classify.
 *
 * @param {string} rel repo-relative path
 * @param {string} repoRoot absolute path to the repository root
 * @returns {boolean}
 */
export function readsArgv(rel, repoRoot) {
  if (!rel.endsWith(".mjs")) return false;
  const source = stripComments(readFileSync(join(repoRoot, rel), "utf8"));
  return source.includes("process.argv") && !source.includes("export function refuseUnknownFlags");
}

/**
 * `allMjsFiles()` filtered to the ones that read argv — the population `cli-flags.test.ts`'s flag-guard
 * census classifies. NOT the same question as "is this a runnable command with an entry-point guard";
 * see this file's own header for why those stay two predicates over one walk rather than one.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @returns {string[]}
 */
export function commandLineModules(repoRoot) {
  return allMjsFiles(repoRoot).filter((rel) => readsArgv(rel, repoRoot));
}
