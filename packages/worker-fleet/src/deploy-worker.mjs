// Deploy the worker's code to the guests, in one command, and prove it landed.
//
//   node scripts/deploy-worker.mjs              # every local worker VM, one at a time
//   node scripts/deploy-worker.mjs --vm=a11y-worker-2
//
// Why this exists: deploying was a documented twelve-step manual dance — push four files with
// `utmctl file push`, stop the VM, start it, then run `worker:code` and hope. Two things about that
// were unacceptable for something we rely on:
//
//  - **It is easy to get wrong, and I got it wrong.** Pushing three of the four files leaves a guest
//    running a mix; the symptom is a `worker:code` mismatch with no clue which file is stale.
//  - **`utmctl exec` cannot be trusted to restart the worker**, so the reboot is mandatory and easy to
//    skip. Skipping it makes the guest serve the previous code while reporting success — which cost two
//    workers an hour of running stale code once already.
//
// So: one command, every hashed file, a real reboot, and a hash check over HTTP afterwards. The hash
// check is the whole point — it shares no failure mode with the push, which is why `/health.code`
// exists rather than reading the guest's files back through the same broken channel.
//
// Deploys the WORKING TREE, deliberately: that is what you are testing. Roll back by checking out the
// ref you want and running this again — git is the source of truth for "the previous version", so there
// is no bespoke backup to go stale.
import { pathToFileURL } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";
// By SUBPATH, never the package ROOT: the index re-exports `capture-core.mjs`, which imports guidepup and
// throws `No available supported screen readers` at import on any host without one. This file only
// runs on a Mac, where VoiceOver makes that throw invisible — which is exactly why it went unnoticed.
// `no-win32-imports.test.ts` found it.
import { WORKER_FILES } from "@a11y-witness/nvda-worker/worker-files";
import { workerSourceDir, codeVersion } from "@a11y-witness/nvda-worker/code-version";
import { fleetScriptPaths } from "./fleet-scripts.mjs";
import { refuseUnknownFlags } from "./cli-flags.mjs";

/**
 * `--allow-protocol-change` is the flag that lets a CAPTURE_PROTOCOL_VERSION bump ship, invalidating
 * 2,122 cached captures. A typo silently means "do not allow", which is the safe direction — but
 * `--vm=` mistyped deploys to EVERY guest instead of the one named.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags(["--vm=", "--allow-protocol-change"], { command: "npm run worker:deploy" });

const run = promisify(execFile);
// From the worker PACKAGE, not from the cwd. This was `resolve("src/capture/nvda")` and then
// `resolve("packages/nvda-worker/src")` — a repo-layout guess that had to be edited every time the worker
// moved, and that silently pointed at nothing whenever the cwd was not the repo root.
const NVDA_DIR = workerSourceDir();
// The guest's layout deliberately does NOT mirror the repo's. It is where provisioning put the files and
// where the scheduled task points, so renaming it means re-provisioning every guest — and M5 moving the host
// directory to `packages/nvda-worker/src` changed nothing here. All the worker needs is that its files land in
// one directory together.
const GUEST_DIR = "C:\\Users\\witness\\a11y-witness\\src\\capture\\nvda";
// Resolved from THIS module: the fleet scripts ship with this package, so a cwd-relative path was only ever
// right when run from the repo root.
const CTL = fleetScriptPaths().workerCtl;
const LIFECYCLE_TIMEOUT_MS = 420_000;
// `pool` launches UTM if it is closed and polls every VM's /health. 90s was too short: it timed out
// mid-deploy while three guests were transitioning, and the whole run died with a bare SIGTERM.
const POOL_TIMEOUT_MS = 240_000;
const HEALTH_TIMEOUT_MS = 20_000;

const only = process.argv.find((a) => a.startsWith("--vm="))?.slice("--vm=".length);

/**
 * The files that make up the worker's code version.
 *
 * Imported from the one module that defines them. This used to parse `check-worker-code.mjs`'s SOURCE with a
 * regex for the same list — better than a third copy, which is what the comment here used to argue, but it
 * still broke silently if that loop were ever rewritten, and "a file missing from the list deploys invisibly"
 * is the failure it was guarding against.
 */
function hashedFiles() {
  return WORKER_FILES;
}

/**
 * The SHARED hasher, not a local copy of it.
 *
 * This used to hash raw bytes while `codeVersion()` normalises CRLF to LF -- and that difference is not
 * cosmetic: a worker whose repo was git-cloned on Windows checks out CRLF, so the two sides hashed
 * different bytes for identical code and the deploy verification reported STALE for ever. Measured on the
 * first bare-metal worker: 31979b551b7a2cfa against a checkout's 22822b7a3a08969c.
 *
 * `code-version.test.ts` claims to enforce "one hasher" but only greps for the file list, so this file
 * satisfied it while keeping its own implementation. Two implementations of a comparison are two chances
 * to disagree, and the whole point of this check is that both sides agree.
 */
