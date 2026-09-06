/**
 * `git-safe-env.mjs` is a DELIBERATE duplicate of the repo-root `scripts/git-env.mjs`, forced by a
 * publish boundary this package's own header explains: `check-worker-code.mjs`/`deploy-worker.mjs` ship
 * as `bin` entries, so nothing they import can reach outside `@a11y-witness/worker-fleet`.
 *
 * This is CLAUDE.md's remedy #3 ("pin them equal with a test") applied to the one case remedy #1
 * ("delete a copy") cannot reach: the two files cross a package-publishing boundary neither side can
 * import through. Behavioural parity, not textual diffing — a textually different implementation that
 * still strips every GIT_* key and nothing else is just as safe as a byte-identical one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxGitEnv as rootSandboxGitEnv, KNOWN_GIT_REDIRECT_VARS as rootKnown }
  from "../../../scripts/git-env.mjs";
import { sandboxGitEnv as localSandboxGitEnv, KNOWN_GIT_REDIRECT_VARS as localKnown } from "./git-safe-env.mjs";

test("KNOWN_GIT_REDIRECT_VARS matches the root copy, so the documentation cannot drift silently", () => {
  assert.deepEqual([...localKnown].sort(), [...rootKnown].sort());
});

test("sandboxGitEnv behaves identically on a clean environment", () => {
  assert.deepEqual(localSandboxGitEnv(), rootSandboxGitEnv());
});

test("sandboxGitEnv behaves identically when GIT_* variables are present, including an unlisted one", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, GIT_DIR: "/somewhere/.git", GIT_A_FUTURE_VAR: "x", PATH: originalEnv.PATH ?? "" };
    assert.deepEqual(localSandboxGitEnv(), rootSandboxGitEnv());
    for (const scrubbed of [localSandboxGitEnv(), rootSandboxGitEnv()]) {
      for (const key of Object.keys(scrubbed)) assert.ok(!key.startsWith("GIT_"), `leaked ${key}`);
    }
  } finally {
    process.env = originalEnv;
  }
});

test("sandboxGitEnv's `extra` argument behaves identically on both copies", () => {
  const extra = { A11Y_TEST: "1" };
  assert.deepEqual(localSandboxGitEnv(extra), rootSandboxGitEnv(extra));
});
