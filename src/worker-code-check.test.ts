// `resolveExpectedWorkerCode` asks the layer CLONE's own hasher, and which FILE that is changed under it: `@a11ign/screenreader-worker`
// 0.9.0 ships `code-version.ts` and no `code-version.mjs`, and the line that imported the `.mjs` threw on a clone laid at that release
// (a11ign/a11ign#4651, found by #4516). `worker-code-clone.test.ts` pins the end-to-end reading with an `.mjs` clone; this file pins
// WHICH hasher file is chosen, each fixture a raw-`src` clone holding only the files named in its test.
//
// Every hasher below returns a distinct constant (`from-ts`, `from-mjs`) rather than a hash, so a reading names the file that
// answered it, and the expected value is a literal here, never computed by the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExpectedWorkerCode } from "./worker-code-check.ts";

const CLONE_PATH = "packages/nvda-worker";

const HASHER_TS = `export const codeVersion = (dir: string): string => "from-ts" + (dir ? "" : "?");\n`;
const HASHER_MJS = `export const codeVersion = (dir) => "from-mjs" + (dir ? "" : "?");\n`;

/** A checkout root whose `layers.json` declares the clone, with `files` written into the clone's `src/`. */
function checkoutWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "worker-code-check-"));
  mkdirSync(join(root, "packages", "control"), { recursive: true });
  writeFileSync(join(root, "packages", "control", "layers.json"),
    JSON.stringify({ layers: { "nvda-worker": { path: CLONE_PATH, remote: "https://example.invalid/nvda.git" } } }));
  const src = join(root, CLONE_PATH, "src");
  mkdirSync(src, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(src, name), content);
  return root;
}

async function expectedFrom(files: Record<string, string>) {
  const root = checkoutWith(files);
  try { return await resolveExpectedWorkerCode({ checkoutRoot: root }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a clone that ships only `code-version.ts` (worker 0.9.0) is hashed by it", async () => {
  const expected = await expectedFrom({ "code-version.ts": HASHER_TS });
  assert.equal(expected.source, "clone");
  assert.equal(expected.code, "from-ts");
});

test("a clone from before the move to TypeScript, holding only `code-version.mjs`, is still hashed by it", async () => {
  const expected = await expectedFrom({ "code-version.mjs": HASHER_MJS });
  assert.equal(expected.source, "clone");
  assert.equal(expected.code, "from-mjs");
});

test("a clone holding both asks the `.ts`: the `.mjs` is the fallback, never the preference", async () => {
  const expected = await expectedFrom({ "code-version.ts": HASHER_TS, "code-version.mjs": HASHER_MJS });
  assert.equal(expected.code, "from-ts");
});

test("a clone holding NEITHER is refused by name, never answered for by the installed copy", async () => {
  await assert.rejects(expectedFrom({ "capture-core.mjs": "export {};\n" }), (error: Error) => {
    assert.match(error.message, /code-version\.ts/);
    assert.match(error.message, /code-version\.mjs/);
    return true;
  });
});
