/**
 * Where the fleet's shell, PowerShell and XML assets live — ONE definition.
 *
 * `worker-ctl.sh` was resolved independently in four modules: `local-vm.ts`, `doctor.mjs`,
 * `deploy-worker.mjs` and `check-worker-code.mjs`. Three of them agreed and the fourth did not —
 * `local-vm.ts` said `../../scripts/local-worker/…`, which after M6 pointed at `packages/scripts/…`, a
 * directory that does not exist. So `leaseWorker`, the primary export of this package, could not find the
 * script it drives.
 *
 * It went unnoticed because every check that exercised a lease set `A11Y_WORKER`, which short-circuits VM
 * discovery — so the DEFAULT path, the one CLAUDE.md documents as "with no A11Y_WORKER set the run finds the
 * local VM", was the one path never run. Four copies of a fact is three chances to be wrong about it.
 *
 * `.mjs` rather than `.ts` on purpose: the fleet's own scripts are `.mjs` and are run directly with
 * `node packages/worker-fleet/src/doctor.mjs`, with nothing compiled first, so they can only import `.mjs`
 * siblings.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * `../src/local-worker/`, NOT `./local-worker/`. These assets are not JavaScript, so tsc does not copy them
 * into `dist` — they ship from `src`. Resolving via the package root works from `src/…` under tsx and from
 * `dist/…` when installed, because the two are siblings one level below it. Getting this wrong is not subtle:
 * the isolation gate failed with `dist/local-worker/` missing.
 */
const assetDir = () => fileURLToPath(new URL("../src/local-worker/", import.meta.url));

/** Absolute paths to the provisioning and lifecycle scripts. Absolute, because a consumer spawns them. */
export function fleetScriptPaths() {
  const dir = assetDir();
  return {
    dir,
    workerCtl: join(dir, "worker-ctl.sh"),
    buildVm: join(dir, "build-vm.sh"),
    cloneWorker: join(dir, "clone-worker.sh"),
    createUtmVm: join(dir, "create-utm-vm.sh"),
    fetchWindowsIso: join(dir, "fetch-windows-iso.sh"),
    provisioning: fileURLToPath(new URL("../src/provisioning/", import.meta.url)),
  };
}
