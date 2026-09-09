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
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, basename } from "node:path";
import { declareTreeWideGuard, walkTree } from "../../../scripts/tree-wide-guard.mjs";

// #716/#704: this file's own population is the whole tracked tree, not one file -- declared here
// rather than inferred from its source, per ceo's ruling (2026-09-09) that the tree-wide-guard
// population must be derived from a real import, never from scanning source text.
declareTreeWideGuard();

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
/**
 * EVERY WAY A SCRIPT IN THIS REPO COMES TO BE EXECUTED — enumerated, not appended to (#202).
 *
 * This discovery has been widened three times in one night, each time by adding the invocation source
 * that had just bitten: `package.json` only, then `scripts/` paths inside it (#174), then
 * `.github/workflows` and `action.yml` (#185). Each fix was correct and none asked the general question,
 * so the fourth source bit anyway — **two files carrying the banned entry guard merged AFTER #185 landed,
 * invoked by git hooks**, which nothing here read.
 *
 * So the table below is the deliverable rather than the widening. A source this cannot read is DECLARED,
 * not omitted: "nothing needs this" and "nobody looked" must stay different states.
 *
 * | source | read here | why |
 * |---|---|---|
 * | `package.json` scripts | YES | the original population |
 * | `.github/workflows/*.yml`, `action.yml` | YES | #185; a runner's checkout path is not one we choose |
 * | `scripts/git-hooks/*` | YES, #202 | the source that bit twice after #185 |
 * | `packages/control/ansible/*.yml` | NO — examined and rejected, same reason as `.cmd` |
 * | `*.cmd` / `*.ps1` (Windows scheduled tasks) | NO — examined and rejected, see below |
 * | one script spawning another | NO — `spawned-paths.test.ts` owns that question, deliberately |
 * | a human typing `node scripts/x.mjs` | NO, and unknowable — the entry guard is what makes that safe |
 *
 * `*.cmd`/`*.ps1` AND THE ANSIBLE PLAYBOOKS WERE BOTH TRIED AND BACKED OUT, which is why it is listed as NOT covered rather than left
 * off. Reading those files finds `packages/worker-fleet/src/cli-flags.mjs`, `code-version.mjs`,
 * `dataset-paths.mjs`, `fleet-consistency.mjs`, `axe.ts`, `fetch-encoder.mjs` and `git-sandbox.ts` —
 * every one a LIBRARY MODULE named in a deployed-file manifest or a dependency list, not something
 * anyone executes. Being listed is not being invoked, and a discovery that cannot tell the
 * difference reports eight false entry points and gets loosened until it reports none. If a Windows
 * scheduled task ever invokes a `.mjs` directly, this is the source to add and the manifest problem is
 * what to solve first.
 *
 * A BARE BASENAME COUNTS, and that is not tidiness. `pre-commit` builds its path at runtime:
 * `guard_script="$(cd "$(dirname "$0")/.." && pwd)/piped-exit-status-guard.mjs"` — the repo-relative
 * path never appears, so a path-regex reads that hook and still misses the file it runs. Basenames are
 * resolved against the directories this repo actually keeps scripts in.
 */
/** Each hook, with shell comments stripped. */
function hookTexts(): string[] {
  const dir = `${REPO}scripts/git-hooks`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No hooks directory in this checkout is not a fault here; anything else that cannot be listed is.
    return [];
  }
  return names.flatMap((name) => {
    const path = `${dir}/${name}`;
    if (!statSync(path).isFile()) return [];
    // COMMENTS STRIPPED FIRST. A hook is heavily commented and its prose NAMES paths it does not run --
    // `git-sandbox.ts`, `cli-flags.mjs` and `axe.ts` are all mentioned in explanations here and are
    // libraries, not entry points. Every other discovery guard in this repo strips comments before
    // matching for the same reason: a file that only MENTIONS a script has not invoked it.
    return [readFileSync(path, "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n")];
  });
}

function invocationTexts(): { kind: "path" | "hook", text: string }[] {
  return [
    { kind: "path" as const, text: readFileSync(`${REPO}package.json`, "utf8") },
    ...workflowFiles().map((text) => ({ kind: "path" as const, text })),
    ...hookTexts().map((text) => ({ kind: "hook" as const, text })),
  ];
}

