// @ts-check
/**
 * Every source file under `packages/`, so a guard can be written over what EXISTS rather than over a list.
 *
 * This repo's most expensive recurring shape is a check that only examines the places somebody already
 * thought of. Two instances are recorded in `budget-ladder.test.ts` alone: the worker-file list that let a
 * file deploy invisibly, and the ladder guard that read ONE hardcoded path and therefore could not see
 * `capture-real-pages.mjs` declaring 300 s against a 520 s hard timeout — inverted, on the client that
 * needed it most.
 *
 * Extracted here because there were about to be TWO copies of the walk: one for capture budgets and one for
 * `--worker` validation. A duplicated discovery is a discovery that drifts, which is the same defect one
 * level up.
 *
 * `dist` is excluded because it is build output of the very files being checked, so including it
 * double-counts and reports a stale copy as a violation after the source has been fixed. Test files are
 * excluded because a guard asserting on other guards' source is noise.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The `packages/` directory, resolved from this module rather than from the caller's cwd. */
export const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every non-test source file under `packages/`, as `[relativePath, source]`.
 *
 * @param {{ root?: string }} [options]
 * @returns {Array<[string, string]>}
 */
export function sourceFiles({ root = PACKAGES } = {}) {
  /** @type {Array<[string, string]>} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(path);
      } else if (/\.(mjs|ts)$/.test(entry.name) && !entry.name.includes(".test.")) {
        found.push([path.slice(root.length + 1), readFileSync(path, "utf8")]);
      }
    }
  };
  walk(root);
  return found;
}
