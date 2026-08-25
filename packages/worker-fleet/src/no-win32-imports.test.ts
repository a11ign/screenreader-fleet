/**
 * Nothing that runs off Windows may load the capture driver at import time.
 *
 * ## The fault, measured 2026-08-25
 *
 * `@guidepup/guidepup`'s index CONSTRUCTS a `ScreenReader` at module scope, and its constructor throws
 * `No available supported screen readers` on a host with none. `@a11y-witness/nvda-worker`'s package index
 * re-exports `capture-core.mjs`, which imports guidepup. So importing the worker package BY NAME — even for
 * a pure 16-line hasher that has its own dependency-free module — puts that throw on the import path.
 *
 * `worker-code-check.mjs` did exactly that, and both corpus capture runs on the lab died at import:
 *
 *     Error: No available supported screen readers
 *       at new ScreenReader (@guidepup/guidepup/lib/ScreenReader.js:10)
 *       at Object.<anonymous> (@guidepup/guidepup/lib/index.js:44)
 *
 * with no mention of the file that caused it. The pipeline reported `STOPPED at capture` and nothing else,
 * because `retrain-pipeline.mjs` printed only the child's stdout and this went to stderr.
 *
 * ## Why every existing check was blind to it, by construction
 *
 * **macOS resolves VoiceOver, so the constructor succeeds there and the throw never happens.** `npm test`,
 * `npm run lint`, `tsc --noEmit`, `entry-points.test.ts` (which imports every entry point precisely to
 * catch import-time faults) and CLAUDE.md's own `node -e "import('./x.mjs')"` rule all pass on a developer
 * Mac and on the Windows CI runner. The one platform that fails is the one the lab is.
 *
 * That is this repo's recurring shape in a new costume: a check computed on data that shares the flaw
 * cannot see the flaw. So the guard has to be STATIC — a property of the import graph, not of running it.
 *
 * ## The knowledge already existed
 *
 * `worker-http.mjs` states the rule verbatim: *"Deliberately NOT imported from
 * `@a11y-witness/nvda-worker`: this package runs on macOS and Linux and must not depend on a win32-only
 * one."* And `deploy.yml` reaches the same conclusion for a different reason. It was written down twice, in
 * prose, and a new file in the same package broke it within the hour — which is the argument for a test
 * rather than a third comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** The module whose mere import throws where there is no screen reader. */
const POISON = "@guidepup/guidepup";

/** Importing this by NAME reaches POISON, because the package index re-exports `capture-core.mjs`. */
const WORKER_PACKAGE = "@a11y-witness/nvda-worker";
const WORKER_INDEX = "packages/nvda-worker/src/index.mjs";

/**
 * Source trees that must run on macOS AND Linux.
 *
 * The lab is a Linux container that dispatches captures over HTTP and never drives NVDA itself; the CLI
 * ships to whatever a user has. `packages/nvda-worker` is deliberately absent — it is the win32 half, and
 * it is allowed and required to import the driver.
 */
const PORTABLE_TREES = [
  "packages/worker-fleet/src",
  "packages/lab/src",
  "packages/lab/scripts",
  "packages/cli/src",
  "packages/judge/src",
  "packages/evidence/src",
];

/**
 * Files that are Windows-only entry points, with the reason each is allowed to reach the driver.
 *
 * An allowlist rather than a pattern, because "is this file allowed to be win32-only" is a decision and
 * not a shape. A new file reaching the driver fails until somebody makes that decision.
 */
const WIN32_ONLY: Record<string, string> = {
  "packages/lab/src/harnesses/capture-check.mjs":
    "its in-process mode drives NVDA directly; capture-regression.yml runs it on a Windows runner",
  "packages/lab/src/harnesses/run-spike.ts":
    "a VoiceOver spike — it imports guidepup on purpose and runs on a Mac only",
};

const isSource = (path: string) => /\.(mjs|ts)$/.test(path) && !/\.test\.ts$/.test(path)
  && !/\.d\.ts$/.test(path);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && entry !== "dist") walk(full);
      } else if (isSource(full)) {
        out.push(full.slice(REPO.length));
      }
    }
  };
  if (existsSync(join(REPO, dir))) walk(join(REPO, dir));
  return out.sort();
}

/**
 * STATIC imports only — `import x from "y"` and `export … from "y"`.
 *
 * A dynamic `await import()` inside a function is the CORRECT way to reach the driver from portable code
 * and must not be flagged: `capture-fixtures.mjs` does exactly that, so the module loads anywhere and only
 * pays for guidepup on the machine that calls the function. That distinction is the whole remedy, so a
 * guard that could not express it would forbid the fix along with the bug.
 */
function staticImports(relative: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(REPO, relative), "utf8");
  } catch {
    return [];
  }
  const specifiers: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\b[^;\n]*?from\s*["']([^"']+)["']/gm)) {
    specifiers.push(match[1]);
  }
  for (const match of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specifiers.push(match[1]);
  return specifiers;
}

