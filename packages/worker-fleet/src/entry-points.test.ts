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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** Every `.mjs` file an npm script invokes, discovered from `package.json`. */
function entryPoints(): string[] {
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, "utf8"));
  const found = new Set<string>();
  for (const command of Object.values(pkg.scripts as Record<string, string>)) {
    for (const match of String(command).matchAll(/(?:^|\s)(packages\/[^\s]+\.mjs)/g)) found.add(match[1]);
  }
  return [...found].sort();
}

test("every npm entry point refuses to run when imported", () => {
  const points = entryPoints();

  // A discovery that finds nothing passes in perfect silence, which is this repo's own rule about a check
  // reporting success having examined nothing. There were 29 when this was written.
  assert.ok(points.length >= 25,
    `only found ${points.length} entry points; the discovery is broken, not the codebase clean`);

  const unguarded = points.filter((path) => {
    const src = readFileSync(`${REPO}${path}`, "utf8");
    return !src.includes("import.meta.url ===");
  });

  assert.deepEqual(unguarded, [],
    "these run on import, so `node -e \"import(...)\"` cannot be used to check they still load. Wrap the "
    + "executable part in a function and call it only under "
    + "`if (import.meta.url === pathToFileURL(process.argv[1] ?? \"\").href)`.");
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
  }
});
