#!/usr/bin/env node
// @ts-check
// Is every worker running the code in this checkout?
//
//   npm run worker:code
//
// Deploying is push-then-restart and both halves fail silently: `utmctl exec` reports success
// whether or not it ran, so a worker can serve the previous process indefinitely. Reading the
// guest's file hash does not help, because that read goes through exec too -- when exec is
// dead the check returns empty rather than mismatched, which reads as a flaky tool instead of a
// failed deploy. That cost an hour, and the stale workers looked exactly like a logic bug.
//
// This asks each worker over HTTP, which is reachable exactly when the worker is usable and
// involves no guest agent. Exit 0 when every worker matches, 1 otherwise.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
// The WORKING-TREE value, imported rather than regex-scraped — architecture-audit.md §5, item 3.
// `protocol-version.mjs` is dependency-free for exactly this: safe to import from a portable tree.
import { CAPTURE_PROTOCOL_VERSION as PROTOCOL_IN_TREE } from "@a11y-witness/nvda-worker/protocol-version";
import { fleetScriptPaths } from "./fleet-scripts.mjs";
import { configuredWorkers, inventoryWorkerUrls, resolveWorkerPool } from "./fleet-env.mjs";
// The comparison, the remedy and the expected hash live in ONE place, because the capture entry points ask
// the same question before every run and a second copy of "is this worker stale" is a second answer.
import { expectedWorkerCode, codeDrift, remedyLines } from "./worker-code-check.mjs";
import { refuseUnknownFlags } from "./cli-flags.mjs";
import { errorText } from "@a11y-witness/nvda-worker/error-text";

/**
 * takes NO flags — it asks every worker what code it is running and compares. Any flag passed to it
 * today is discarded in silence.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags([], { entry: import.meta.url, command: "npm run worker:code" });

// Resolved from THIS module: the fleet scripts ship with this package, so a cwd-relative path was only ever
// right when run from the repo root.
const CTL = fleetScriptPaths().workerCtl;
// /health now reports installed runtime versions as well as the code hash. The first
// request after a Windows boot may need PowerShell file-version discovery, so four seconds
// was too tight and made a healthy worker look unreachable.
const HEALTH_TIMEOUT_MS = 15000;

// The guest and the host now call the SAME function over the SAME list, so they cannot disagree by
// construction. This used to be two copies of one loop kept in step by a comment.
/**
 * A STALE report is usually a real stale guest — but not when the working tree carries an uncommitted
 * CAPTURE_PROTOCOL_VERSION bump. Then every worker reports stale because the LOCAL hash moved, and the
 * obvious remedy (redeploy) would ship the bump and invalidate all 2,122 cached captures.
 *
 * Saying so here costs one line and saves someone an unexplained full recapture.
 */
function protocolBumpNote() {
  try {
    const inTree = String(PROTOCOL_IN_TREE);
    const committed = /CAPTURE_PROTOCOL_VERSION = (\d+)/.exec(
      execFileSync("git", ["show", "HEAD:packages/nvda-worker/src/protocol-version.mjs"], { encoding: "utf8" }))?.[1];
    if (inTree && committed && inTree !== committed) {
      return `\nNOTE: your working tree has CAPTURE_PROTOCOL_VERSION = ${inTree} but HEAD has ${committed}.\n` +
        "That alone changes the local hash, so the guests may not be stale at all. Deploying it would\n" +
        "invalidate every cached capture — `npm run worker:deploy` refuses unless you pass\n" +
        "--allow-protocol-change.\n";
    }
  } catch { /* not a git checkout; nothing to add */ }
  return "";
}

/**
 * Which workers to ask, AND WHERE THAT LIST CAME FROM — the second half is not decoration.
 *
 * This used to answer the local UTM pool or nothing, and print "no worker is running — nothing to compare"
 * when it found neither. Measured 2026-08-28 with five bare-metal workers serving `/health` and all five
 * STALE against this checkout: the bare command reported nothing to compare, and the same command with
 * `A11Y_WORKERS` set reported `5 stale worker(s)`. One env var apart, and the quiet answer was the wrong one.
 *
 * That is `lab:inventory`'s lesson at a different layer — *"'none here' and 'none anywhere' are different
 * answers, and it now refuses to turn the first into the second"* — and it lands harder here, because this
 * command exists to stop a corpus being captured on the wrong code. A false clean from it is the failure it
 * was written to prevent, delivered by the tool itself.
 *
 * The inventory was already imported and already read, twelve lines below, to print the REMEDY. So the
 * command could name the five workers it should have checked while insisting it had none to check.
 *
 * Reading it here is safe in a way it would not be for a capture run: this probes `/health` and starts
 * nothing, so the rule that naming workers means you are managing them does not apply.
 */