function localVersion() {
  return codeVersion(NVDA_DIR);
}

async function pool() {
  const { stdout } = await run(CTL, ["pool"], { timeout: POOL_TIMEOUT_MS, encoding: "utf8" });
  const all = JSON.parse(stdout);
  return only ? all.filter((vm) => vm.name === only) : all;
}

function ctl(action, vmName) {
  return run(CTL, [action], {
    timeout: LIFECYCLE_TIMEOUT_MS, encoding: "utf8",
    env: { ...process.env, A11Y_VM_NAME: vmName },
  });
}

/**
 * Push one file. `utmctl file push` reads the content from stdin, which execFile cannot stream, so the
 * child is spawned and the file piped in.
 */
function push(uuid, file) {
  return new Promise((done, fail) => {
    const child = execFile("utmctl", ["file", "push", uuid, `${GUEST_DIR}\\${file}`], (error) =>
      error ? fail(new Error(`push ${file}: ${error.message}`)) : done());
    createReadStream(resolve(NVDA_DIR, file)).pipe(child.stdin);
  });
}

async function healthCode(ip, port) {
  const response = await fetch(`http://${ip}:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from /health`);
  return (await response.json()).code;
}

/** How long a rebooted guest gets to start answering before a deploy calls the verification failed. */
const VERIFY_BUDGET_MS = 240_000;
const VERIFY_POLL_MS = 10_000;

/**
 * Read the guest's code hash, waiting for it to finish booting first.
 *
 * A guest that is not answering YET is not a failed deploy, and reading `/health` once immediately after the
 * reboot conflated the two: `worker:deploy` printed "stale or failed" while `npm run worker:code` — run a
 * minute later against the same guest — reported `matches`. That false alarm sent me redeploying guests that
 * had deployed correctly, repeatedly, and the deploy is the tool whose whole job is telling you whether the
 * push landed.
 *
 * Only SILENCE is waited on. A hash that answers and differs is returned straight to the caller, which
 * compares it — so a genuine stale deploy still fails immediately and only a booting guest costs time. Boot
 * times measured on this fleet run from 30 s to 147 s depending on how much Edge-profile hygiene the guest has
 * to do first, so the budget is well above the slowest honest answer.
 */
async function healthCodeWhenAwake(ip, port) {
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  let last = "no answer";
  let waited = false;
  while (Date.now() < deadline) {
    try {
      const actual = await healthCode(ip, port);
      if (waited) process.stdout.write("\n");
      return actual;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!waited) process.stdout.write("  waiting for the guest to answer /health ");
      waited = true;
      process.stdout.write(".");
      await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
    }
  }
  if (waited) process.stdout.write("\n");
  throw new Error(`${ip}:${port} never answered /health within ${VERIFY_BUDGET_MS / 1000}s (last: ${last})`);
}

/**
 * Wait until a VM is no longer `stopping`, so the next deploy does not start a guest on top of one still
 * holding its memory.
 *
 * Bounded and non-fatal: if it never settles we continue and let the next deploy report its own failure,
 * because a deploy that hangs forever is worse than one that reports a stale worker.
 */
async function waitUntilSettled(name, limitMs = 120_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const vm = (await pool()).find((v) => v.name === name);
    if (!vm || vm.state !== "stopping") return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  process.stdout.write(`  note: ${name} is still stopping; continuing anyway\n`);
}

async function deployTo(vm, files, expected) {
  process.stdout.write(`\n=== ${vm.name} ===\n`);
  // Push needs the guest running; the reboot afterwards is what actually loads the new code.
  await ctl("up", vm.name);
  for (const file of files) {
    await push(vm.uuid, file);
    process.stdout.write(`  pushed ${file}\n`);
  }
  process.stdout.write("  rebooting (utmctl exec cannot be trusted to restart the worker) ...\n");
  await ctl("stop", vm.name);
  await ctl("up", vm.name);

  // The restore is in a `finally` because it used to be on the SUCCESS path only, and the failure path is
  // exactly when it matters. A guest whose health check threw was left RUNNING, and the loop then started
  // the next VM on top of it — on a host `doctor` reports as having room for one of two, that guarantees
  // the second times out too. It is then printed as "stale or failed", which reads as a broken guest and
  // sent me looking to rebuild one that boots to ready in 33 s.
  try {
    const fresh = await pool();
    const back = fresh.find((v) => v.name === vm.name);
    if (!back?.ip) throw new Error(`${vm.name} did not come back with an address`);
    const actual = await healthCodeWhenAwake(back.ip, back.port);
    const ok = actual === expected;
    process.stdout.write(`  /health.code ${actual} ${ok ? "== expected" : `!= expected ${expected}`}\n`);
    return ok;
  } finally {
    // Put it back where it was found, the same contract the run's lease honours.
    if (vm.state !== "started") await ctl("stop", vm.name).catch(() => undefined);
  }
}