/** Resolve a specifier to a repo-relative source file, or null when it is not one of ours. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  // The ROOT reaches the driver; the SUBPATH exports deliberately do not. Collapsing the two would either
  // clear a real offender (if subpaths resolved to nothing) or condemn the remedy (if they resolved to the
  // index) — and the whole fix is that they are different.
  if (specifier === WORKER_PACKAGE) return WORKER_INDEX;
  if (specifier.startsWith(`${WORKER_PACKAGE}/`)) {
    const sub = specifier.slice(WORKER_PACKAGE.length + 1);
    return existsSync(join(REPO, `packages/nvda-worker/src/${sub}.mjs`))
      ? `packages/nvda-worker/src/${sub}.mjs` : null;
  }
  if (!specifier.startsWith(".")) return null;
  const base = resolve(REPO, dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.ts`, join(base, "index.mjs"), join(base, "index.ts")]) {
    // `.js` in a TypeScript import means the `.ts` beside it.
    const swapped = candidate.replace(/\.js$/, ".ts");
    for (const attempt of [candidate, swapped]) {
      if (existsSync(attempt) && statSync(attempt).isFile()) return attempt.slice(REPO.length);
    }
  }
  return null;
}

/** The chain from `entry` to the driver, or null when it never gets there. */
function pathToDriver(entry: string): string[] | null {
  const seen = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }];
  while (queue.length) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier === POISON) return [...chain, POISON];
      const next = resolveLocal(file, specifier);
      if (next && !seen.has(next)) queue.push({ file: next, chain: [...chain, next] });
    }
  }
  return null;
}

const PORTABLE = PORTABLE_TREES.flatMap(filesUnder);

test("the trees being examined are real, so this guard cannot pass having read nothing", () => {
  // The first version of `verify.corpus.test.ts` read a field that does not exist and passed against a
  // corpus carrying 604 crashes. A discovery test that discovers nothing is the same defect.
  assert.ok(PORTABLE.length > 100, `only ${PORTABLE.length} portable source files found; the layout moved`);
  for (const tree of PORTABLE_TREES) {
    assert.ok(filesUnder(tree).length > 0, `${tree} yielded no source files`);
  }
});

test("the poison really is reachable from the worker package, or this guard proves nothing", () => {
  // Assert the mechanism the test exists to detect actually exists. Without this, a guidepup upgrade that
  // stopped re-exporting the driver would leave every assertion below vacuously true.
  const chain = pathToDriver(WORKER_INDEX);
  assert.ok(chain, `${WORKER_PACKAGE}'s index no longer reaches ${POISON}. If that is deliberate, this `
    + "whole guard can be simplified; if it is accidental, the import graph has changed under it.");
  assert.ok(chain!.includes("packages/nvda-worker/src/capture-core.mjs"));
});

test("no portable module statically reaches the capture driver", () => {
  const offenders = PORTABLE
    .filter((file) => !Object.hasOwn(WIN32_ONLY, file))
    .map((file) => ({ file, chain: pathToDriver(file) }))
    .filter((found) => found.chain);

  assert.deepEqual(offenders.map((o) => o.chain!.join("\n      -> ")), [],
    `A module that runs on the Linux lab (or in the shipped CLI) loads ${POISON} at import time, which `
    + "throws `No available supported screen readers` there. macOS resolves VoiceOver, so every local "
    + "check passes and only the lab fails.\n"
    + `Import the specific module by PATH rather than ${WORKER_PACKAGE} — code-version.mjs, `
    + "capture-pure.mjs and worker-files.mjs are dependency-free for this reason — or reach the driver "
    + "through a dynamic `await import()` inside the function that needs it, as capture-fixtures.mjs does.");
});

test("the allowlist is honest: every file on it really is win32-only", () => {
  // An allowlist that outlives its entries is a hole nobody can see. If one of these stops reaching the
  // driver, it should come OFF the list rather than sit there permitting something that is not happening.
  for (const [file, why] of Object.entries(WIN32_ONLY)) {
    assert.ok(existsSync(join(REPO, file)), `${file} is allowlisted and does not exist`);
    assert.ok(why.length > 20, `${file} is allowlisted without a reason`);
    assert.ok(pathToDriver(file),
      `${file} no longer reaches ${POISON}, so it is portable now — remove it from WIN32_ONLY rather `
      + "than leaving a permission for something that is not happening.");
  }
});

test("a dynamic import is not flagged, because it is the remedy", () => {
  // `capture-fixtures.mjs` reaches the driver through `await import()` inside a function, so it loads
  // anywhere and only pays for guidepup where it is called. If this test ever fails, the import scanner
  // has started matching dynamic imports and would forbid the fix along with the bug.
  const fixtures = "packages/lab/src/harnesses/capture-fixtures.mjs";
  assert.match(readFileSync(join(REPO, fixtures), "utf8"), /await import\("@a11y-witness\/nvda-worker"\)/);
  assert.equal(pathToDriver(fixtures), null,
    `${fixtures} reaches the driver statically; only its dynamic import should exist`);
});
