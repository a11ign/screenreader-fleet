import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

// THE BOUNDARY OF THE ONE PACKAGE (a11ign/a11ign#2702): it came from a monorepo, where a relative import could leave it and land in
// a sibling, and a published package that does so is broken for every consumer. It is the repository root now, so nothing in `src` may
// import by a relative path that leaves the repository, and every `@a11ign/` name it imports must be one its manifest declares (the judge and the
// worker at run time; the evidence package for a test-support module).
const SOURCE = "src";
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

function sourceFiles(root: string, dir = SOURCE): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(root, rel);
    return /\.(mjs|ts|js)$/.test(entry.name) ? [rel] : [];
  });
}

export function refusals(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}), manifest.name]);
  const found: string[] = [];
  for (const file of sourceFiles(root)) {
    const code = readFileSync(join(root, file), "utf8").split("\n").filter((line) => !COMMENT_LINE.test(line)).join("\n");
    for (const [, specifier] of code.matchAll(IMPORT)) {
      const reached = specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), specifier)) : null;
      if (reached !== null && reached.startsWith("..")) found.push(`${file}: imports ${specifier}, outside the package`);
      const scope = specifier.match(/^(@a11ign\/[^/]+)/)?.[1];
      if (scope !== undefined && !declared.has(scope)) found.push(`${file}: imports ${specifier}, which the manifest does not declare`);
    }
  }
  return found;
}

test("no file of the package imports across its boundary, and every @a11ign/ import is declared", () => {
  const root = new URL("..", import.meta.url).pathname;
  assert.ok(sourceFiles(root).length > 50, "positive control: the walk found the package's files");
  assert.deepEqual(refusals(root), []);
});

test("control: a relative import out of the repository and an undeclared sibling are each REFUSED", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-boundary-"));
  try {
    mkdirSync(join(root, SOURCE), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@a11ign/screenreader-fleet", dependencies: { "@a11ign/judge": "0.1.0" } }));
    writeFileSync(join(root, SOURCE, "x.mjs"),
      'import "../../guards/src/walk.mjs";\nimport { a } from "@a11ign/lab";\nimport "@a11ign/judge/rules";\nimport "./own.mjs";\n// import "../../ignored.mjs";\n');
    assert.deepEqual(refusals(root), [
      `${SOURCE}/x.mjs: imports ../../guards/src/walk.mjs, outside the package`,
      `${SOURCE}/x.mjs: imports @a11ign/lab, which the manifest does not declare`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
