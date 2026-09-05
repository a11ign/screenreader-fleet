/**
 * Every UTM-only entry point must say so before it runs — architecture-audit.md §8: "the deprecated
 * UTM path is still the CLI's default." The repository owner stated plainly on 2026-09-05: "The UTM is
 * deprecated, that was a testing thing." CLAUDE.md's own rule, written after this exact class of mistake
 * cost a wrong turn: "a deprecated path that is still the first one documented is not deprecated" —
 * applied here to runtime silence rather than to a doc, which is the same mistake one layer down.
 *
 * A DISCOVERY test, not a hand-kept list — the reason every discovery test in this repo exists: a new
 * UTM entry point nobody remembered to add here is exactly the one that ships silent. Two populations,
 * discovered two different ways because they are different languages:
 *
 *   - .mjs/.ts files that shell out to `utmctl` DIRECTLY, by the literal command name or the hardcoded
 *     app path (not one that merely mentions UTM in a comment, and not one where UTM is a single branch
 *     of a broader precedence chain it also reports on — `doctor.mjs` and `check-worker-code.mjs` check
 *     the local UTM pool as ONE of several worker sources without committing a caller to using it, so
 *     they are deliberately not required to warn the way a file whose whole job is UTM lifecycle
 *     management is).
 *   - every `.sh` file under `local-worker/`, which is UTM-only BY CONSTRUCTION: the directory holds
 *     nothing else, so a new script placed there inherits the requirement structurally rather than by
 *     someone remembering to list it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const LOCAL_WORKER_DIR = join(SRC, "local-worker");

function directUtmctlCallers(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(SRC, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(mjs|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) continue;
    const src = readFileSync(join(SRC, entry.name), "utf8");
    // The literal command name (deploy-worker.mjs pushes files with it) or the hardcoded app path
    // (guest-run.mjs, normalise-fleet.mjs) — the two real shapes a direct call takes here.
    if (/"utmctl"|UTMCTL\s*=/.test(src)) found.push(entry.name);
  }
  return found.sort();
}

function localWorkerShellScripts(): string[] {
  return readdirSync(LOCAL_WORKER_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sh"))
    .map((entry) => entry.name)
    .sort();
}

test("the discovery finds every known direct utmctl caller, or it is checking nothing", () => {
  const found = directUtmctlCallers();
  assert.ok(found.length >= 3,
    `only found ${found.length} direct utmctl caller(s): ${found.join(", ")} — the discovery is broken, `
    + "not the codebase clean");
});

test("every direct utmctl caller imports and calls warnUtmDeprecated before touching utmctl", () => {
  const unwarned = directUtmctlCallers().filter((name) => {
    const src = readFileSync(join(SRC, name), "utf8");
    return !src.includes("warnUtmDeprecated(");
  });
  assert.deepEqual(unwarned, [],
    `these shell out to utmctl directly but never warn it is deprecated: ${unwarned.join(", ")}`);
});

test("local-vm.ts's UTM fallback warns too, even though it reaches UTM through worker-ctl.sh rather than utmctl directly", () => {
  // Excluded from directUtmctlCallers() on purpose: leaseWorker/leaseWorkerPool never call `utmctl`
  // themselves, only `worker-ctl.sh` (which does) — the exact shape architecture-audit.md §8 named as
  // the CLI's own default. Checked explicitly rather than folded into the discovery above, since a
  // pattern loose enough to match this file's own `worker-ctl.sh` references would also match every
  // OTHER file that merely resolves that path without ever executing it (fleet-scripts.mjs).
  const src = readFileSync(join(SRC, "local-vm.ts"), "utf8");
  assert.match(src, /warnUtmDeprecated\(/,
    "local-vm.ts must warn before falling through to the local UTM VM");
});

test("the discovery finds every shell script under local-worker/, or it is checking nothing", () => {
  const found = localWorkerShellScripts();
  assert.ok(found.length >= 5,
    `only found ${found.length} script(s) under local-worker/: ${found.join(", ")} — the discovery is `
    + "broken, not the codebase clean");
});

test("every shell script under local-worker/ prints a DEPRECATED warning before doing anything", () => {
  const unwarned = localWorkerShellScripts().filter((name) => {
    const src = readFileSync(join(LOCAL_WORKER_DIR, name), "utf8");
    return !src.includes("DEPRECATED:");
  });
  assert.deepEqual(unwarned, [],
    `these scripts never print a deprecation warning: ${unwarned.join(", ")}`);
});
