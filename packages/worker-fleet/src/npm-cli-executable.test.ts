/**
 * `npm-cli-executable.mjs` is a DELIBERATE duplicate of the repo-root `scripts/npm-cli-executable.mjs`,
 * forced by the identical publish boundary `git-safe-env.test.ts` (beside this file) already explains:
 * `check-worker-code.mjs`/`deploy-worker.mjs` ship as `bin` entries, so nothing they import can reach
 * outside `@a11ign/worker-fleet`.
 *
 * This is CLAUDE.md's remedy #3 ("pin them equal with a test") applied to the one case remedy #1
 * ("delete a copy") cannot reach: the two files cross a package-publishing boundary neither side can
 * import through. Behavioural parity, not textual diffing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { npmCliExecutable as rootNpmCliExecutable } from "../../../scripts/npm-cli-executable.mjs";
import { npmCliExecutable as localNpmCliExecutable } from "./npm-cli-executable.mjs";

/** Runs `fn` with `process.platform` overridden, and restores it afterwards even if `fn` throws. */
function withPlatform(platform: string, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

test("both copies agree on win32: npx/npm get the .cmd suffix", () => {
  withPlatform("win32", () => {
    assert.equal(localNpmCliExecutable("npx"), rootNpmCliExecutable("npx"));
    assert.equal(localNpmCliExecutable("npm"), rootNpmCliExecutable("npm"));
    assert.equal(localNpmCliExecutable("npx"), "npx.cmd");
  });
});

test("both copies agree on darwin/linux: the bare name is unchanged", () => {
  for (const platform of ["darwin", "linux"]) {
    withPlatform(platform, () => {
      assert.equal(localNpmCliExecutable("npx"), rootNpmCliExecutable("npx"));
      assert.equal(localNpmCliExecutable("npx"), "npx");
    });
  }
});
