import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// THE TWO FLEET PROGRAMS THE CORE RUNS ARE IN THE TARBALL (a11ign/a11ign#5081, ADR 0045 cut 3 of 9).
//
// The core ran `guest-run` and `normalise-fleet` from this package's SOURCE, because the published package did not carry them. ADR 0045
// says a repository uses another only through what it publishes, so they are `bin` commands now, and what makes that true is three
// facts a reader cannot see from the manifest alone: the built files are in the packed list, the `.cmd` the normaliser sends to each
// guest is in it (`src/guest`, not JavaScript so the build does not copy it), and the BUILT `normalise-fleet` finds both from `dist`.
//
// The pack is read with `npm pack --dry-run --json`, which is what `npm publish` would send and which `files` decides. `--ignore-scripts`
// because `prepack` is `rslib build`, and the build is made here, once, only when `dist` lacks the two bins: CI has built already
// (`built-package.test.ts` relies on that), so a rebuild there would rewrite `dist` under the other files that read it.

const packageDir = resolve(import.meta.dirname, "..");
const distDir = join(packageDir, "dist");
const GUEST_CMD = "src/guest/normalise-fleet.cmd";
const BUILT_BINS = { "a11ign-guest-run": "./dist/guest-run.mjs", "a11ign-normalise-fleet": "./dist/normalise-fleet.mjs" };
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin: Record<string, string>; files: string[] };

function ensureBuilt(): void {
  if (existsSync(join(distDir, "guest-run.mjs")) && existsSync(join(distDir, "normalise-fleet.mjs"))) return;
  execFileSync("pnpm", ["run", "build"], { cwd: packageDir, stdio: "pipe" });
}

function packedFiles(dir: string): string[] {
  ensureBuilt();
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return pack!.files.map((file) => file.path);
}

// A copy of the package with `files` as given, so the pack can be read for a manifest this checkout does not have. Copying `dist`, `src`
// and the two root files is everything `files` can name, which is why the unmodified copy below must still hold the `.cmd`: otherwise the
// negative control would pass because the COPY lost it.
function packedFilesWith(files: string[]): string[] {
  ensureBuilt();
  const dir = mkdtempSync(join(tmpdir(), "bins-published-"));
  try {
    for (const name of ["dist", "src", "README.md", "LICENSE"]) cpSync(join(packageDir, name), join(dir, name), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")), files }));
    return packedFiles(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the manifest names both programs as bins, built from `dist`", () => {
  for (const [name, target] of Object.entries(BUILT_BINS)) assert.equal(manifest.bin[name], target, `\`bin\` names ${name}`);
  assert.ok(manifest.files.includes("src/guest"), "`files` ships the guest script the normaliser sends to each guest");
});

test("the packed file list holds both built bins and the guest script (positive control)", () => {
  const packed = packedFiles(packageDir);
  assert.ok(packed.length > 10, "the list is not empty, so the membership checks below assert something");
  assert.ok(packed.includes("dist/guest-run.mjs"), "dist/guest-run.mjs is packed");
  assert.ok(packed.includes("dist/normalise-fleet.mjs"), "dist/normalise-fleet.mjs is packed");
  assert.ok(packed.includes(GUEST_CMD), `${GUEST_CMD} is packed`);
  for (const target of Object.values(manifest.bin)) assert.ok(packed.includes(target.replace(/^\.\//, "")), `${target} is packed`);
});

test("with `src/guest` out of `files` the guest script is not packed (negative control)", () => {
  const unmodified = packedFilesWith(manifest.files);
  assert.ok(unmodified.includes(GUEST_CMD), "the copy, unmodified, still packs the script: the control below is not the copy losing it");
  const without = packedFilesWith(manifest.files.filter((entry) => entry !== "src/guest"));
  assert.ok(!without.includes(GUEST_CMD), "the script is gone, so the check above is the one `files` decides");
  assert.ok(without.includes("dist/guest-run.mjs"), "and nothing else went with it");
});

test("the BUILT normalise-fleet finds the guest script and guest-run from `dist`, and the source one from `src`", async () => {
  ensureBuilt();
  const built = (await import(/* webpackIgnore: true */ pathToFileURL(join(distDir, "normalise-fleet.mjs")).href)).guestPaths();
  assert.ok(existsSync(built.script) && existsSync(built.guestRun), "both built paths exist");
  assert.equal(relative(packageDir, built.script), join("src", "guest", "normalise-fleet.cmd"));
  assert.equal(relative(packageDir, built.guestRun), join("dist", "guest-run.mjs"), "a built sibling, not a `.ts` the tarball does not hold");

  const { guestPaths } = await import("./normalise-fleet.ts");
  const source = guestPaths();
  assert.equal(relative(packageDir, source.script), join("src", "guest", "normalise-fleet.cmd"));
  assert.equal(relative(packageDir, source.guestRun), join("src", "guest-run.ts"), "`node src/normalise-fleet.ts` still runs the source sibling");
});

test("`a11ign-guest-run` reached through a symlink, as npm installs a bin, runs rather than loading and exiting 0", () => {
  ensureBuilt();
  const dir = mkdtempSync(join(tmpdir(), "bins-published-link-"));
  try {
    const link = join(dir, "a11ign-guest-run");
    symlinkSync(join(distDir, "guest-run.mjs"), link);
    // No arguments is the program's own usage refusal (exit 2): a command that did not run would exit 0 and say nothing.
    const direct = spawnSync(process.execPath, [join(distDir, "guest-run.mjs")], { encoding: "utf8" });
    const linked = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.equal(direct.status, 2, "positive control: the real path runs main and refuses the missing arguments");
    assert.equal(linked.status, 2, `the symlink runs main too (stderr: ${linked.stderr})`);
    assert.match(linked.stderr, /usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
