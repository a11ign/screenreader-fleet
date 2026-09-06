// A DELIBERATE, DISCLOSED DUPLICATE of `scripts/git-env.mjs` at the repo root.
//
// git EXPORTS `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` into every hook environment, and a process that
// spawns `git` with an inherited `env` operates on whatever `GIT_DIR` names, not on `cwd` -- see
// `scripts/git-env.mjs`'s header for the incident that proved it (a pre-push-hook test forged 15 commits
// across all refs of the real repo).
//
// This package publishes `check-worker-code.mjs` and `deploy-worker.mjs` as `bin` entries
// (`package.json`), so every file they import -- `code-drift.mjs` among them -- ships in the published
// tarball and can only import from INSIDE `@a11y-witness/worker-fleet`. The repo-root `scripts/` directory
// does not exist once this package is installed from npm, so importing it here would work in this
// monorepo and break for every real consumer. That is the entire reason this file exists rather than a
// relative import to the root: not stylistic preference, a publish-boundary constraint (see ADR 0004).
//
// Kept textually identical to `scripts/git-env.mjs` and pinned equal to it by
// `git-safe-env.test.ts`, which is this repo's own remedy #3 ("pin them equal with a test") for a fact
// that CANNOT be stated once because the two copies cross a package-publishing boundary neither can
// import through.

/** @type {readonly string[]} */
export const KNOWN_GIT_REDIRECT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

/**
 * `process.env` with every `GIT_*` key removed, `extra` applied on top. A prefix strip, never a list
 * lookup, so a new `GIT_*` variable is caught without this file needing to know its name.
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string | undefined>}
 */
export function sandboxGitEnv(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const scrubbed = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) scrubbed[key] = value;
  }
  return { ...scrubbed, ...extra };
}