/**
 * Refuse to deploy a CAPTURE_PROTOCOL_VERSION change unless it is asked for explicitly.
 *
 * This deploys the WORKING TREE, which is right for testing a change and dangerous for one specific
 * change: the protocol version is a capture-cache key input, so shipping a bump invalidates every capture
 * on disk — 2,122 of them — and forces a full recapture that takes hours.
 *
 * The trap is real and was live in this repo. An uncommitted bump in a shared checkout makes
 * `npm run worker:code` report every worker STALE, and the remedy it prints is "redeploy" — which would
 * deploy the bump, wipe the cache, and give no clue why the next run recaptured everything.
 */
function guardProtocolChange() {
  const inTree = /CAPTURE_PROTOCOL_VERSION = (\d+)/.exec(
    readFileSync(resolve(NVDA_DIR, "capture-core.mjs"), "utf8"))?.[1];
  let committed;
  try {
    committed = /CAPTURE_PROTOCOL_VERSION = (\d+)/.exec(
      execFileSync("git", ["show", "HEAD:packages/nvda-worker/src/capture-core.mjs"], { encoding: "utf8" }))?.[1];
  } catch {
    // Two very different situations, and one of them is a guard that has quietly stopped guarding: there may
    // be no git checkout at all, or the PATH may have moved (M5 relocated this file from `src/capture/nvda/`)
    // so `git show` finds nothing. The second would silently disable the most expensive check in this script,
    // which is exactly the shape this repo keeps paying for, so it says so.
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], { stdio: "ignore" });
      process.stdout.write(
        "  note: cannot compare CAPTURE_PROTOCOL_VERSION against HEAD — packages/nvda-worker/src/"
        + "capture-core.mjs is not in HEAD.\n        Expected for a brand-new or just-moved file; if the path"
        + " moved, fix it here or this guard is off.\n");
    } catch { /* genuinely not a git checkout: nothing to compare, and nothing to warn about */ }
    return;
  }
  if (!inTree || !committed || inTree === committed) return;
  if (process.argv.includes("--allow-protocol-change")) {
    process.stdout.write(`\nDeploying CAPTURE_PROTOCOL_VERSION ${committed} -> ${inTree} as requested. ` +
      "Every cached capture is now invalid and the next run will recapture all of them.\n");
    return;
  }
  process.stderr.write(
    `\nREFUSING TO DEPLOY: the working tree has CAPTURE_PROTOCOL_VERSION = ${inTree}, but HEAD has ` +
    `${committed}.\n\n` +
    "That value is a capture-cache key, so deploying it invalidates all cached captures and forces a\n" +
    "full recapture (2,122 captures, hours). If a `worker:code` STALE report sent you here, the stale\n" +
    "hash is probably caused by this uncommitted bump rather than by the guests being out of date.\n\n" +
    "  git stash                            # deploy without the bump, or\n" +
    "  npm run worker:deploy -- --allow-protocol-change   # deploy it deliberately\n");
  process.exit(3);
}

/**
 * Nothing here runs on import.
 *
 * This module used to execute its whole deploy at module scope, so merely importing it — which I did, to read a
 * path constant — ran `guardProtocolChange()` and began enumerating VMs. With guests running it would have
 * pushed files and rebooted them. A program that reboots machines must be invoked, never merely mentioned.
 *
 * `check-worker-code.mjs` got the same treatment. The four remaining scripts in this repo that execute at
 * module scope are pure programs nothing imports; they are left alone deliberately rather than restructured for
 * symmetry.
 */
async function main() {
  guardProtocolChange();

  const files = hashedFiles();
  const expected = localVersion();
  const vms = await pool();
  if (!vms.length) {
    process.stderr.write(only ? `no local worker VM named ${only}\n` : "no local worker VMs registered\n");
    process.exit(2);
  }
  process.stdout.write(`Deploying ${files.length} file(s) to ${vms.length} worker(s)\n`);
  process.stdout.write(`Files: ${files.join(", ")}\nExpected code: ${expected}\n`);

  const failed = [];
  for (const vm of vms) {
    try {
      if (!await deployTo(vm, files, expected)) failed.push(vm.name);
    } catch (error) {
      process.stdout.write(`  FAILED: ${error.message}\n`);
      failed.push(vm.name);
    }
    // A `stop` returns before the guest has actually released its memory — one was observed sitting in
    // `stopping` for minutes. Starting the next VM into that overlap is the same over-commitment by a
    // second route, so wait for the host to be quiet before moving on.
    await waitUntilSettled(vm.name);
  }

  process.stdout.write(`\n${vms.length - failed.length}/${vms.length} worker(s) on ${expected}\n`);
  if (failed.length) {
    process.stdout.write(`stale or failed: ${failed.join(", ")}\n`);
    process.stdout.write("Re-run this command; if it persists, the guest is not rebooting — see docs/nvda-worker-runbook.md\n");
  }
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