function entryPoints(): string[] {
  const found = new Set<string>();
  const keep = (path: string) => {
    // A GLOB IS NOT AN ENTRY POINT. `scripts/*.mjs` in a paths-filter reads exactly like an invocation,
    // and the first version of the workflow widening crashed ENOENT on one. Requiring the file to exist
    // is the honest filter; a path that has been DELETED is `referenced-scripts.test.ts`'s question.
    if (path.endsWith(".test.ts") || path.includes("*")) return;
    // NOT BUILD OUTPUT, AND NOT A DECLARATION FILE. A workflow names paths for many reasons besides
    // running them -- #168's diagnostic step names `packages/evidence/dist/wcag.d.ts` in an `ls` and a
    // `head`, purely to inspect what the build produced. `.d.ts` ends in `.ts` and the file exists, so
    // both filters above passed it and this test demanded an entry guard on a TypeScript declaration.
    //
    // Found by that step failing this very test: the workflow widening meeting a path it was never about.
    // An entry point is a SOURCE file something EXECUTES; `dist/` is what the compiler wrote. Narrowing
    // the population to the question rather than weakening the guard -- every executable entry point here
    // is a source file, and the npm-script half of the discovery names sources too.
    if (path.endsWith(".d.ts") || path.includes("/dist/")) return;
    if (existsSync(`${REPO}${path}`)) found.add(path);
  };
  for (const { kind, text } of invocationTexts()) {
    for (const match of text.matchAll(/(?:^|\s)((?:packages|scripts)\/[^\s]+\.(?:mjs|ts))/g)) {
      keep(match[1]);
    }
    // THE RUNTIME-CONSTRUCTED CASE, AND ONLY IN A HOOK. A hook is shell: a `.mjs` basename there is
    // something it runs. In source or a playbook the same token is far more often an IMPORT -- applied
    // everywhere it matched `cli-flags.mjs`, `code-version.mjs` and `dataset-paths.mjs`, none of them an
    // entry point, which is a discovery that finds too much and gets loosened until it finds nothing.
    if (kind !== "hook") continue;
    for (const match of text.matchAll(/(?:^|[\s"'`(/$])([a-z][a-z0-9-]*\.mjs)\b/g)) {
      keep(`scripts/${match[1]}`);
    }
  }
  return [...found].sort();
}

/**
 * The entry points discovered from `package.json` ALONE — the population before the workflow widening.
 *
 * Exported from the same regex the discovery uses rather than a second spelling of it, so the two halves
 * cannot disagree about what an entry point looks like. It exists only so the test can assert that the
 * widening is contributing something, which a total count cannot say.
 */
function npmScriptEntryPoints(): string[] {
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, "utf8"));
  const found = new Set<string>();
  for (const command of Object.values(pkg.scripts as Record<string, string>)) {
    for (const match of String(command).matchAll(/(?:^|\s)((?:packages|scripts)\/[^\s]+\.(?:mjs|ts))/g)) {
      if (!match[1].endsWith(".test.ts")) found.add(match[1]);
    }
  }
  return [...found];
}

/** Every workflow's text, plus `action.yml` — the other places this repo invokes a script by path. */
function workflowFiles(): string[] {
  const out: string[] = [];
  const action = `${REPO}action.yml`;
  if (existsSync(action)) out.push(readFileSync(action, "utf8"));
  const dir = `${REPO}.github/workflows`;
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".yml") || name.endsWith(".yaml")) out.push(readFileSync(`${dir}/${name}`, "utf8"));
  }
  return out;
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

  // AND THE WORKFLOW HALF, PINNED SEPARATELY, for the same reason the `.ts` count is: a total of 80
  // cannot tell 80 from `package.json` + 0 from workflows apart from 77 + 3, and the all-npm reading is
  // exactly the blindness this widening was added to end. Measured 2026-09-07: 77 from `package.json`
  // alone, 80 with workflows, and the three additions were all unguarded.
  //
  // Named rather than counted. A count would survive the set changing to three DIFFERENT files, and what
  // this pins is that CI's own directly-invoked scripts are in the population at all.
  const fromWorkflows = points.filter((p) => !npmScriptEntryPoints().includes(p));
  assert.ok(fromWorkflows.length >= 1,
    "no entry point was discovered from a workflow, so the widening has stopped matching. `ci.yml` "
    + "invokes `scripts/ci-changed.mjs` with `node` directly; if that is still true this cannot be empty.");

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

