// A DELIBERATE, DISCLOSED DUPLICATE of `scripts/npm-cli-executable.mjs` at the repo root.
//
// `spawnSync`/`execFileSync` given a bare `npx`/`npm` is `ENOENT` on Windows without a shell -- see
// `scripts/npm-cli-executable.mjs`'s header for the incident (#492: three real `windows-2022` Action runs,
// none of which reached NVDA or the page, because `npm ci`'s `prepare` step crashed first).
//
// This package publishes `check-worker-code.mjs` and `deploy-worker.mjs` as `bin` entries
// (`package.json`), so every file they import -- `doctor.mjs` among them -- ships in the published
// tarball and can only import from INSIDE `@a11ign/worker-fleet`. The repo-root `scripts/` directory
// does not exist once this package is installed from npm, so importing it here would work in this
// monorepo and break for every real consumer. That is the entire reason this file exists rather than a
// relative import to the root: not stylistic preference, a publish-boundary constraint (see ADR 0004,
// and `git-safe-env.mjs`'s own header beside this file for the identical shape).
//
// Kept textually identical to `scripts/npm-cli-executable.mjs` and pinned equal to it by
// `npm-cli-executable.test.ts`, which is this repo's own remedy #3 ("pin them equal with a test") for a
// fact that CANNOT be stated once because the two copies cross a package-publishing boundary neither can
// import through.
export function npmCliExecutable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}
