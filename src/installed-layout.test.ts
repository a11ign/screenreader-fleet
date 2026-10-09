import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { checkControlPlaneIsolation, checkCrossPackageDist, checkJudge, checkPrimaryCheckoutMark, recordedChecks,
  runsDirFor } from "./doctor.ts";
import { outDirFor } from "./compare-workers.ts";
import { inventoryPathsFor } from "./fleet-env.ts";
import { TSX_ARGS } from "./tsx-import.ts";

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
    execFileSync(process.execPath, [...TSX_ARGS, join(here, script), ...args], { encoding: "utf8", stdio: "pipe", timeout: 60_000 });
  } catch (error) {
    const { status, stderr } = error as { status: number; stderr: string };
    return { status, stderr };
  }
  return assert.fail(`${script} ${args.join(" ")} was not refused`);
}

test("the commands refuse a missing path with exit 2, naming it and the flag", () => {
  const { root } = layouts();
  const missing = join(root, "typo");
  const doctor = refusal("doctor.ts", [`--runs-dir=${missing}`]);
  const compare = refusal("compare-workers.ts", ["--runs-dir=", "http://127.0.0.1:1", "http://127.0.0.1:2", "http://127.0.0.1:3"]);
  const fleetEnv = refusal("fleet-env.ts", [`--inventory=${missing}.yml`, "--list"]);
  for (const { status } of [doctor, compare, fleetEnv]) assert.equal(status, 2);
  assert.match(doctor.stderr, new RegExp(`--runs-dir=${missing}`));
  assert.match(compare.stderr, /--runs-dir= is empty/);
  assert.match(fleetEnv.stderr, new RegExp(`${missing}\\.yml does not exist[^]*--inventory=<file>`));
});

// ---- the four checks that still resolved a monorepo layout from the module's own location (a11ign/a11ign#3784) ----
//
// `checkPrimaryCheckoutMark`, `checkControlPlaneIsolation` and `checkCrossPackageDist` read `../../../` as the repo root, and
// `checkJudge` read `../../scorer/`. Installed, the first three reported on `node_modules` as though it were the machine's
// checkout, and the judge check said "missing" or "present" by where a package manager happened to put the scorer. Per check:
// (a) outside a checkout it does not read `node_modules` as one, (b) inside a checkout nothing changes, and for the judge
// (c) the weights path is the one `@a11ign/scorer` itself reports.
type RecordedCheck = { id: string; ok: boolean; advisory?: boolean; detail: string; fix: string | null };

async function recorded(run: () => unknown): Promise<RecordedCheck[]> {
  const before = recordedChecks().length;
  await run();
  return recordedChecks().slice(before) as RecordedCheck[];
}

async function withEnv<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function assertNotACheckout(found: RecordedCheck[], ids: string[], nodeModules: string) {
  assert.deepEqual(found.map((check) => check.id), ids);
  for (const check of found) {
    assert.equal(check.advisory, true, `${check.id}: n/a is an advisory, never a verdict`);
    assert.equal(check.ok, true, `${check.id}: it must not turn NOT READY from a path it should not have read`);
    assert.ok(check.detail.startsWith("n/a: installed package"), `${check.id}: ${check.detail}`);
    assert.ok(check.detail.includes(nodeModules), `${check.id} names the directory it declined to read: ${check.detail}`);
  }
}

test("primary checkout, isolation and dist checks: outside a checkout they say n/a and name the directory", async () => {
  const { installed } = layouts();
  const nodeModules = resolve(installed, "..", "..", "..");
  assertNotACheckout(await recorded(() => checkPrimaryCheckoutMark({ baseDir: installed })), ["primary checkout"], nodeModules);
  assertNotACheckout(await recorded(() => checkControlPlaneIsolation({ baseDir: installed })), ["isolation"], nodeModules);
  assertNotACheckout(await recorded(() => checkCrossPackageDist({ baseDir: installed })), ["dist-resolution", "dist-freshness"], nodeModules);
});

test("primary checkout, isolation and dist checks: inside a checkout they read it as before", async () => {
  const { monorepo, monorepoBase } = layouts();
  writeFileSync(join(monorepo, ".git"), "gitdir: /elsewhere\n");
  const [primary] = await recorded(() => checkPrimaryCheckoutMark({ baseDir: monorepoBase }));
  assert.ok(primary.ok && primary.detail.includes("a linked worktree"), primary.detail);
  const [isolation] = await withEnv("A11Y_SSH_KEY", join(monorepo, "no-such-key"),
    () => recorded(() => checkControlPlaneIsolation({ baseDir: monorepoBase })));
  assert.equal(isolation.id, "isolation");
  assert.ok(!isolation.detail.startsWith("n/a"), isolation.detail);
  const [resolution] = await recorded(() => checkCrossPackageDist({ baseDir: monorepoBase }));
  assert.equal(resolution.id, "dist-resolution");
  assert.ok(resolution.detail.includes("NOT this checkout"), `the judge resolves outside the stand-in checkout: ${resolution.detail}`);
});

/** A package in `<dir>` that `require.resolve`s to `dist/index.js`. */
function writePackage(dir: string, name: string, indexSource = "export {};\n") {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports: { ".": { default: "./dist/index.js" } } }));
  writeFileSync(join(dir, "dist", "index.js"), indexSource);
}