/**
 * EVERY FILE THAT DECLARES ITSELF AN ENTRY POINT — asked of the FILE, never of the invocation sources.
 *
 * The form question and the "does this file need a guard" question are different, and this one has been
 * riding on the other's answer for no reason. `entryPoints()` enumerates how a script comes to be
 * executed, and that enumeration was widened FOUR TIMES in one night — `package.json`, then `scripts/`
 * paths (#174), then workflows (#185), then git hooks (#202) — each time by adding the source that had
 * just bitten. The fifth instance bit anyway: `reconstitution-blank.mjs`… `reconstitution-drill.mjs` is
 * invoked by **none** of those (`package.json` 0, workflows 0, hooks 0). It is run by a human, because
 * `docs/roles/migrate.md` tells them to.
 *
 * **A doc telling a person to run something cannot be enumerated.** So the enumeration is inherently
 * incomplete, and the form check does not need it: **a file that is an entry point says so, in the guard
 * itself.** Measured on `main` at 20a85a3a — 93 files contain `import.meta.url ===`, exactly one used
 * the banned form, and all five of the night's instances declared a guard whose FORM was wrong.
 *
 * WHAT THIS DOES NOT CATCH, and the split is worthless if this is not said: a file with a top-level
 * executable body and NO guard at all declares nothing, so it is invisible here. `packages/cli/src/action/
 * run.ts` was exactly that. **That** question still needs the enumeration above, and that enumeration is
 * still incomplete — which is now visible rather than hidden behind a form check that appeared to cover
 * it.
 */
/** Every tracked source, excluding built output and tests — the population the FILE question needs. */
function trackedSources(): string[] {
  return walkTree({ kind: "both", roots: [] }).map((f) => f.path)
    .filter((f) => !f.includes("/dist/") && !f.endsWith(".test.ts"));
}

/**
 * A file's source with `//` comments removed — because a MENTION is not a USE, and this repo has paid for
 * that three times in one night. `install-git-hooks.mjs`'s own header QUOTES the banned form to explain
 * why it does not use it; scanning unstripped reports it as an offender.
 */
function executableSource(path: string): string {
  return readFileSync(`${REPO}${path}`, "utf8").split("\n")
    .filter((line) => !line.trimStart().startsWith("//")).join("\n");
}

function declaresAnEntryGuard(): string[] {
  return trackedSources().filter((path) => executableSource(path).includes("import.meta.url ==="));
}

test("every declared entry guard uses the exact comparison — no sources consulted", () => {
  const declared = declaresAnEntryGuard();

  // A floor, not a pin: there were 93 when this was written, and it is the FORM population rather than
  // the discovery's 84. Fewer means the scan has stopped matching real files, which is the only way this
  // test can go quietly green while the codebase is wrong.
  assert.ok(declared.length >= 85,
    `only ${declared.length} files declare an entry guard; the scan is broken, not the codebase clean`);

  const suffixForm = declared.filter((p) => /process\.argv\[1\]\?\.endsWith\(/.test(executableSource(p)));
  const concatenated = declared.filter((p) => /import\.meta\.url === `file:\/\//.test(executableSource(p)));

  // COLLECTED, NOT ASSERTED IN A LOOP: an assertion inside the walk stops at the first offender, and the
  // second then looks like a regression the next time somebody runs it.
  assert.deepEqual(suffixForm, [],
    'these guard on a path suffix; use import.meta.url === pathToFileURL(process.argv[1] ?? "").href');
  assert.deepEqual(concatenated, [],
    "these build the guard by string concatenation, which does not percent-encode -- a path with a space "
    + "makes it silently never run, so the script exits 0 having done nothing. Measured in a directory "
    + 'named "dir with space": the template form matched false while pathToFileURL matched. Use '
    + 'pathToFileURL(process.argv[1] ?? "").href');
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

  // `a11ign-nvda-worker` is Windows-only by ADR 0001, and npm's Windows bin shim is a `.cmd`/`.ps1` wrapper
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
