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

import { fleetScriptPaths as scriptPaths } from "./fleet-scripts.mjs";

/**
 * The provisioning and lifecycle scripts, as absolute paths.
 *
 * They are shell and PowerShell, not JavaScript, so a consumer has to spawn them — and they can only be found
 * relative to the module. Delegated to `fleet-scripts.mjs` so this package has exactly ONE definition of where
 * they live: it had four, and one of them was wrong, which broke `leaseWorker` silently.
 */
export function fleetScriptPaths(): Record<string, string> {
  return scriptPaths();
}