/** `@a11ign/scorer`'s own answer: weights under ITS root, which is where the real package computes them. */
const SCORER_SOURCE = 'import { join } from "node:path";\nimport { fileURLToPath } from "node:url";\n'
  + 'export const scorerPaths = () => ({ weights: join(fileURLToPath(new URL("../", import.meta.url)), "models/screenreader-scorer/model.safetensors") });\n';

function writeWeights(scorerDir: string) {
  mkdirSync(join(scorerDir, "models", "screenreader-scorer"), { recursive: true });
  writeFileSync(join(scorerDir, "models", "screenreader-scorer", "model.safetensors"), "weights");
}

/**
 * The pnpm layout: judge and scorer are SIBLINGS in the store, and the consumer sees only a symlink to the judge. So
 * `<consumer>/node_modules/@a11ign/scorer` does not exist, which is what `../../scorer/` from `dist/` read.
 */
function pnpmLayout({ withScorer = true, withWeights = true } = {}) {
  const { root } = layouts();
  const store = join(root, "store", "node_modules", "@a11ign");
  const scorerDir = join(store, "scorer");
  writePackage(join(store, "judge"), "@a11ign/judge");
  if (withScorer) writePackage(scorerDir, "@a11ign/scorer", SCORER_SOURCE);
  if (withScorer && withWeights) writeWeights(scorerDir);
  const consumer = join(root, "consumer", "node_modules", "@a11ign");
  mkdirSync(consumer, { recursive: true });
  symlinkSync(join(store, "judge"), join(consumer, "judge"), "dir");
  return { from: join(consumer, "screenreader-fleet", "dist", "doctor.mjs"), scorerDir };
}

/** The workspace layout: `packages/judge` reaches `packages/scorer` through its own `node_modules`. */
function workspaceLayout() {
  const { monorepo } = layouts();
  const packages = join(monorepo, "packages");
  writePackage(join(packages, "judge"), "@a11ign/judge");
  writePackage(join(packages, "scorer"), "@a11ign/scorer", SCORER_SOURCE);
  writeWeights(join(packages, "scorer"));
  mkdirSync(join(packages, "judge", "node_modules", "@a11ign"), { recursive: true });
  symlinkSync(join(packages, "scorer"), join(packages, "judge", "node_modules", "@a11ign", "scorer"), "dir");
  mkdirSync(join(packages, "worker-fleet", "node_modules", "@a11ign"), { recursive: true });
  symlinkSync(join(packages, "judge"), join(packages, "worker-fleet", "node_modules", "@a11ign", "judge"), "dir");
  return { from: join(packages, "worker-fleet", "src", "doctor.ts"), scorerDir: join(packages, "scorer") };
}

const weightsIn = (scorerDir: string) => join(scorerDir, "models", "screenreader-scorer", "model.safetensors");
const judgeCheck = (from: string) => withEnv("JUDGE_BACKEND", "", async () => (await recorded(() => checkJudge({ from })))[0]);

test("judge: installed, the weights are where @a11ign/scorer says, not beside this package", async () => {
  const { from, scorerDir } = pnpmLayout();
  const check = await judgeCheck(from);
  assert.ok(check.ok, check.detail);
  assert.match(check.detail, /trained scorer present/);
  assert.ok(check.fix?.includes(weightsIn(scorerDir)), `the path it checked is named: ${check.fix}`);
});

test("judge: the scorer is resolved, and its weights missing, names the path the scorer reported", async () => {
  const { from, scorerDir } = pnpmLayout({ withWeights: false });
  const check = await judgeCheck(from);
  assert.equal(check.ok, false);
  assert.match(check.detail, /trained scorer is missing/);
  assert.ok(check.fix?.includes(weightsIn(scorerDir)), `${check.fix}`);
});

/**
 * `checkJudge` in a CHILD process with no `NODE_PATH`: `pnpm exec` sets it to the store's hoisted modules, which hold a real
 * `@a11ign/scorer`, so an in-process run could not tell "unresolvable" from "resolved from somewhere else".
 */
function judgeCheckWithoutNodePath(from: string): RecordedCheck {
  const env: NodeJS.ProcessEnv = { ...process.env, JUDGE_BACKEND: "" };
  delete env.NODE_PATH;
  const program = `const d = await import(${JSON.stringify(pathToFileURL(join(here, "doctor.ts")).href)});`
    + `await d.checkJudge({ from: ${JSON.stringify(from)} }); console.log(JSON.stringify(d.recordedChecks()[0]));`;
  const out = execFileSync(process.execPath, [...TSX_ARGS, "--input-type=module", "-e", program],
    { encoding: "utf8", env, timeout: 60_000 });
  return JSON.parse(out);
}

test("judge: a scorer that cannot be resolved says so, rather than reporting weights missing at a path it guessed", () => {
  const { from } = pnpmLayout({ withScorer: false });
  const check = judgeCheckWithoutNodePath(from);
  assert.equal(check.ok, false, check.detail);
  assert.match(check.detail, /@a11ign\/scorer could not be resolved from @a11ign\/judge/);
  assert.doesNotMatch(check.detail, /trained scorer (is missing|present)/);
});

test("judge: inside a checkout the weights are the workspace scorer's, as before", async () => {
  const { from, scorerDir } = workspaceLayout();
  const check = await judgeCheck(from);
  assert.ok(check.ok, check.detail);
  assert.ok(check.fix?.includes(weightsIn(scorerDir)), `${check.fix}`);
});
