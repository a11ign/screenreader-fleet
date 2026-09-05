/**
 * On-demand lifecycle for the local UTM worker VM.
 *
 * A Windows guest is never really idle -- Defender, Update and the search indexer keep it
 * busy -- so leaving one running between captures costs the host real CPU. Cold start is
 * cheap enough (12-15s to /health, measured) that starting it per run and shutting it down
 * afterwards is the better trade.
 *
 * The default is to LEAVE THE VM AS FOUND, which needs no configuration to do the right
 * thing: a VM that was stopped gets stopped again, a paused one gets re-paused, and one you
 * had already started yourself is left alone. That last case matters -- a run must never
 * shut down a VM somebody else is using.
 *
 * Everything UTM-specific lives in `local-worker/worker-ctl.sh` in this package (`json` emits the
 * state this module reads). Nothing here knows about utmctl, bundles or bookmarks.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";
import { availableHostMemoryMb, capacityReason, workersHostCanRun } from "./host-capacity.mjs";
import { fleetScriptPaths } from "./fleet-scripts.mjs";
import { inventoryWorkerUrls } from "./fleet-env.mjs";

const execFileAsync = promisify(execFile);

/** Where a hand-started worker on this machine has always lived. */
export const DEFAULT_WORKER = "http://localhost:8765";

// Relative to this module, not the process cwd: `npm run` happens to start in the repo
// root, but a direct `tsx src/cli.ts` from elsewhere would not.
const CTL = fleetScriptPaths().workerCtl;

const STATUS_TIMEOUT_MS = 30_000;
// Generous on purpose: `up` boots Windows, waits for auto-logon and then polls /health,
// and worker-ctl gives that 180s of its own before giving up.
const LIFECYCLE_TIMEOUT_MS = 300_000;

/** What to do with the VM once the run finishes. */
export type AfterRun = "restore" | "stop" | "pause" | "leave";

const AFTER_RUN_VALUES: AfterRun[] = ["restore", "stop", "pause", "leave"];

export function isAfterRun(v: string): v is AfterRun {
  return (AFTER_RUN_VALUES as string[]).includes(v);
}

interface VmStatus {
  uuid: string;
  name: string;
  /** utmctl's own vocabulary: "started" | "paused" | "stopped" | "unknown". */
  state: string;
  ip: string;
  port: number;
  healthy: boolean;
  /** True while a capture is in flight -- the worker's own flag. */
  busy: boolean;
}

/** A worker to capture against, and the cleanup that matches how it was obtained. */
export interface WorkerLease {
  worker: string;
  /** How `worker` was chosen, so callers can tailor their own error messages. */
  source: "explicit" | "inventory.yml" | "local-vm" | "default";
  /**
   * The address the GUEST can use to reach THIS host, when capturing via a local VM.
   * Undefined otherwise. Needed because anything the host serves on `localhost` is
   * unreachable from the guest -- `localhost` there means the guest itself.
   */
  hostAddress?: string;
  /** Never throws: a cleanup failure must not mask the run's own result. */
  release: () => Promise<void>;
}

const IPV4_OCTETS = 4;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== IPV4_OCTETS || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts.reduce((acc, octet) => acc * 256 + octet, 0);
}

/**
 * This host's address on the same subnet as the guest -- the gateway end of UTM's shared
 * network (bridge100 on macOS). Derived by matching interfaces against the guest's address
 * rather than assuming the usual `x.y.z.1`, because guessing an address that silently does
 * not answer is worse than reporting that we could not find one.
 */
function hostAddressFor(guestIp: string): string | undefined {
  const guest = ipv4ToInt(guestIp);
  if (guest === null) return undefined;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const host = ipv4ToInt(a.address);
      const mask = ipv4ToInt(a.netmask);
      if (host === null || mask === null) continue;
      // Both sides go through the same int32 coercion, so addresses above 2^31 comparing
      // as negative is harmless here.
      if ((host & mask) === (guest & mask)) return a.address;
    }
  }
  return undefined;
}

async function ctl(args: string[], timeoutMs: number, vmName?: string): Promise<string> {
  const env = vmName ? { ...process.env, A11Y_VM_NAME: vmName } : process.env;
  const { stdout } = await execFileAsync(CTL, args, { timeout: timeoutMs, encoding: "utf8", env });
  return stdout;
}

/**
 * The registered local VM, or null when there is nothing to manage: not macOS, no UTM, no
 * VM registered under that name, or duplicate registrations (worker-ctl refuses to guess
 * between those rather than risk acting on the wrong one).
 */
