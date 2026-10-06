import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runsDirFor } from "./doctor.mjs";
import { outDirFor } from "./compare-workers.mjs";
import { inventoryPathsFor } from "./fleet-env.mjs";

/**
 * `doctor`, `compare-workers` and `fleet-env` take the paths they read from the CALLER, and refuse naming the missing one
 * where they used to resolve the monorepo's layout from wherever the module happened to be (a11ign/a11ign#3767).
 *
 * From `node_modules/@a11ign/screenreader-fleet/dist`, `../../../` is `node_modules` and `../../control` is a package that
 * is not in the tarball, so `doctor` and `compare-workers` would have written under the dependency and `fleet-env --list`
 * died on an ENOENT. Each resolver takes an injected `baseDir`, so both layouts are built in a scratch directory here
 * instead of by packing the package (the built package is pinned by `built-package.test.ts`).
 *
 * Per command: (a) a supplied path is used, (b) with the monorepo path absent and none supplied it refuses naming the path
 * and the flag, (c) with the monorepo path present nothing changes.
 */
const here = import.meta.dirname;

// Removed when the process ends: rstest's test context has no `after`.
const scratch: string[] = [];
process.on("exit", () => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A scratch directory with a stand-in checkout (`monorepo`) and a stand-in installed package (`installed`). */
function layouts() {
  const root = mkdtempSync(join(tmpdir(), "installed-layout-"));
  scratch.push(root);
  const monorepo = join(root, "monorepo");
  const installed = join(root, "installed", "node_modules", "@a11ign", "screenreader-fleet", "dist");
  mkdirSync(join(monorepo, "packages", "worker-fleet", "src"), { recursive: true });
  mkdirSync(join(monorepo, "packages", "control", "ansible", "group_vars"), { recursive: true });
  writeFileSync(join(monorepo, "package.json"), "{}");
  writeFileSync(join(monorepo, "packages", "control", "ansible", "inventory.yml"), "all:\n");
  writeFileSync(join(monorepo, "packages", "control", "ansible", "group_vars", "a11y_workers.yml"), "a11y_worker_port: 8765\n");
  mkdirSync(installed, { recursive: true });
  return { root, monorepoBase: join(monorepo, "packages", "worker-fleet", "src"), monorepo, installed };
}

test("doctor: a supplied --runs-dir is used, in either layout", () => {
  const { root, installed, monorepoBase } = layouts();
  const supplied = join(root, "elsewhere");
  mkdirSync(supplied);
  assert.equal(runsDirFor({ argv: [`--runs-dir=${supplied}`], baseDir: installed }), supplied);
  assert.equal(runsDirFor({ argv: [`--runs-dir=${supplied}`], baseDir: monorepoBase }), supplied);
});

test("doctor: with no checkout and no --runs-dir it refuses naming the directory and the flag", () => {
  const { installed } = layouts();
  const nodeModules = resolve(installed, "..", "..", "..");
  assert.throws(() => runsDirFor({ argv: [], baseDir: installed }),
    (error: Error) => error.message.includes(nodeModules) && error.message.includes("--runs-dir="));
});

test("doctor: a supplied --runs-dir that does not exist refuses naming it, rather than reporting a dataset not generated", () => {
  const { root, monorepoBase } = layouts();
  const missing = join(root, "typo");
  assert.throws(() => runsDirFor({ argv: [`--runs-dir=${missing}`], baseDir: monorepoBase }),
    (error: Error) => error.message.includes(missing) && error.message.includes("--runs-dir="));
});

test("doctor: inside a checkout the default is the checkout's runs/, even before it exists", () => {
  const { monorepo, monorepoBase } = layouts();
  assert.equal(runsDirFor({ argv: [], baseDir: monorepoBase }), join(monorepo, "runs"));
});

test("compare-workers: a supplied --runs-dir is used, and need not exist yet", () => {
  const { root, installed } = layouts();
  const supplied = join(root, "not-yet");
  assert.equal(outDirFor({ argv: [`--runs-dir=${supplied}`], baseDir: installed }), join(supplied, "worker-compare"));
});

test("compare-workers: with no checkout and no --runs-dir it refuses naming the directory and the flag", () => {
  const { installed } = layouts();
  const nodeModules = resolve(installed, "..", "..", "..");
  assert.throws(() => outDirFor({ argv: [], baseDir: installed }),
    (error: Error) => error.message.includes(nodeModules) && error.message.includes("--runs-dir="));
  assert.throws(() => outDirFor({ argv: ["--runs-dir="], baseDir: installed }), /--runs-dir= is empty/);
});

test("compare-workers: inside a checkout the default is the checkout's runs/worker-compare", () => {
  const { monorepo, monorepoBase } = layouts();
  assert.equal(outDirFor({ argv: ["--rounds=2"], baseDir: monorepoBase }), join(monorepo, "runs", "worker-compare"));
});

test("fleet-env: supplied --inventory and --group-vars are used, in either layout", () => {
  const { root, installed, monorepoBase } = layouts();
  const inventoryPath = join(root, "hosts.yml");
  const groupVarsPath = join(root, "vars.yml");
  writeFileSync(inventoryPath, "all:\n");
  writeFileSync(groupVarsPath, "a11y_worker_port: 9000\n");
  const argv = [`--inventory=${inventoryPath}`, `--group-vars=${groupVarsPath}`];
  assert.deepEqual(inventoryPathsFor({ argv, baseDir: installed }), { inventoryPath, groupVarsPath });
  assert.deepEqual(inventoryPathsFor({ argv, baseDir: monorepoBase }), { inventoryPath, groupVarsPath });
});

test("fleet-env: with no monorepo files and none supplied it refuses naming each path and its flag", () => {
  const { root, installed } = layouts();
  const inventory = join(root, "installed", "node_modules", "@a11ign", "control", "ansible", "inventory.yml");
  assert.throws(() => inventoryPathsFor({ argv: [], baseDir: installed }),
    (error: Error) => error.message.includes(inventory) && error.message.includes("--inventory="));
  // The inventory is named but the group vars are not: the default for the second is the missing monorepo one.
  const named = join(root, "hosts.yml");
  writeFileSync(named, "all:\n");
  assert.throws(() => inventoryPathsFor({ argv: [`--inventory=${named}`], baseDir: installed }),
    (error: Error) => error.message.includes("a11y_workers.yml") && error.message.includes("--group-vars="));
});

test("fleet-env: a supplied path that does not exist refuses naming it", () => {
  const { root, monorepoBase } = layouts();
  const missing = join(root, "typo.yml");
  assert.throws(() => inventoryPathsFor({ argv: [`--inventory=${missing}`], baseDir: monorepoBase }),
    (error: Error) => error.message.includes(missing) && error.message.includes("--inventory="));
});

test("fleet-env: inside a checkout the defaults are the checkout's control files", () => {
  const { monorepo, monorepoBase } = layouts();
  const ansible = join(monorepo, "packages", "control", "ansible");
  assert.deepEqual(inventoryPathsFor({ argv: ["--list"], baseDir: monorepoBase }), {
    inventoryPath: join(ansible, "inventory.yml"),
    groupVarsPath: join(ansible, "group_vars", "a11y_workers.yml"),
  });
});

// The commands themselves, not only their resolvers: each refusal must reach the operator as a message and a non-zero exit,
// and `doctor` must refuse BEFORE it probes anything (this run reaches no worker: the refusal is the first step).
function refusal(script: string, args: string[]) {
  try {
    execFileSync(process.execPath, [join(here, script), ...args], { encoding: "utf8", stdio: "pipe", timeout: 60_000 });
  } catch (error) {
    const { status, stderr } = error as { status: number; stderr: string };
    return { status, stderr };
  }
  return assert.fail(`${script} ${args.join(" ")} was not refused`);
}

test("the commands refuse a missing path with exit 2, naming it and the flag", () => {
  const { root } = layouts();
  const missing = join(root, "typo");
  const doctor = refusal("doctor.mjs", [`--runs-dir=${missing}`]);
  const compare = refusal("compare-workers.mjs", ["--runs-dir=", "http://127.0.0.1:1", "http://127.0.0.1:2", "http://127.0.0.1:3"]);
  const fleetEnv = refusal("fleet-env.mjs", [`--inventory=${missing}.yml`, "--list"]);
  for (const { status } of [doctor, compare, fleetEnv]) assert.equal(status, 2);
  assert.match(doctor.stderr, new RegExp(`--runs-dir=${missing}`));
  assert.match(compare.stderr, /--runs-dir= is empty/);
  assert.match(fleetEnv.stderr, new RegExp(`${missing}\\.yml does not exist[^]*--inventory=<file>`));
});
