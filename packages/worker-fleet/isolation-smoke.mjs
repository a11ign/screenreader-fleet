// Run by `scripts/isolation-gate.mjs` from a throwaway directory OUTSIDE this repository, against the
// installed tarball.
//
// It cannot start a VM — that needs UTM, a built Windows guest and ~8 GB. What it CAN prove is the thing that
// actually broke during this extraction: that the provisioning scripts are IN the tarball and are found
// relative to the MODULE. `doctor.mjs` resolved them as `../scripts/local-worker/...`, which was right while it
// lived in `scripts/` and silently wrong afterwards — it then reported "no local VM tooling here" on a host
// with three registered VMs, which reads as a broken environment rather than a broken path.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { chdir } from "node:process";

import { leaseWorker, leaseWorkerPool, isAfterRun, DEFAULT_WORKER, fleetScriptPaths } from "@a11y-witness/worker-fleet";
import { assessWorker } from "@a11y-witness/worker-fleet/health";
import { availableHostMemoryMb, workersHostCanRun } from "@a11y-witness/worker-fleet/capacity";

for (const [name, value] of Object.entries({ leaseWorker, leaseWorkerPool, isAfterRun, fleetScriptPaths, assessWorker, availableHostMemoryMb, workersHostCanRun })) {
  assert.equal(typeof value, "function", `${name} should be callable`);
}
assert.match(DEFAULT_WORKER, /^https?:\/\//, `DEFAULT_WORKER should be a URL, got ${DEFAULT_WORKER}`);
assert.equal(isAfterRun("stop"), true);
assert.equal(isAfterRun("nonsense"), false, "isAfterRun must reject as well as accept");

// Resolve from a different cwd than the one we started in, because that is the failure mode.
chdir("/");
const scripts = fleetScriptPaths();
for (const [name, path] of Object.entries(scripts)) {
  assert.ok(isAbsolute(path), `${name} must be absolute, got ${path}`);
  assert.ok(existsSync(path), `${name} is missing from the tarball: ${path}`);
}

// `.sh` files are exactly the payload a `files` allow-list drops, and a shipped-but-not-executable script
// fails in a confusing way — the caller sees EACCES, not "we forgot the mode bit".
assert.ok(statSync(scripts.workerCtl).mode & 0o111, "worker-ctl.sh shipped without an executable bit");

// The capacity read is real, and macOS-specific by design: the fleet drives UTM. It must never be `os.freemem()`
// — that reported 402 MB on a host with ~12 GB to give, because macOS counts compressed and inactive pages as
// used, and a cap built on it would refuse to start any worker at all.
const availableMb = availableHostMemoryMb();
assert.equal(typeof availableMb, "number");
assert.ok(availableMb > 0, `expected a positive memory reading, got ${availableMb}`);

console.log(`@a11y-witness/worker-fleet works when installed: ${Object.keys(scripts).length - 1} provisioning `
  + `scripts present, ${availableMb} MB readable`);
