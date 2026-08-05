/**
 * Host-side worker fleet: lease a Windows capture worker, judge its health, and know how many the host can
 * actually afford to run.
 *
 * None of this touches guidepup or NVDA — it runs on the machine that *drives* the workers, which is why it is
 * a separate package from `@a11y-witness/nvda-worker` (ADR 0004). The split is not cosmetic: the worker is
 * Windows-only and the fleet is not.
 *
 * The measurement internals — `host-metrics`, `worker-stats`, `fleet-consistency` — are deliberately NOT
 * exported. Their shapes change every time something new gets measured, and this project's own history is a
 * record of that happening.
 */
export {
  DEFAULT_WORKER, isAfterRun, leaseWorker, leaseWorkerPool, hostAddressForWorker, guestReachableUrl,
} from "./local-vm.js";
export type { AfterRun, WorkerLease, PoolLease } from "./local-vm.js";

import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * The provisioning and lifecycle scripts, as absolute paths.
 *
 * They are shell and PowerShell, not JavaScript, so a consumer has to spawn them — and they can only be found
 * relative to THIS module. The same resolve-from-`import.meta.url` pattern as `@a11y-witness/scorer`, for the
 * same reason: a cwd-relative path is correct exactly when the cwd happens to be the repo root.
 */
export function fleetScriptPaths(): Record<string, string> {
  // `../src/local-worker/`, not `./local-worker/`. The assets are shell, PowerShell and XML, so tsc does not
  // copy them into `dist` — they ship from `src`. This resolves correctly from BOTH `src/index.ts` under tsx and
  // `dist/index.js` when installed, because `src` and `dist` are siblings one level below the package root.
  // Getting it wrong is not subtle: the isolation gate failed with `dist/local-worker/` missing.
  const dir = fileURLToPath(new URL("../src/local-worker/", import.meta.url));
  return {
    dir,
    workerCtl: join(dir, "worker-ctl.sh"),
    buildVm: join(dir, "build-vm.sh"),
    cloneWorker: join(dir, "clone-worker.sh"),
    createUtmVm: join(dir, "create-utm-vm.sh"),
    fetchWindowsIso: join(dir, "fetch-windows-iso.sh"),
  };
}
