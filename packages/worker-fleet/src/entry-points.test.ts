/**
 * Every script an npm command runs must do nothing when it is merely IMPORTED.
 *
 * This exists because of a measured incident, not a principle. `stability-gate.mjs` called `leaseWorker`
 * at module scope, and with no `A11Y_WORKER` set that path "finds every local worker VM, starts what is
 * stopped" — so importing the file to check it still loaded BOOTED a Windows VM on a developer's Mac, took
 * ~15% of its RAM, and never released it, because the import returned long before the `finally` that does
 * the releasing. `server.mjs` was worse: importing it started the worker on :8765, began warming up NVDA,
 * and hung holding the listener.
 *
 * The reason this matters is circular in a way worth stating: CLAUDE.md makes
 * `node -e "import('./x.mjs')"` the ONLY real check that an .mjs file still loads, because neither lint nor
 * `tsc` can see a ReferenceError at import — a fault this repo has already had in `capture-core.mjs`. So the
 * files most expensive to import were exactly the files the rules told you to import.
 *
 * A DISCOVERY test, not a list. The scripts are read from `package.json`, so a new entry point is covered
 * the day it is added rather than the day somebody remembers to add it here. Every guard in this repo that
 * read a hardcoded list has eventually missed the case that mattered — the worker-file list that let a file
 * deploy invisibly, and the budget ladder that read one path and so could not see the client with the bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, basename } from "node:path";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Every file an npm script invokes, discovered from `package.json`.
 *
 * `.ts` as well as `.mjs`, and the extension is the whole lesson. This read `\.mjs` alone for as long as it
 * existed, so the entire TypeScript half of the codebase was outside a guard written to cover it — SIX of
 * the seven `.ts` entry points ran on import, including the CLI, the eval runner and the rules gate. It
 * surfaced the ordinary way: a test that merely imported `cli.ts` printed the usage string and exited 1
 * before its first assertion, which is exactly why that file had no tests. A discovery test still only
 * discovers what its pattern admits.
 */
function entryPoints(): string[] {
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, "utf8"));
  const found = new Set<string>();
  for (const command of Object.values(pkg.scripts as Record<string, string>)) {
    for (const match of String(command).matchAll(/(?:^|\s)(packages\/[^\s]+\.(?:mjs|ts))/g)) {
      if (!match[1].endsWith(".test.ts")) found.add(match[1]);
    }
  }
  return [...found].sort();
}

test("every npm entry point refuses to run when imported", () => {
  const points = entryPoints();

  // A discovery that finds nothing passes in perfect silence, which is this repo's own rule about a check
  // reporting success having examined nothing. There were 29 when this was written.
  assert.ok(points.length >= 25,
    `only found ${points.length} entry points; the discovery is broken, not the codebase clean`);

  // Pinned separately, because the count above cannot tell 29 .mjs + 0 .ts from 29 .mjs + 7 .ts — and the
  // all-.mjs reading is precisely the bug this pattern was widened to fix. There were 7 when written.
  const typescript = points.filter((p) => p.endsWith(".ts"));
  assert.ok(typescript.length >= 5,
    `found ${typescript.length} .ts entry points; the pattern has stopped matching TypeScript`);

  const unguarded = points.filter((path) => {
    const src = readFileSync(`${REPO}${path}`, "utf8");
    return !src.includes("import.meta.url ===");
  });

  assert.deepEqual(unguarded, [],
    "these run on import, so `node -e \"import(...)\"` cannot be used to check they still load. Wrap the "
    + "executable part in a function and call it only under `if (import.meta.url === "
    + "pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : \"\").href)` — realpath'd if this "
    + "is ever published as a bin, or npm's own .bin symlink silently skips it. See the symlink test below.");
});

