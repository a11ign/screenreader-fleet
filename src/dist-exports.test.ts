import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingExportTargets } from "./doctor.ts";

// `doctor`'s dist-freshness check reads what Rslib's output IS, the files `exports` promises, rather than asking `tsc --build --dry` (a11ign/a11ign#3810):
// a package built by Rslib has a `noEmit` tsconfig, so tsc has no output to call up to date. These cases are the check's own controls: a built package
// reads nothing missing, and each way of not being built reads missing or unknown, never clean.

const EXPORTS = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
  "./rules": { types: "./dist/rules.d.ts", default: "./dist/rules.mjs" },
};

function withPackage(manifest: unknown, files: string[], run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "doctor-exports-"));
  try {
    mkdirSync(join(dir, "dist"));
    if (manifest !== undefined) writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    for (const file of files) writeFileSync(join(dir, file), "");
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALL = ["dist/index.d.ts", "dist/index.mjs", "dist/rules.d.ts", "dist/rules.mjs"];

test("a package whose every exports target is on disk reads nothing missing", () => {
  withPackage({ exports: EXPORTS }, ALL, (dir) => assert.deepEqual(missingExportTargets(dir), []));
});

test("POSITIVE CONTROL: a dist missing a target names exactly that target, so the clean reading above is not vacuous", () => {
  withPackage({ exports: EXPORTS }, ALL.filter((file) => file !== "dist/rules.mjs"), (dir) =>
    assert.deepEqual(missingExportTargets(dir), ["./dist/rules.mjs"]));
});

test("a dist that was never built names every target, nested conditions included", () => {
  withPackage({ exports: EXPORTS }, [], (dir) => assert.equal(missingExportTargets(dir)?.length, ALL.length));
});

test("a string `exports` and a nested condition map are both read", () => {
  withPackage({ exports: "./dist/index.mjs" }, [], (dir) => assert.deepEqual(missingExportTargets(dir), ["./dist/index.mjs"]));
  withPackage({ exports: { ".": { node: { default: "./dist/n.mjs" } } } }, [], (dir) =>
    assert.deepEqual(missingExportTargets(dir), ["./dist/n.mjs"]));
});

test("null, never an empty list, when the manifest cannot be read or promises nothing", () => {
  withPackage(undefined, ALL, (dir) => assert.equal(missingExportTargets(dir), null));
  withPackage({ name: "no-exports" }, ALL, (dir) => assert.equal(missingExportTargets(dir), null));
});
