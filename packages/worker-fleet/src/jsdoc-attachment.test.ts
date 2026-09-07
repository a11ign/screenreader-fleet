import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import { sourceFiles } from "./source-walk.mjs";

/**
 * A JSDoc BLOCK THAT IS NOT THE LAST ONE ABOVE A DECLARATION IS DISCARDED, SILENTLY (#244).
 *
 * Three incidents in one night — #228 (nine call sites went red), #232 (`prState`), and
 * `browser-session.mjs` — all looked like "a merge orphaned a doc comment". Measured, there are two
 * distinct shapes and only one of them needs a guard:
 *
 * | what sits between the JSDoc and its function | is `@param` still seen? |
 * |---|---|
 * | nothing (the control) | YES |
 * | a `//` line comment | YES — so do NOT "fix" these |
 * | **a second JSDoc block** | **NO, and nothing is reported** |
 * | a declaration that got inserted | NO — but `TS8024` names it |
 *
 * **The last row is why this guard is narrow on purpose.** TypeScript already emits
 * `TS8024: JSDoc '@param' tag has name 'o', but there is no parameter with that name` for an inserted
 * declaration, so that shape closes by widening the CHECKED POPULATION (#189/#240) and needs no second
 * mechanism. The stacked-block shape is the one the compiler is silent about, so a test is the only thing
 * that keeps it fixed. Building a detector for both would have shipped a duplicate of the compiler.
 *
 * ASKED OF THE AST, NEVER A REGEX. `node.jsDoc` holds every leading block in order and TypeScript resolves
 * types from the LAST one, so "an earlier block carries tags the last one does not" is the fault stated
 * directly. The first version of this was a regex over comment text and it needed two false-positive
 * classes removed by hand — the line-comment case above, and a second block that simply re-declares the
 * same params. The AST has neither, and it sees CHAINS (three or more stacked blocks, which
 * `diagnostics.mjs` had two of) without being told they exist.
 *
 * POPULATION, STATED because a guard whose walk is narrower than its prose is this repo's fourth census
 * shape: `sourceFiles` is `packages/` only, excluding `dist` and `*.test.ts`. **`scripts/` is not walked
 * here**, which is not an oversight but is a real limit — and it is the same population gap #240 exists to
 * close, so this guard grows when that one does rather than by a second list.
 */

/** A tag's parameter name, or `""` for `@returns` — enough to compare what a later block re-declares. */
function tagIdentity(tag: ts.JSDocTag): string {
  const name = (tag as ts.JSDocParameterTag).name;
  return `${tag.tagName.escapedText}:${name && ts.isIdentifier(name) ? name.escapedText : ""}`;
}

/** Every `@param`/`@returns` this block declares, as comparable identities. */
function typeTagsOf(block: ts.JSDoc): string[] {
  return (block.tags ?? [])
    .filter((t) => t.tagName.escapedText === "param" || t.tagName.escapedText === "returns")
    .map(tagIdentity);
}

type Orphan = { file: string; line: number; discarded: string[] };

/**
 * Blocks whose type tags never reach the compiler: not the last block, and declaring something the last
 * block does not. A duplicate of the last block's tags loses nothing and is deliberately not reported —
 * reporting it would send a reader to reattach an annotation that is already correct one line down.
 */
export function orphanedBlocks(file: string, source: string): Orphan[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Orphan[] = [];
  const visit = (node: ts.Node): void => {
    const blocks = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc ?? [];
    if (blocks.length > 1) {
      const kept = new Set(typeTagsOf(blocks[blocks.length - 1]));
      for (const block of blocks.slice(0, -1)) {
        const discarded = typeTagsOf(block).filter((t) => !kept.has(t));
        if (discarded.length > 0) {
          found.push({
            file,
            line: parsed.getLineAndCharacterOfPosition(block.getStart(parsed)).line + 1,
            discarded,
          });
        }
      }
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);
  return found;
}

test("no JSDoc block declares types the compiler will discard", () => {
  const orphans = sourceFiles()
    .flatMap(([path, source]: [string, string]) => orphanedBlocks(path, source));
  assert.deepEqual(orphans.map((o) => `${o.file}:${o.line}  ${o.discarded.join(" ")}`), [],
    "each of these is a JSDoc block sitting above ANOTHER JSDoc block, so TypeScript resolves the later "
    + "one and these tags reach nothing. Move the tags into the block that is actually adjacent to the "
    + "declaration, or delete them if they are a leftover duplicate.");
});

/**
 * THE CONTROL, and it is the half that makes the assertion above mean anything.
 *
 * A guard that reports nothing is indistinguishable from a guard that examines nothing — this repo's most
 * expensive recurring shape, and one this very row hit while sizing it (a regex reporting 29 hits, of
 * which 19 were classes it had no business flagging). So the detector is driven against the four shapes
 * that were MEASURED against `tsc` before it was written, and must agree with each.
 */
test("the detector agrees with what tsc actually does, on all four measured shapes", () => {
  const adjacent = `/**\n * @param {{a: string}} o\n */\nexport function f(o) { return o; }\n`;
  assert.deepEqual(orphanedBlocks("p.mjs", adjacent), [], "adjacent: the control, nothing is discarded");

  const lineComment = `/**\n * @param {{a: string}} o\n */\n// a comment\nexport function f(o) { return o; }\n`;
  assert.deepEqual(orphanedBlocks("p.mjs", lineComment), [],
    "a line comment does NOT break the attachment -- measured against tsc, and reporting it would send "
    + "somebody to 'fix' code that is already correct");

  const stacked = `/**\n * @param {{a: string}} o\n */\n/** unrelated */\nexport const X = 4;\n`;
  assert.equal(orphanedBlocks("p.mjs", stacked).length, 1, "a second block discards the first");

  const chain = `/**\n * @param {{a: string}} o\n */\n/** one */\n/** two */\nexport const X = 4;\n`;
  assert.equal(orphanedBlocks("p.mjs", chain).length, 1,
    "a CHAIN is found too -- diagnostics.mjs had two of these, and a check written for pairs would have "
    + "reported one of them");

  const duplicate = `/**\n * @param {{a: string}} o\n */\n/**\n * @param {{a: string}} o\n */\n`
    + `export function f(o) { return o; }\n`;
  assert.deepEqual(orphanedBlocks("p.mjs", duplicate), [],
    "a later block re-declaring the same tags loses nothing -- audit-size-sensitivity.mjs:99 is this "
    + "shape and wants DELETING, not reattaching, so flagging it would prescribe the wrong fix");
});
