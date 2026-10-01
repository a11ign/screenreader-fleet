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
// #2890: `pnpmCliInvocation` (#2301) and the two helpers it uses are copied verbatim, because `doctor.mjs`
// spawns pnpm now, not npm; the npm half stays so the pin below keeps comparing whole files.
//
// Kept behaviourally identical to `scripts/npm-cli-executable.mjs` and pinned equal to it by
// `npm-cli-executable.test.ts`, which is this repo's own remedy #3 ("pin them equal with a test") for a
// fact that CANNOT be stated once because the two copies cross a package-publishing boundary neither can
// import through.
import { existsSync, realpathSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";

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
  const fixed = [
    join(nodeDir, "node_modules", "npm", "bin", script),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", script),
  ];
  const fromPath = pathDerivedCandidate(name, script);
  return fromPath === null ? fixed : [...fixed, fromPath];
}

/**
 * #1268: THE THIRD LAYOUT. Debian and Ubuntu package npm at `/usr/share/nodejs/npm/bin/`, nowhere near
 * `node`, and put `/usr/bin/npm` and `/usr/bin/npx` on PATH as symlinks straight to the CLI scripts. So
 * the executable on PATH, symlinks resolved, IS the script (Debian) or sits in the script's directory
 * (the upstream tarball's `bin/npx` wrapper). Tried LAST so the two fixed layouts keep their order on
 * the platforms they were measured on; `null` when nothing named `name` is on PATH, so the candidate
 * list never carries a path that cannot exist. Found by the first `npm ci` on the agents host.
 * @param {"npx" | "npm"} name
 * @param {string} script
 * @returns {string | null}
 */
function pathDerivedCandidate(name, script) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const executable = join(dir, name);
    if (!existsSync(executable)) continue;
    const real = realpathSync(executable);
    return real.endsWith(script) ? real : join(dirname(real), script);
  }
  return null;
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

/**
 * #2301: `pnpm <args>` WITHOUT SPAWNING A `.cmd`, for the same reason `npmCliInvocation` exists, and with the
 * added problem that pnpm is not always ON `PATH` at all: this host and the Windows workers run it as
 * `corepack pnpm` (`packageManager` in the root manifest pins the version), while a CI runner has the
 * shim `pnpm/action-setup` puts there. Three ways to reach it, tried in this order, each ending in an argv
 * that `execFileSync` can run with no shell:
 *
 *   1. `npm_execpath`, when this process was itself started BY pnpm (`pnpm run ...`, `pnpm exec ...`): pnpm
 *      says which script it is, so nothing is searched for and no other pnpm can be picked up by mistake.
 *   2. a `pnpm` on `PATH`: the executable itself on POSIX; on Windows the shim is `pnpm.cmd`, so the
 *      `pnpm.cjs` beside it is run through `process.execPath` instead.
 *   3. `corepack` on `PATH`, the same way: `corepack pnpm` on POSIX, `corepack.js` beside `node.exe`
 *      through `process.execPath` on Windows.
 *
 * Throws NAMING WHAT WAS TRIED, for the reason `resolveNpmCliScript` does.
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
export function pnpmCliInvocation(args) {
  const fromParent = process.env.npm_execpath ?? "";
  if (/pnpm\.c?js$/.test(fromParent) && existsSync(fromParent)) {
    return { command: process.execPath, args: [fromParent, ...args] };
  }
  const shim = onPath("pnpm");
  if (shim !== null) return shimInvocation(shim, join("node_modules", "pnpm", "bin", "pnpm.cjs"), args);
  const corepack = onPath("corepack");
  if (corepack !== null) {
    return shimInvocation(corepack, join("node_modules", "corepack", "dist", "corepack.js"), ["pnpm", ...args]);
  }
  throw new Error("could not find pnpm: `npm_execpath` is not a pnpm script, and neither `pnpm` nor `corepack` "
    + "is on PATH. `packageManager` in the root package.json names the version -- `corepack enable` or "
    + "`pnpm/action-setup` provides it.");
}

/**
 * The first executable called `name` on PATH, or `null`. On Windows the executable is `name.cmd`, which
 * `existsSync` finds only when the extension is tried, so both spellings are.
 * @param {string} name
 * @returns {string | null}
 */
function onPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const candidate of [join(dir, name), join(dir, `${name}.cmd`)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * A POSIX shim is spawned as it is; a `.cmd` shim is never spawned (CVE-2024-27980, see the header), so the
 * package script it wraps is run through `process.execPath`, found beside the shim (the layout `pnpm add -g`
 * and `pnpm/action-setup` share) or beside `node` (corepack's).
 * @param {string} shim
 * @param {string} script the wrapped script, relative to the shim's directory or to `node`'s
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
function shimInvocation(shim, script, args) {
  if (!shim.endsWith(".cmd")) return { command: shim, args };
  const found = [join(dirname(shim), script), join(dirname(process.execPath), script)].find((path) => existsSync(path));
  if (found === undefined) throw new Error(`${shim} is a .cmd shim and its script ${script} is not beside it or beside node`);
  return { command: process.execPath, args: [found, ...args] };
}
