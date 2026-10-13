// Relocated from control/src/fleet-layer/git-safe-env.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * `git-safe-env.ts` is a DELIBERATE duplicate of `@a11ign/toolchain/lib/git-env`, forced by a publish boundary
 * this package's own header explains: `check-worker-code.mjs`/`deploy-worker.mjs` ship as `bin` entries, so
 * nothing they import can reach outside `@a11ign/screenreader-fleet`.
 *
 * This is CLAUDE.md's remedy #3 ("pin them equal with a test") applied to the one case remedy #1
 * ("delete a copy") cannot reach: the two files cross a package-publishing boundary neither side can
 * import through. Behavioural parity, not textual diffing — a textually different implementation that
 * still strips every GIT_* key and nothing else is just as safe as a byte-identical one. The toolchain
 * ships compiled output, so its TypeScript source cannot be compared to this file byte for byte; the
 * test pins behaviour instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxGitEnv as toolchainSandboxGitEnv, KNOWN_GIT_REDIRECT_VARS as toolchainKnown }
  from "@a11ign/toolchain/lib/git-env";
import { sandboxGitEnv as localSandboxGitEnv, KNOWN_GIT_REDIRECT_VARS as localKnown } from "./git-safe-env.ts";

test("KNOWN_GIT_REDIRECT_VARS matches the toolchain copy, so the documentation cannot drift silently", () => {
  assert.deepEqual([...localKnown].sort(), [...toolchainKnown].sort());
});

test("sandboxGitEnv behaves identically on a clean environment", () => {
  assert.deepEqual(localSandboxGitEnv(), toolchainSandboxGitEnv());
});

test("sandboxGitEnv behaves identically when GIT_* variables are present, including an unlisted one", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, GIT_DIR: "/somewhere/.git", GIT_A_FUTURE_VAR: "x", PATH: originalEnv.PATH ?? "" };
    assert.deepEqual(localSandboxGitEnv(), toolchainSandboxGitEnv());
    for (const scrubbed of [localSandboxGitEnv(), toolchainSandboxGitEnv()]) {
      for (const key of Object.keys(scrubbed)) assert.ok(!key.startsWith("GIT_"), `leaked ${key}`);
    }
  } finally {
    process.env = originalEnv;
  }
});

test("sandboxGitEnv's `extra` argument behaves identically on both copies", () => {
  const extra = { A11Y_TEST: "1" };
  assert.deepEqual(localSandboxGitEnv(extra), toolchainSandboxGitEnv(extra));
});