export async function findLocalVm(): Promise<VmStatus | null> {
  if (process.platform !== "darwin") return null;
  try {
    return JSON.parse(await ctl(["json"], STATUS_TIMEOUT_MS)) as VmStatus;
  } catch (e) {
    // Absence is the normal case for anyone without a local VM, so this is a debug
    // breadcrumb rather than a warning -- but never a silent catch.
    if (process.env.A11Y_DEBUG_VM) {
      process.stderr.write(`local VM lookup failed (continuing without one): ${(e as Error).message}\n`);
    }
    return null;
  }
}

/** Which lifecycle action returns the VM to `stateBefore`. */
function restoreAction(stateBefore: string): AfterRun {
  if (stateBefore === "started") return "leave";
  if (stateBefore === "paused") return "pause";
  return "stop";
}

async function releaseVm(action: AfterRun, stateBefore: string): Promise<void> {
  const resolved = action === "restore" ? restoreAction(stateBefore) : action;
  if (resolved === "leave") return;
  // Another run may have started a capture while ours was finishing. Shutting the guest
  // down underneath it would look exactly like a worker crash, so stand down instead.
  const now = await findLocalVm();
  if (now?.busy) {
    process.stderr.write(`worker is busy with another capture; leaving the VM ${now.state}\n`);
    return;
  }
  process.stderr.write(`${resolved === "pause" ? "Pausing" : "Shutting down"} the local worker VM ...\n`);
  await ctl([resolved], LIFECYCLE_TIMEOUT_MS);
}

/**
 * Start (or resume) the local VM, returning its worker URL and the matching cleanup.
 * Throws if the VM never becomes healthy -- there is no point judging a capture that could
 * not happen.
 */
export async function acquireLocalWorker(vm: VmStatus, after: AfterRun): Promise<WorkerLease> {
  const stateBefore = vm.state;
  if (stateBefore === "started" && vm.healthy) {
    process.stderr.write(`Using the running local worker VM '${vm.name}' at ${vm.ip}\n`);
  } else {
    process.stderr.write(`Local worker VM '${vm.name}' is ${stateBefore}; bringing it up ...\n`);
    process.stderr.write(await ctl(["up"], LIFECYCLE_TIMEOUT_MS));
  }

  const ready = await findLocalVm();
  if (!ready?.healthy || !ready.ip) {
    throw new Error(
      `Local worker VM '${vm.name}' did not become healthy. Check it directly: ${CTL} status`
    );
  }

  return {
    worker: `http://${ready.ip}:${ready.port}`,
    source: "local-vm",
    hostAddress: hostAddressFor(ready.ip),
    release: () =>
      releaseVm(after, stateBefore).catch((e: Error) => {
        // Report and move on. The run's verdict is the product; a VM left running is a
        // resource leak the user can fix with one command, not a reason to fail the run.
        process.stderr.write(`WARNING: could not release the local worker VM: ${e.message}\n`);
      }),
  };
}

interface LeaseRequest {
  /** A worker the caller was given explicitly (--worker / A11Y_WORKER), or null. */
  worker: string | null;
  after: AfterRun;
}

/**
 * Decide what to capture against, in priority order:
 *
 *   1. A worker the caller named is used as-is. Naming one is a statement that you are
 *      managing it yourself, so the VM lifecycle is never touched.
 *   2. Otherwise, `inventory.yml`'s bare-metal fleet — always-on boxes, so there is no VM
 *      lifecycle to run: the first declared worker is leased with a no-op release.
 *   3. Otherwise, a registered local UTM VM is started on demand and released afterwards.
 *   4. Otherwise, the historical default, so a hand-run worker on this machine still works.
 *
 * FOUND 2026-09-06 (`docs/backlog.md` §8): this used to go straight from (1) to (3), never
 * reading the inventory at all -- so a checkout WITH a bare-metal fleet declared and a UTM guest
 * still registered (the ordinary state of a Mac that used to run the deprecated pool) leased the
 * VM by default, exactly the wrong turn CLAUDE.md already records costing a capture-path change:
 * "a deprecated path that is still the first one documented is not deprecated". `resolveWorkerPool`
 * (`fleet-env.mjs`) already had the corrected order for the POOL case; this brings the single-worker
 * case into line, and `worker-precedence.test.ts` is what is supposed to keep them there.
 *
 * Step 2 costs nothing and throws nothing for anyone without an `inventory.yml` -- a public
 * consumer who installs this package -- because `inventoryWorkerUrls()` already treats an absent
 * or unparsable file as "no fleet declared here" and returns `[]`. So the fall-through to (3) and
 * (4) is byte-for-byte what it was before this change for that consumer; only a checkout that
 * DECLARES a fleet sees new behaviour, and it sees the behaviour `doctor` and `worker:code`
 * already assumed it had.
 *
 * A11Y_LOCAL_VM=0 skips step 3 for anyone who wants the pre-inventory local-VM behaviour back --
 * unchanged in what it does, moved because inventory now sits ahead of it.
 *
 * Shared by every entry point that needs a worker, so the priority order cannot drift
 * between them.
 *
 * `deps` is the injection seam: real callers get the real inventory reader and the real (shells
 * out to `utmctl`) VM lookup, and a test supplies fakes for both, so the precedence can be proven
 * without a filesystem `inventory.yml` or a UTM install. Called as `deps.inventory?.() ?? inventoryWorkerUrls()`
 * rather than resolved into a local first — deliberately, so `inventoryWorkerUrls(` and `findLocalVm(`
 * both appear as real CALLS at the exact decision point, which is what lets `worker-precedence.test.ts`
 * read this function's actual order rather than only the shape of its signature.
 */
