/**
 * `npm-cli-executable.mjs` is a DELIBERATE duplicate of the repo-root `scripts/npm-cli-executable.mjs`,
 * forced by the identical publish boundary `git-safe-env.test.ts` (beside this file) already explains:
 * `check-worker-code.mjs`/`deploy-worker.mjs` ship as `bin` entries, so nothing they import can reach
 * outside `@a11ign/worker-fleet`.
 *
 * This is CLAUDE.md's remedy #3 ("pin them equal with a test") applied to the one case remedy #1
 * ("delete a copy") cannot reach: the two files cross a package-publishing boundary neither side can
 * import through. Behavioural parity, not textual diffing.
 *
 * REWRITTEN FOR #492's REOPENING. The old version of this file pinned `npmCliExecutable(name)` — the
 * `.cmd`-suffix approach — equal across both copies under a `process.platform` override. That premise
 * (Node auto-routes a bare `.cmd` through `cmd.exe`) stopped being true in April 2024 (CVE-2024-27980,
 * "BatBadBut"), and the win32 branch was verified only by overriding `process.platform` in a unit test —
 * never against a real Windows platform, which is exactly the gap that let the regression through (see
 * `scripts/npm-cli-executable.mjs`'s own header). The replacement API has NO platform branching: both
 * candidate layouts (Windows-shaped, POSIX-shaped) are tried unconditionally on every platform, so there
 * is nothing here for a `process.platform` override to exercise — `process.execPath` is the only input,
 * and it is overridden directly below instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  npmCliScriptCandidates as rootCandidates,
  resolveNpmCliScript as rootResolve,
  npmCliInvocation as rootInvocation,
} from "../../../scripts/npm-cli-executable.mjs";
import {
  npmCliScriptCandidates as localCandidates,
  resolveNpmCliScript as localResolve,
  npmCliInvocation as localInvocation,
} from "./npm-cli-executable.mjs";

/** Runs `fn` with `process.execPath` overridden, and restores it afterwards even if `fn` throws. */
function withExecPath(execPath: string, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "execPath");
  Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(process, "execPath", original);
  }
}

test("both copies agree on the candidate list, in order, for both npx and npm", () => {
  for (const name of ["npx", "npm"] as const) {
    assert.deepEqual(localCandidates(name), rootCandidates(name));
  }
});

test("both copies build the Windows-shaped candidate first and the POSIX-shaped one second", () => {
  withExecPath("/fake/node-install/bin/node", () => {
    const candidates = rootCandidates("npx");
    assert.equal(candidates.length, 2);
    assert.match(candidates[0], /\/fake\/node-install\/bin\/node_modules\/npm\/bin\/npx-cli\.js$/);
    // `join()` normalises the `bin/..` away, so the POSIX-shaped candidate lands at .../lib/..., not
    // .../bin/../lib/... -- the SEMANTIC layout (node in bin/, npm one level up in lib/) still holds.
    assert.match(candidates[1], /\/fake\/node-install\/lib\/node_modules\/npm\/bin\/npx-cli\.js$/);
    assert.deepEqual(localCandidates("npx"), candidates);
  });
});

test("both copies resolve the real, currently-running npm CLI script to the same path", () => {
  // No override here: this Node install genuinely has npm beside it, so this exercises the real
  // existsSync check rather than a fake candidate list -- the one thing the unit guard CAN prove, per
  // this file's own header (it cannot prove a real spawn succeeds; only a real windows-2022 dispatch can).
  for (const name of ["npx", "npm"] as const) {
    assert.equal(localResolve(name), rootResolve(name));
  }
});

test("both copies throw, naming every candidate tried, when neither layout exists", () => {
  withExecPath("/nonexistent/node-install/bin/node", () => {
    for (const name of ["npx", "npm"] as const) {
      assert.throws(() => rootResolve(name), (error: Error) => {
        assert.match(error.message, /could not find npm's own/);
        for (const candidate of rootCandidates(name)) assert.ok(error.message.includes(candidate));
        return true;
      });
      assert.throws(() => localResolve(name), (error: Error) => {
        assert.match(error.message, /could not find npm's own/);
        for (const candidate of localCandidates(name)) assert.ok(error.message.includes(candidate));
        return true;
      });
    }
  });
});

test("both copies build the identical argv shape: process.execPath, the resolved script, then the caller's args unchanged", () => {
  for (const name of ["npx", "npm"] as const) {
    const args = ["tsc", "--build", "--force"];
    const rootResult = rootInvocation(name, args);
    const localResult = localInvocation(name, args);
    assert.deepEqual(localResult, rootResult);
    assert.equal(rootResult.command, process.execPath);
    assert.deepEqual(rootResult.args, [rootResolve(name), ...args]);
  }
});
