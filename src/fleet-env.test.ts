/**
 * THE CONTROL PLANE LOADS THIS FILE FROM A RAW CHECKOUT WITH NO `npm install` (ADR 0012, #4680).
 *
 * 0.7.0 made `cli-flags.ts` a re-export of `@a11ign/toolchain/lib/cli-flags` (#4592) while `fleet-env.ts` — which
 * `control` imports — went on importing it, so the control plane could not load the laid fleet and `control`'s own
 * "nothing is imported by package name, transitively" test was the only thing that said so. It said so one release
 * LATE, from another repository. This is the same question asked where the code is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { flagValue as toolchainFlagValue, unknownFlags as toolchainUnknownFlags } from "@a11ign/toolchain/lib/cli-flags";

import { inventoryPathsFor, unknownFlagsOf } from "./fleet-env.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const FLEET_ENV = join(SRC, "fleet-env.ts");
const KNOWN = ["--list", "--inventory=", "--group-vars="];

/** Every relative import reachable from `entry`, as paths under `SRC` (the closure the control plane would walk). */
function relativeClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, spec] of source.matchAll(/\bfrom\s+"(\.[^"]+)"/g)) visit(resolve(dirname(file), spec));
  };
  visit(entry);
  return [...seen];
}

/** Whether any ancestor of `dir` holds a `node_modules`, which is what would let a package-name import resolve. */
function hasNodeModulesAbove(dir: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, "node_modules"))) return true;
    if (current === parse(current).root) return false;
  }
}

/** Copies `entry` and its relative closure into a fresh directory outside this checkout, and loads the copy. */
function loadFromBareDirectory(entry: string, { argv = [] }: { argv?: string[] } = {}) {
  const bare = mkdtempSync(join(tmpdir(), "fleet-env-bare-"));
  try {
    assert.equal(hasNodeModulesAbove(bare), false,
      `${bare} has a node_modules above it, so this load would resolve a package name and prove nothing`);
    for (const file of relativeClosure(entry)) {
      const target = join(bare, file.slice(SRC.length + 1));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
    const copy = join(bare, entry.slice(SRC.length + 1));
    // A driver FILE, not `node -e`: with `-e` the extra arguments land at argv[1], where the guard never looks.
    const driver = join(bare, "driver.mjs");
    writeFileSync(driver, `await import(${JSON.stringify(pathToFileURL(copy).href)});\n`);
    return spawnSync(process.execPath, [driver, ...argv], { encoding: "utf8", cwd: bare });
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
}

test("fleet-env.ts LOADS from a directory with no node_modules above it", () => {
  const closure = relativeClosure(FLEET_ENV);
  assert.ok(closure.length >= 2, `the closure is ${closure.length} file(s), so it followed no import and proves nothing`);
  const loaded = loadFromBareDirectory(FLEET_ENV);
  assert.equal(loaded.status, 0,
    `fleet-env.ts cannot be loaded without an install, which is what the control plane does:\n${loaded.stderr}`);
});

test("the harness can see the failure: the toolchain re-export does NOT load from a bare directory", () => {
  // The positive control for the test above. Without it, a harness that loaded nothing would pass in silence.
  const loaded = loadFromBareDirectory(join(SRC, "cli-flags.ts"));
  assert.notEqual(loaded.status, 0, "cli-flags.ts loaded with no install, so the bare directory is not bare");
  assert.match(loaded.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package '@a11ign\/toolchain'/);
});

test("importing it as a library never inspects the importer's flags", () => {
  // Only the CLI-entry path refuses. A `control` process run with its own flags must not be refused by an import.
  const loaded = loadFromBareDirectory(FLEET_ENV, { argv: ["--not-a-fleet-env-flag"] });
  assert.equal(loaded.status, 0, loaded.stderr);
});

test("run as the command, an unknown flag is refused with exit 2 and named", () => {
  const run = spawnSync(process.execPath, [FLEET_ENV, "--lisst"], { encoding: "utf8" });
  assert.equal(run.status, 2, `expected the refusal's exit 2, got ${run.status}:\n${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /unknown flag --lisst/);
  assert.match(run.stderr, /It takes: --group-vars --inventory --list/);
  assert.equal(run.stdout, "", "a refused run must print nothing a shell would eval");
});

test("the in-package check reaches the toolchain copy's verdict on every flag shape", () => {
  // The toolchain's copy is the one shared guard (#4425); this module cannot import it, so it carries a four-line
  // equivalent, and THIS is what stops the two drifting apart.
  const vectors: string[][] = [
    [], ["--list"], ["--lisst"], ["--inventory=/a=b/inventory.yml"], ["--group-vars="], ["-e", "x=1"], ["--", "--list"],
    ["positional"], ["--nope=3", "--list"], ["--list=anything"], ["-"], ["--inventory", "path"],
  ];
  for (const argv of vectors) {
    assert.deepEqual(unknownFlagsOf(argv), toolchainUnknownFlags(argv, KNOWN), `argv ${JSON.stringify(argv)}`);
  }
});

test("the in-package flag value reaches the toolchain copy's on every value shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-env-flag-"));
  try {
    const inventory = join(dir, "a=b.yml");
    const groupVars = join(dir, "group.yml");
    writeFileSync(inventory, "");
    writeFileSync(groupVars, "");
    const argv = [`--inventory=${inventory}`, `--group-vars=${groupVars}`, `--inventory=${groupVars}`];
    assert.equal(inventoryPathsFor({ argv }).inventoryPath, toolchainFlagValue(argv, "inventory"),
      "the first of a repeated flag wins, and a value holding its own `=` is not truncated");
    assert.equal(inventoryPathsFor({ argv }).groupVarsPath, toolchainFlagValue(argv, "group-vars"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