export async function leaseWorker(
  { worker, after }: LeaseRequest,
  deps: { inventory?: () => string[]; findLocalVm?: () => Promise<VmStatus | null> } = {},
): Promise<WorkerLease> {
  const release = async () => {};
  // Strip a trailing slash once, here, so no caller has to remember that `${worker}/capture`
  // would otherwise produce a double slash.
  if (worker) return { worker: worker.replace(/\/$/, ""), source: "explicit", release };

  const fleet = deps.inventory ? deps.inventory() : inventoryWorkerUrls();
  if (fleet.length) return { worker: fleet[0].replace(/\/$/, ""), source: "inventory.yml", release };

  if (process.env.A11Y_LOCAL_VM === "0") return { worker: DEFAULT_WORKER, source: "default", release };

  const vm = deps.findLocalVm ? await deps.findLocalVm() : await findLocalVm();
  if (!vm) return { worker: DEFAULT_WORKER, source: "default", release };
  return acquireLocalWorker(vm, after);
}

/**
 * Rewrite a base URL the GUEST has to fetch so it points at this host rather than at
 * `localhost`, which from inside the guest means the guest.
 *
 * This is the trap in dataset capture: the pages are served by a plain HTTP server on the
 * Mac, and the default base URL is `http://localhost:5050`. Left alone, every capture
 * loads the guest's own empty port and the transcripts come back describing nothing --
 * with no error, because a connection refused inside Edge is not a worker failure.
 */
/**
 * This host's address as seen from a worker at `workerUrl`, when the two share a subnet.
 * Returns undefined for a hostname, or for a worker somewhere we have no interface onto --
 * in which case the caller must be told where to reach us rather than have it guessed.
 */
export function hostAddressForWorker(workerUrl: string): string | undefined {
  try {
    const { hostname } = new URL(workerUrl);
    return ipv4ToInt(hostname) === null ? undefined : hostAddressFor(hostname);
  } catch {
    return undefined;
  }
}

export function guestReachableUrl(baseUrl: string, lease: WorkerLease): string {
  // Fall back to deriving it from the worker's own address.
  //
  // hostAddress used to be set only on the managed-VM path, so naming a worker explicitly --
  // A11Y_WORKER, or any pool -- silently skipped the rewrite and every capture fetched the
  // GUEST's localhost. Edge shows "localhost refused to connect", the title check rejects the
  // capture, and three attempts are burned per page before it gives up. The worker being
  // remote or explicit does not change the fact that it cannot reach our localhost.
  const hostAddress = lease.hostAddress ?? hostAddressForWorker(lease.worker);
  if (!hostAddress) return baseUrl;
  const parsed = new URL(baseUrl);
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return baseUrl;
  parsed.hostname = hostAddress;
  return parsed.toString().replace(/\/$/, "");
}

/** Several workers, and the cleanup that puts every one of them back as it was found. */
export interface PoolLease {
  workers: string[];
  hostAddress?: string;
  release: () => Promise<void>;
}

/** Every local worker VM, whatever state each is in. */
async function findLocalPool(): Promise<VmStatus[]> {
  if (process.platform !== "darwin") return [];
  try {
    return JSON.parse(await ctl(["pool"], STATUS_TIMEOUT_MS)) as VmStatus[];
  } catch {
    return [];
  }
}

/** A11Y_MAX_WORKERS wins over the measurement: the operator may know something we cannot measure. */
function configuredWorkerLimit(): number | null {
  const configured = Number(process.env.A11Y_MAX_WORKERS);
  return Number.isFinite(configured) && configured > 0 ? configured : null;
}