export function workerUrls({
  named = configuredWorkers, local = localPoolUrls, inventory = inventoryWorkerUrls,
} = {}) {
  // ONE PRECEDENCE, in fleet-env.mjs. This function held its own -- named, then the LOCAL UTM POOL, then
  // the inventory -- while `doctor` went named then inventory, so on any Mac with a registered guest the
  // two commands described different fleets. That is the divergence the comment here used to claim it had
  // closed; it closed the NAMED half only.
  return resolveWorkerPool({ named, inventory, local });
}

/** The local UTM pool, or none — `utmctl` is absent on a machine that never had one. */
function localPoolUrls() {
  try {
    const pool = JSON.parse(execFileSync(CTL, ["pool"], { encoding: "utf8" }));
    return pool.filter((/** @type {{ip?: string}} */ vm) => vm.ip)
      .map((/** @type {{ip: string, port: number}} */ vm) => `http://${vm.ip}:${vm.port}`);
  } catch (e) {
    // Never silent: "there is no UTM here" and "utmctl failed" are different, and the second is the one
    // that would otherwise send somebody to the inventory believing the local pool was empty.
    if (process.env.A11Y_DEBUG) console.log(`  (local pool unavailable: ${errorText(e)})`);
    return [];
  }
}

/** @param {string} url */
async function versionOf(url) {
  const response = await fetch(`${url.replace(/\/$/, "")}/health`, {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  return (await response.json()).code ?? "absent";
}

/**
 * Nothing here runs on import, for the same reason as `deploy-worker.mjs`: a module that probes every worker
 * over HTTP should be invoked, not merely mentioned. It also lets `code-version.test.ts` import this rather
 * than parse its source as text.
 */
async function main() {
  const expected = expectedWorkerCode();
  const { urls, source } = workerUrls();
  console.log(`this checkout: ${expected}`);
  if (!urls.length) {
    console.log("no worker configured, running locally, or listed in inventory.yml — nothing to compare");
    process.exit(0);
  }
  // Say which list this is. A reading of "all current" means nothing until you know whether it examined
  // the fleet you are about to capture on or the empty pool on your laptop.
  console.log(`checking ${urls.length} worker(s) from ${source}`);

  // Read first, CLASSIFY second, and the classifier is the one the capture preflight uses. This loop used
  // to decide staleness itself with `actual === expected` — the same judgement in a second place, which is
  // exactly what `worker-code-check.mjs` exists to stop. `versionOf` stays only because the CLI reports the
  // network error text per worker, which a preflight has no use for.
  const readings = [];
  for (const url of urls) {
    try {
      // "absent" means the worker predates /health.code, which is itself a stale deploy.
      readings.push({ worker: url, code: await versionOf(url) });
    } catch (e) {
      console.log(`  ${url}  unreachable (${errorText(e)})`);
      readings.push({ worker: url, code: null });
    }
  }

  const { stale } = codeDrift(expected, readings);
  const staleUrls = stale.map((s) => s.worker);
  const isStale = new Set(staleUrls);
  for (const { worker, code } of readings.filter((r) => r.code !== null)) {
    console.log(`  ${worker}  ${code}  ${isStale.has(worker) ? "STALE — redeploy and REBOOT the guest" : "matches"}`);
  }
  if (staleUrls.length) {
    for (const line of remedyLines(staleUrls, inventoryWorkerUrls())) console.log(line);
    const note = protocolBumpNote();
    if (note) console.log(note);
  }
  process.exit(staleUrls.length ? 1 : 0);
}

// REALPATH'D: `import.meta.url` is resolved through symlinks by Node's ESM loader and `process.argv[1]`
// is not, so a bin reached via its `.bin` symlink (which is how npm always installs one) mismatched here
// and this guard silently read false — the tool loaded, did nothing, and exited 0. `/var` and `/tmp` are
// themselves symlinks on macOS, so this fired every time. Same defect, same fix, as `cli.ts`'s `isProgram`.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