test("the guard is the exact comparison, never a path suffix", () => {
  // `process.argv[1]?.endsWith("guest-run.mjs")` worked but matched on a SUFFIX, so any entry point whose
  // path happened to end that way would have run the wrong file's main. One idiom means one thing to get
  // right, and `pathToFileURL` is the one that cannot be fooled by a name.
  for (const path of entryPoints()) {
    const src = readFileSync(`${REPO}${path}`, "utf8");
    const executable = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    assert.ok(!/process\.argv\[1\]\?\.endsWith\(/.test(executable),
      `${path} guards on a path suffix; use import.meta.url === pathToFileURL(process.argv[1] ?? "").href`);

    // The second wrong idiom, and it silently DISABLES the entry point rather than mis-firing it.
    // `import.meta.url === \`file://${process.argv[1]}\`` builds a URL by concatenation, so it does not
    // percent-encode: check this repo out under a path containing a SPACE and the comparison is false, the
    // guard never fires, and the script exits 0 having done nothing. Measured, not reasoned — a probe in a
    // directory named "dir with space" reported `template form matches: false` while pathToFileURL matched.
    // Seven entry points carried it, including fleet-status, check-worker-code, deploy-worker and
    // fleet-wake: the whole fleet toolchain would have gone quiet for anyone with a space in their path,
    // reporting success for work never done.
    assert.ok(!/import\.meta\.url === `file:\/\//.test(executable),
      `${path} builds its guard by string concatenation, which does not percent-encode — a path with a `
      + "space makes it silently never run. Use pathToFileURL(process.argv[1] ?? \"\").href");
  }
});

/**
 * Every `bin` a `package.json` declares, mapped to the SOURCE file it is built from — `dist/cli.js` is
 * built from `src/cli.ts`, `dist/doctor.mjs` from `src/doctor.mjs`, and `nvda-worker`'s bin points at its
 * source directly. Discovered rather than named, for the reason every discovery test in this file exists:
 * a bin nobody remembered to list here is exactly the one that ships broken.
 */
/** `dist/cli.js` is built from `src/cli.ts` or `src/cli.mjs`; anything not under `dist/` is its own source. */
function sourceFor(targetPath: string): string {
  const dir = dirname(targetPath);
  if (basename(dir) !== "dist") return targetPath;
  const base = basename(targetPath);
  const srcTs = join(dir, "..", "src", base.replace(/\.js$/, ".ts"));
  const srcMjs = join(dir, "..", "src", base.replace(/\.js$/, ".mjs"));
  if (existsSync(srcTs)) return srcTs;
  if (existsSync(srcMjs)) return srcMjs;
  return targetPath;
}

function declaredBinSources(): string[] {
  const packagesDir = join(REPO, "packages");
  const found = new Set<string>();
  for (const pkgName of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, pkgName, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const target of Object.values(manifest.bin ?? {}) as string[]) {
      const source = sourceFor(join(packagesDir, pkgName, target));
      found.add(source.replace(REPO, ""));
    }
  }
  return [...found].sort();
}

test("every declared bin's entry-point guard survives being reached through a symlink", () => {
  // architecture-audit.md §7.2: "the published dist/cli.js bin is executed by nothing". It should have
  // been: `isProgram` compared `import.meta.url` (which Node's ESM loader resolves through symlinks)
  // against a RAW `process.argv[1]`. npm always installs a `bin` entry as a symlink, and `npx` stages a
  // package under `os.tmpdir()` first, which is `/var/folders/...` on macOS — itself a symlink to
  // `/private/var/...`. So five of this repo's six real bins ran, matched nothing, skipped `main()`
  // entirely, and exited 0 with no output — reproduced with a three-line script invoked through `/tmp/...`
  // instead of its `/private/tmp/...` realpath, not by reasoning about it.
  const sources = declaredBinSources();
  assert.ok(sources.length >= 6, `only found ${sources.length} declared bin sources; the discovery is `
    + "broken, not the codebase clean");

  // `a11y-nvda-worker` is Windows-only by ADR 0001, and npm's Windows bin shim is a `.cmd`/`.ps1` wrapper
  // that does not depend on a shebang or a symlink the way POSIX's does — so this exposure is real on
  // every platform this repo actually ships the bin FOR except this one. It carries the identical pattern
  // and should still be fixed, but `server.mjs` is a capture-path file held under this repo's own
  // sequencing rule (anything touching server.mjs/capture-core.mjs/capture-probes.mjs/capture-setup.mjs/
  // worker-files.mjs waits for the in-flight recapture) — tracked, not silently exempted.
  const exempt = new Set(["packages/nvda-worker/src/server.mjs"]);
  const jsSources = sources.filter((s) => !exempt.has(s) && /\.(mjs|ts)$/.test(s));

  const vulnerable = jsSources.filter((path) => {
    const src = readFileSync(`${REPO}${path}`, "utf8");
    const executable = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    // A guard is vulnerable if it compares against `process.argv[1]` without realpath'ing it first.
    return /pathToFileURL\(\s*process\.argv\[1\]/.test(executable)
      && !/realpathSync\(\s*process\.argv\[1\]/.test(executable);
  });

  assert.deepEqual(vulnerable, [],
    "these bins compare import.meta.url against a non-realpath'd process.argv[1], so reaching them through "
    + "the .bin symlink npm always creates (or npx's tmpdir staging) silently skips main() and exits 0: "
    + "wrap the argv path in realpathSync() before pathToFileURL(), e.g. "
    + "pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : \"\").href — " + vulnerable.join(", "));
});
