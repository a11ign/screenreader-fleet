import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { entriesFromExports, entryProblems } from "@a11ign/toolchain/entries";

// THE BUILT PACKAGE IS PINNED, because every other test in this package reads `src` (a11ign/a11ign#3762, as #3734 did for the worker).
//
// `@a11ign/screenreader-fleet` ships `dist`, built by Rslib (a11ign/a11ign#3554), and nothing else here fails when `exports` or `bin`
// names a file the build did not make: the one reading that the tarball is whole was taken by hand. CI runs `pnpm run build` before
// `pnpm test`, so a test that reads `dist` is red there the next time a build breaks one of these.
//
// NOT HERE: `doctor.mjs`, `compare-workers.mjs` and `fleet-env.mjs` read `../../../` and `../../control/ansible/`, which was the monorepo's
// layout and is wrong from an installed package. That is the owner's decision (a11ign/a11ign#3762, "Not in scope"), so no assertion
// about it is written to pass or fail on it.

const packageDir = resolve(import.meta.dirname, "..");
const distDir = join(packageDir, "dist");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  bin: Record<string, string>;
  files: string[];
};

// `dist` is a build product, so on a fresh checkout `pnpm test` without `pnpm run build` has nothing to read. That is a SKIP that says
// so, and CI must not be able to take it: there an absent `dist` is a failure, and the last test below asserts it.
const built = existsSync(distDir);
const mustBeBuilt = process.env.CI !== undefined;
const NOT_BUILT = `${distDir} does not exist: run \`pnpm run build\` first (CI does, before \`pnpm test\`)`;

function whenBuilt(t: TestContext): boolean {
  if (built) return true;
  if (mustBeBuilt) assert.fail(NOT_BUILT);
  t.skip(NOT_BUILT);
  return false;
}

// Every string in a value that `exports` or `bin` hangs a file on: a condition object (`types`, `default`) nests, `bin` is flat.
function targetsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(targetsOf);
  return [];
}

function missingTargets(dir: string, targets: string[]): string[] {
  return targets.filter((target) => !existsSync(join(dir, target)));
}

const exportTargets = targetsOf(manifest.exports);
const binTargets = targetsOf(manifest.bin);
const builtBinTargets = binTargets.filter((target) => target.startsWith("./dist/"));

// The entry map Rslib is handed: the `exports` entries the preset derives, then the `bin` commands `rslib.config.ts` adds beside them.
async function configuredEntries(): Promise<Record<string, string>> {
  const config = (await tsImport(pathToFileURL(join(packageDir, "rslib.config.ts")).href, import.meta.url)).default;
  return config.lib[0].source.entry;
}

// `bin` commands are built but are not `exports` keys, so `entryProblems` would call each one "built but no exports subpath points at
// it". They are handed over as subpaths of their own, which is what they are: a published name that resolves to a built file.
function exportsAndBins(): { exports: Record<string, string> } {
  const asSubpaths = builtBinTargets.map((target) => [`bin:${target}`, target] as const);
  return { exports: { ...(manifest.exports as Record<string, string>), ...Object.fromEntries(asSubpaths) } };
}

test("the guards name what is missing (positive control for the emptiness assertions below)", async () => {
  assert.deepEqual(missingTargets(packageDir, ["./package.json", "./dist/no-such-file.mjs"]), ["./dist/no-such-file.mjs"]);
  assert.ok(exportTargets.includes("./dist/index.mjs") && exportTargets.includes("./dist/index.d.ts"), "`exports` names `.` for both conditions");
  assert.ok(builtBinTargets.includes("./dist/doctor.mjs"), "`bin` names `doctor`, which is not an `exports` key");

  // The control's entry map comes from the manifest and the disk, NOT from `rslib.config.ts`: it must keep working while the real map
  // is the thing that is broken, or a broken map would fail the control as well as the case that reads it.
  const entries = entriesFromExports(exportsAndBins(), { dir: packageDir });
  assert.deepEqual(entryProblems(exportsAndBins(), entries), []);
  const withoutHealth = Object.fromEntries(Object.entries(entries).filter(([name]) => name !== "worker-health"));
  assert.deepEqual(entryProblems(exportsAndBins(), withoutHealth), ['exports "./health" builds "worker-health", which has no entry']);
  assert.deepEqual(
    entryProblems(exportsAndBins(), { ...entries, orphan: "./src/orphan.mjs" }),
    ['entry "orphan" is built but no exports subpath points at it'],
  );
});

test("every file `exports` names, for `default` and for `types`, is in the built package", (t) => {
  if (!whenBuilt(t)) return;
  assert.deepEqual(missingTargets(packageDir, exportTargets), []);
});

test("every file `bin` names is in the built package, or in a directory `files` ships", (t) => {
  if (!whenBuilt(t)) return;
  assert.deepEqual(missingTargets(packageDir, binTargets), []);
  // `a11ign-worker-ctl` is a shell script, which is not built: it ships from `src/local-worker` because `files` says so.
  const unbuilt = binTargets.filter((target) => !target.startsWith("./dist/"));
  const unshipped = unbuilt.filter((target) => !manifest.files.some((entry) => target.startsWith(`./${entry}/`)));
  assert.deepEqual(unshipped, []);
});

test("`rslib.config.ts`'s entry map and `exports` plus `bin` agree, in both directions", async () => {
  assert.deepEqual(entryProblems(exportsAndBins(), await configuredEntries()), []);
});

test("`fleetScriptPaths()` from the BUILT `dist/index.mjs` names paths that exist", async (t) => {
  if (!whenBuilt(t)) return;
  // The built module finds `../src/local-worker` from its OWN file, which only holds while every built file is directly under `dist`:
  // the preset leaves `new URL("../src/local-worker/", import.meta.url)` as written, so a chunk built into a subdirectory would
  // resolve to a directory that does not exist and `leaseWorker` could not find the script it drives.
  const { fleetScriptPaths } = await import(/* webpackIgnore: true */ pathToFileURL(join(distDir, "index.mjs")).href);
  const paths: Record<string, string> = fleetScriptPaths();
  assert.ok(Object.keys(paths).length > 1, "the reading is not an empty object, so the loop below asserts something");
  const missing = Object.entries(paths).filter(([, path]) => !existsSync(path)).map(([name, path]) => `${name}: ${path}`);
  assert.deepEqual(missing, []);
  assert.ok(statSync(paths.dir!).isDirectory() && statSync(paths.provisioning!).isDirectory());
  assert.equal(relative(packageDir, paths.dir!), join("src", "local-worker"));
});

test("the cases above ran against a build: in CI an absent `dist` fails them, it does not skip them", (t) => {
  // A skip that fires always is a check that never runs. Locally an unbuilt `dist` skips with its reason; under CI `whenBuilt` fails
  // instead, so this is the case that says the ordinary run is covered: `dist` is there and holds the entry `fleetScriptPaths()` is read from.
  if (!whenBuilt(t)) return;
  assert.ok(existsSync(join(distDir, "index.mjs")));
});