/**
 * Which registered VMs should actually be running for this run?
 *
 * The pool used to start all of them. Three guests on a 36 GB host made every capture 1.6x slower
 * than one, and caused mute-NVDA failures, because the guests were swapped out from under NVDA — so
 * "how many VMs exist" was the wrong question and "how much memory is there" is the right one.
 *
 * Already-running VMs are preferred over stopped ones: starting a guest in order to leave a running
 * one idle is pure churn. Note that a VM someone else has already started is never stopped here — it
 * is simply not used — because a run must not shut down a worker it did not start.
 */
function chooseRunnableWorkers(pool: VmStatus[]): { chosen: VmStatus[]; note: string | null } {
  const availableMb = availableHostMemoryMb();
  const running = pool.filter((vm) => vm.state === "started");
  const limit = configuredWorkerLimit()
    ?? workersHostCanRun({ availableMb, alreadyRunning: running.length });
  if (limit >= pool.length) return { chosen: pool, note: null };
  const chosen = [...running, ...pool.filter((vm) => vm.state !== "started")].slice(0, limit);
  return { chosen, note: capacityReason({ limit, wanted: pool.length, availableMb }) };
}

/**
 * Lease every local worker VM: start what is not running, and put each one back afterwards.
 *
 * This exists because the pool path used to hand back a no-op release, so a pooled run left
 * every VM running indefinitely — which is precisely the cost the single-worker lease was
 * written to avoid, reintroduced the moment pooling became the normal way to run.
 *
 * Per-VM restore, not a blanket stop: a VM you had already started stays started, exactly as
 * in the single-worker case. A long dataset run must not shut down a worker somebody else is
 * using, and with a pool that is likelier, not less.
 */
export async function leaseWorkerPool(after: AfterRun): Promise<PoolLease | null> {
  const pool = await findLocalPool();
  if (pool.length < 2) return null; // one VM is the single-worker path's job

  const { chosen, note } = chooseRunnableWorkers(pool);
  if (note) process.stderr.write(note + "\n");
  const chosenNames = new Set(chosen.map((vm) => vm.name));

  const before = new Map(pool.map((vm) => [vm.name, vm.state]));
  for (const vm of chosen) {
    if (vm.state === "started" && vm.healthy) continue;
    process.stderr.write(`Local worker '${vm.name}' is ${vm.state}; bringing it up ...\n`);
    try {
      await ctl(["up"], LIFECYCLE_TIMEOUT_MS, vm.name);
    } catch (error) {
      // One sick VM must not cancel the run. This threw and killed a resume outright while two other
      // workers sat ready: a guest wedged in "stopping" failed `up`, the exception escaped the lease,
      // and 1,000 cases went nowhere. Bringing up a pool is best-effort per member -- the readiness
      // filter below is what decides who actually takes work, and it already fails loudly if nobody
      // does.
      process.stderr.write(
        `Local worker '${vm.name}' would not come up (${(error as Error).message.split("\n")[0]}); ` +
        "continuing without it\n",
      );
    }
  }

  // Only workers we CHOSE, even if a VM we declined is up and healthy: taking work to a guest the
  // capacity check excluded would defeat the check, and it may belong to somebody else's run.
  const ready = (await findLocalPool()).filter((vm) => vm.healthy && vm.ip && chosenNames.has(vm.name));
  if (!ready.length) throw new Error("no local worker became healthy; check: worker-ctl.sh pool");
  const missing = chosen.length - ready.length;
  if (missing > 0) {
    // Never silent: a run that quietly used two of three workers looks like an unexplained slowdown.
    process.stderr.write(`${missing} of ${chosen.length} local workers are unavailable; running on the rest\n`);
  }
  process.stderr.write(`Pool of ${ready.length}: ${ready.map((v) => v.name).join(", ")}\n`);

  return {
    workers: ready.map((vm) => `http://${vm.ip}:${vm.port}`),
    hostAddress: hostAddressFor(ready[0].ip),
    release: async () => {
      for (const vm of ready) {
        const action = after === "restore" ? restoreAction(before.get(vm.name) ?? "stopped") : after;
        if (action === "leave") continue;
        try {
          // Check per VM: another run may have picked this one up while ours was finishing.
          const now = (await findLocalPool()).find((v) => v.name === vm.name);
          if (now?.busy) {
            process.stderr.write(`'${vm.name}' is busy with another capture; leaving it ${now.state}\n`);
            continue;
          }
          process.stderr.write(`${action === "pause" ? "Pausing" : "Shutting down"} '${vm.name}' ...\n`);
          await ctl([action], LIFECYCLE_TIMEOUT_MS, vm.name);
        } catch (e) {
          // One VM failing to stop must not strand the others.
          process.stderr.write(`WARNING: could not ${action} '${vm.name}': ${(e as Error).message}\n`);
        }
      }
    },
  };
}
