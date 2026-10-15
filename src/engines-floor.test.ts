import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

// NO RUNTIME DEPENDENCY NEEDS A NEWER NODE THAN THIS PACKAGE SAYS IT RUNS ON (a11ign/a11ign#5507). `@a11ign/toolchain` moved from
// `devDependencies` to `dependencies` at 0.5.0, and its lockfile entry says `>=22.15.0` while `engines.node` said `>=20`: a Node 20
// consumer could install a production dependency whose declared engine it does not satisfy. Nothing else reads the lockfile's
// `engines`, so the next toolchain bump would reopen it silently.
//
// The lockfile is read rather than `node_modules`: it records each locked version's floor whether or not the package is installed, and
// its importer entry names the version this package's own dependencies resolve to.

type Manifest = { engines: { node: string }; dependencies?: Record<string, string> };
type Lockfile = {
  importers: { ".": { dependencies: Record<string, { version: string }> } };
  packages: Record<string, { engines?: { node: string } }>;
};

// The lowest version a range admits, read as the first `major[.minor[.patch]]` it names: `>=22.15.0` is 22.15.0 and `>=20` is 20.0.0.
// A range with no version in it is an error, never a pass.
function floorOf(range: string): number[] {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  if (!match) throw new Error(`no version floor in engines range "${range}"`);
  return [match[1], match[2], match[3]].map((part) => Number(part ?? 0));
}

function isAbove(floor: number[], ceiling: number[]): boolean {
  const firstDifference = floor.map((part, i) => part - ceiling[i]).find((difference) => difference !== 0);
  return firstDifference !== undefined && firstDifference > 0;
}

function engineFloorViolations({ manifest, lockfile }: { manifest: Manifest; lockfile: Lockfile }): string[] {
  const declared = manifest.engines.node;
  return Object.keys(manifest.dependencies ?? {}).flatMap((name) => {
    const version = lockfile.importers["."].dependencies[name]?.version;
    if (version === undefined) throw new Error(`${name} is not in the lockfile's root importer`);
    // The `(…)` peer suffix on an importer's version is not part of the `packages` key.
    const id = `${name}@${version.split("(")[0]}`;
    const entry = lockfile.packages[id];
    if (!entry) throw new Error(`${id} is not in the lockfile's packages`);
    // A package that declares no engines sets no floor for this package to exceed.
    if (!entry.engines) return [];
    const locked = entry.engines.node;
    return isAbove(floorOf(locked), floorOf(declared)) ? [`${id} needs ${locked}, package says ${declared}`] : [];
  });
}

// The positive control for the real tree is the first test below, which fails on the base naming the offending dependency. The fixture
// tests are the function's own controls: one must name the violation, and one with agreeing floors must stay silent, so a check that
// always reports (or never does) cannot pass both.
function fixture(packageNode: string, lockedNode: string) {
  return {
    manifest: { engines: { node: packageNode }, dependencies: { "@a11ign/toolchain": "0.9.0" } },
    lockfile: {
      importers: { ".": { dependencies: { "@a11ign/toolchain": { version: "0.9.0(@rslib/core@1.0.3)" } } } },
      packages: { "@a11ign/toolchain@0.9.0": { engines: { node: lockedNode } } },
    },
  };
}

test("no runtime dependency's engine floor is above this package's engines.node", () => {
  const packageDir = resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Manifest;
  const lockfile = parse(readFileSync(join(packageDir, "pnpm-lock.yaml"), "utf8")) as Lockfile;
  assert.deepEqual(engineFloorViolations({ manifest, lockfile }), []);
});

test("a dependency whose floor is above the package's is named", () => {
  assert.deepEqual(engineFloorViolations(fixture(">=20", ">=22.15.0")), [
    "@a11ign/toolchain@0.9.0 needs >=22.15.0, package says >=20",
  ]);
});

test("a dependency whose floor agrees with the package's is not named", () => {
  assert.deepEqual(engineFloorViolations(fixture(">=22.15.0", ">=22.15.0")), []);
});
