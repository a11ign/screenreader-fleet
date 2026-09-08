// A DELIBERATE, DISCLOSED DUPLICATE of `scripts/npm-cli-executable.mjs` at the repo root.
//
// #492: never spawn `npx`/`npm` at all -- resolve npm's own CLI script and run it through
// `process.execPath`, since Node's CVE-2024-27980 fix permanently made `spawn`/`spawnSync`/`execFileSync`
// refuse to launch a `.bat`/`.cmd` file directly without `shell` (and `ceo`'s ruling is no `shell: true`,
// anywhere). See `scripts/npm-cli-executable.mjs`'s own header for the full incident and the two-layout
// resolution this file duplicates behaviourally.
//
// This package publishes `check-worker-code.mjs` and `deploy-worker.mjs` as `bin` entries
// (`package.json`), so every file they import -- `doctor.mjs` among them -- ships in the published
// tarball and can only import from INSIDE `@a11ign/worker-fleet`. The repo-root `scripts/` directory
// does not exist once this package is installed from npm, so importing it here would work in this
// monorepo and break for every real consumer. That is the entire reason this file exists rather than a
// relative import to the root: not stylistic preference, a publish-boundary constraint (see ADR 0004,
// and `git-safe-env.mjs`'s own header beside this file for the identical shape).
//
// Kept behaviourally identical to `scripts/npm-cli-executable.mjs` and pinned equal to it by
// `npm-cli-executable.test.ts`, which is this repo's own remedy #3 ("pin them equal with a test") for a
// fact that CANNOT be stated once because the two copies cross a package-publishing boundary neither can
// import through.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * @param {"npx" | "npm"} name
 * @returns {string}
 */
function cliScriptName(name) {
  return name === "npx" ? "npx-cli.js" : "npm-cli.js";
}

/**
 * @param {"npx" | "npm"} name
 * @returns {string[]}
 */
export function npmCliScriptCandidates(name) {
  const script = cliScriptName(name);
  const nodeDir = dirname(process.execPath);
  return [
    join(nodeDir, "node_modules", "npm", "bin", script),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", script),
  ];
}

/**
 * @param {"npx" | "npm"} name
 * @returns {string}
 */
export function resolveNpmCliScript(name) {
  const candidates = npmCliScriptCandidates(name);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`could not find npm's own ${cliScriptName(name)} beside this Node install -- tried:\n`
      + candidates.map((path) => `  ${path}`).join("\n"));
  }
  return found;
}

/**
 * @param {"npx" | "npm"} name
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
export function npmCliInvocation(name, args) {
  return { command: process.execPath, args: [resolveNpmCliScript(name), ...args] };
}
