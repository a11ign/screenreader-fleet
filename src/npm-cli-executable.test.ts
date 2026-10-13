// Relocated from control/src/fleet-layer/npm-cli-executable.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * `npm-cli-executable.ts` is a DELIBERATE duplicate of `@a11ign/toolchain/lib/npm-cli-executable`,
 * forced by the identical publish boundary `git-safe-env.test.ts` (beside this file) already explains:
 * `check-worker-code.mjs`/`deploy-worker.mjs` ship as `bin` entries, so nothing they import can reach
 * outside `@a11ign/screenreader-fleet`.
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
 * `npm-cli-executable.ts`'s header for the incident). The replacement API has NO platform branching: both
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
  npmCliScriptCandidates as toolchainCandidates,
  resolveNpmCliScript as toolchainResolve,
  npmCliInvocation as toolchainInvocation,
  pnpmCliInvocation as toolchainPnpm,
} from "@a11ign/toolchain/lib/npm-cli-executable";
import {
  npmCliScriptCandidates as localCandidates,
  resolveNpmCliScript as localResolve,
  npmCliInvocation as localInvocation,
  pnpmCliInvocation as localPnpm,
} from "./npm-cli-executable.ts";

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
    assert.deepEqual(localCandidates(name), toolchainCandidates(name));
  }
});

test("both copies build the Windows-shaped candidate first and the POSIX-shaped one second", () => {
  // PATH emptied: with nothing named npx on it, #1268's third candidate is absent and the two fixed
  // layouts are the whole list, in their measured order.
  withPath("", () => withExecPath("/fake/node-install/bin/node", () => {
    const candidates = toolchainCandidates("npx");
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
      const candidates = toolchainCandidates("npx");
      assert.equal(candidates.length, 3, "two fixed layouts plus the PATH-derived one");
      assert.equal(candidates[2], script, "the symlink's target IS the script on Debian");
      assert.deepEqual(localCandidates("npx"), candidates);
      assert.equal(toolchainResolve("npx"), script, "and it resolves, where the fixed layouts do not exist");
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
      assert.equal(toolchainCandidates("npx")[2], join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"));
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
    assert.equal(localResolve(name), toolchainResolve(name));
  }
});

test("both copies throw, naming every candidate tried, when neither layout exists", () => {
  withPath("", () => withExecPath("/nonexistent/node-install/bin/node", () => {
    for (const name of ["npx", "npm"] as const) {
      assert.throws(() => toolchainResolve(name), (error: Error) => {
        assert.match(error.message, /could not find npm's own/);
        for (const candidate of toolchainCandidates(name)) assert.ok(error.message.includes(candidate));
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
    const toolchainResult = toolchainInvocation(name, args);
    const localResult = localInvocation(name, args);
    assert.deepEqual(localResult, toolchainResult);
    assert.equal(toolchainResult.command, process.execPath);
    assert.deepEqual(toolchainResult.args, [toolchainResolve(name), ...args]);
  }
});

/** Runs `fn` with `npm_execpath` set (or removed), restored afterwards. */
function withNpmExecpath(value: string | undefined, fn: () => void): void {
  const original = process.env.npm_execpath;
  if (value === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
  }
}

test("#2890: both copies reach pnpm the same three ways, in the same order, and say what was tried when none exists", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pnpm-cli-parity-")));
  try {
    const args = ["exec", "tsc", "--build"];
    const parentScript = join(root, "pnpm.cjs");
    writeFileSync(parentScript, "// fake pnpm.cjs\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "corepack"), "#!/bin/sh\n");
    const agree = (expected: { command: string, args: string[] }) => {
      assert.deepEqual(toolchainPnpm(args), expected);
      assert.deepEqual(localPnpm(args), expected);
    };
    // 1. started BY pnpm: npm_execpath wins over everything on PATH
    withNpmExecpath(parentScript, () => withPath(bin, () => agree({ command: process.execPath, args: [parentScript, ...args] })));
    // 3. no pnpm anywhere but corepack on PATH: `corepack pnpm ...`
    withNpmExecpath(undefined, () => withPath(bin, () => agree({ command: join(bin, "corepack"), args: ["pnpm", ...args] })));
    // 2. a pnpm on PATH outranks corepack
    writeFileSync(join(bin, "pnpm"), "#!/bin/sh\n");
    withNpmExecpath(undefined, () => withPath(bin, () => agree({ command: join(bin, "pnpm"), args })));
    // nothing at all: both throw the same words
    withNpmExecpath(undefined, () => withPath("", () => {
      assert.throws(() => toolchainPnpm(args), /could not find pnpm/);
      assert.throws(() => localPnpm(args), /could not find pnpm/);
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
