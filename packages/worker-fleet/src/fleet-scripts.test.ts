/**
 * Every fleet asset must be findable, and findable in exactly ONE way.
 *
 * `worker-ctl.sh` was resolved independently in four modules. Three agreed; `local-vm.ts` said
 * `../../scripts/local-worker/…`, which after M6 pointed at a directory that does not exist — so
 * `leaseWorker`, this package's primary export, could not find the script it drives.
 *
 * Nothing caught it. Every check that leased a worker set `A11Y_WORKER`, which short-circuits VM discovery, so
 * the DEFAULT path — the one documented as "with no A11Y_WORKER set the run finds the local VM" — was the one
 * never exercised. Four copies of a fact is three chances to be wrong about it, and the wrong one was in the
 * path nothing ran.
 *
 * The related rule — that nothing spawns a sibling by a cwd-relative path — is checked repo-wide in
 * `packages/lab/src/packaging/spawned-paths.test.ts`, because the split found three instances of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";

import { fleetScriptPaths } from "./fleet-scripts.mjs";

const here = fileURLToPath(new URL("./", import.meta.url));

test("every fleet asset path is absolute and exists", () => {
  const paths = fleetScriptPaths();
  assert.ok(Object.keys(paths).length >= 5, "the scan is broken; expected several assets");
  for (const [name, path] of Object.entries(paths)) {
    assert.ok(isAbsolute(path), `${name} must be absolute, got ${path}`);
    assert.ok(existsSync(path), `${name} does not exist: ${path}`);
  }
});

test("no module resolves a fleet asset for itself", () => {
  // The regression is a second definition, not a wrong one: a copy that agrees today is a copy that can stop
  // agreeing. Any module needing an asset path asks `fleetScriptPaths()`.
  const offenders = readdirSync(here)
    .filter((f) => (f.endsWith(".mjs") || f.endsWith(".ts")) && f !== "fleet-scripts.mjs" && !f.endsWith(".test.ts"))
    .filter((f) => /new URL\(\s*["'][^"']*local-worker\//.test(readFileSync(join(here, f), "utf8")));
  assert.deepEqual(offenders, [],
    `${offenders.join(", ")} resolve(s) a local-worker asset directly. Use fleetScriptPaths() — this package "
    + "had four such resolutions and one of them was wrong.`);
});
