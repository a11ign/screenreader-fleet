import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "./source-walk.mjs";

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every `.mjs` file still PARSES — the check this repo names and never ran.
 *
 * `CLAUDE.md` states it outright: for `.mjs`, `node -e "import('./path.mjs')"` is the only real check,
 * because neither `npm run lint` nor `tsc --noEmit` sees a file that cannot load. `entry-points.test.ts`
 * exists so that importing is SAFE. Nothing then took the step of importing.
 *
 * WHAT THAT COST, twice in one session on 2026-09-01, both times while writing a comment about something
 * else. `desktop-dialogs.mjs` and `powershell.mjs` hold PowerShell inside a JS TEMPLATE LITERAL, so a
 * backtick ends the string:
 *
 *     SyntaxError: Unexpected identifier 'action'
 *
 * Lint was clean and tsc was clean for both. Each was caught only because I happened to run the import by
 * hand — which is this file's own definition of a check that does not happen: one that relies on somebody
 * remembering. The second occurrence is the argument for automating it; a rule broken twice in ten minutes
 * is not going to be remembered the third time.
 *
 * PARSE, NOT IMPORT, and the limitation is deliberate rather than lazy. Importing all 123 modules executes
 * them: measured here, one ran a live capture against example.com and another shelled out to Python. This
 * validates the syntax and runs nothing, which catches the whole class above — verified by mutation
 * against the REAL file, since a backtick landing where the surrounding text still parses is not caught,
 * and a test that cannot fail is worse than none.
 *
 * TypeScript's parser rather than `node --check`, for a reason the pre-push budget makes real: `--check`
 * takes one file per process, so 123 spawns cost 4.4 s against a hook this repo keeps at ~5 s total. A
 * check people delete is worth nothing. In-process parsing is ~40x faster and reports the same defect.
 *
 * What it does NOT catch is a module-scope ReferenceError — the shape `CLAUDE.md` records when a deleted
 * constant left `capture-core.mjs` throwing at import. That needs a real import, on a subset proven safe
 * to execute, and is the honest next step rather than something this file quietly claims.
 */
test("every .mjs parses, which lint and tsc cannot tell you", () => {
  const files: string[] = (sourceFiles() as Array<[string, string]>)
    .map(([rel]) => rel)
    .filter((rel) => rel.endsWith(".mjs"));

  assert.ok(files.length > 50,
    `expected the walker to find the .mjs corpus, got ${files.length} — a discovery test that finds ` +
    "nothing passes having examined nothing");

  const broken: string[] = [];
  for (const rel of files) {
    const path = resolve(PACKAGES, rel);
    // `ScriptKind.JS` with `setParentNodes` — the same parse a loader performs, without the loading.
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    // `parseDiagnostics` is not on the public SourceFile type; it is what the parser records and the only
    // way to get syntax errors without a full Program, which would need a tsconfig per package.
    const diagnostics = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
    for (const d of diagnostics.slice(0, 1)) {
      broken.push(`${rel}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
  }
  assert.deepEqual(broken, [],
    "these .mjs files do not parse, so they cannot load — and neither lint nor tsc reports it. The " +
    "usual cause is a backtick inside a template literal holding PowerShell or shell script.");
});
