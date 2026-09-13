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
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

/** Runs `fn` with `PATH` overridden (#1268's third candidate reads it), restored afterwards. */
function withPath(path: string, fn: () => void): void {
  const original = process.env.PATH;
  process.env.PATH = path;
  try {
    fn();
  } finally {
    process.env.PATH = original;
  }
}

test("both copies agree on the candidate list, in order, for both npx and npm", () => {
  for (const name of ["npx", "npm"] as const) {
    assert.deepEqual(localCandidates(name), rootCandidates(name));
  }
});

test("both copies build the Windows-shaped candidate first and the POSIX-shaped one second", () => {
  // PATH emptied: with nothing named npx on it, #1268's third candidate is absent and the two fixed
  // layouts are the whole list, in their measured order.
  withPath("", () => withExecPath("/fake/node-install/bin/node", () => {
    const candidates = rootCandidates("npx");
    assert.equal(candidates.length, 2);
    assert.match(candidates[0], /\/fake\/node-install\/bin\/node_modules\/npm\/bin\/npx-cli\.js$/);
    // `join()` normalises the `bin/..` away, so the POSIX-shaped candidate lands at .../lib/..., not
    // .../bin/../lib/... -- the SEMANTIC layout (node in bin/, npm one level up in lib/) still holds.
    assert.match(candidates[1], /\/fake\/node-install\/lib\/node_modules\/npm\/bin\/npx-cli\.js$/);
    assert.deepEqual(localCandidates("npx"), candidates);
  }));
});

test("#1268: the Debian layout -- npx on PATH is a symlink to the CLI script, and that script is the third candidate", () => {
  // Ubuntu's `nodejs`/`npm` packages: /usr/bin/npx -> ../share/nodejs/npm/bin/npx-cli.js, with node at
  // /usr/bin/node, so neither fixed layout exists. Reproduced in a temp dir, PATH pointed at it.
  // realpath'd: macOS's tmpdir is itself a symlink (/var -> /private/var), and the candidate is real.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "npm-cli-debian-")));
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "share", "nodejs", "npm", "bin"), { recursive: true });
    const script = join(root, "share", "nodejs", "npm", "bin", "npx-cli.js");
    writeFileSync(script, "// fake npx-cli.js\n");
    symlinkSync(join("..", "share", "nodejs", "npm", "bin", "npx-cli.js"), join(root, "bin", "npx"));
    withPath(join(root, "bin"), () => withExecPath(join(root, "bin", "node"), () => {
      const candidates = rootCandidates("npx");
      assert.equal(candidates.length, 3, "two fixed layouts plus the PATH-derived one");
      assert.equal(candidates[2], script, "the symlink's target IS the script on Debian");
      assert.deepEqual(localCandidates("npx"), candidates);
      assert.equal(rootResolve("npx"), script, "and it resolves, where the fixed layouts do not exist");
      assert.equal(localResolve("npx"), script);
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1268: an npx wrapper on PATH that is not itself the script yields the script beside it", () => {
  // The upstream tarball shape seen from PATH: <prefix>/bin/npx -> ../lib/node_modules/npm/bin/npx (a
  // wrapper), and npx-cli.js sits beside the wrapper's real location.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "npm-cli-wrapper-")));
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "lib", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(root, "lib", "node_modules", "npm", "bin", "npx"), "#!/bin/sh\n");
    writeFileSync(join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"), "// fake\n");
    symlinkSync(join("..", "lib", "node_modules", "npm", "bin", "npx"), join(root, "bin", "npx"));
    withPath(join(root, "bin"), () => withExecPath("/fake/node-install/bin/node", () => {
      assert.equal(rootCandidates("npx")[2], join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"));
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  withPath("", () => withExecPath("/nonexistent/node-install/bin/node", () => {
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
  }));
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
