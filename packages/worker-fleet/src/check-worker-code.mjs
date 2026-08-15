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
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { codeVersion, workerSourceDir } from "@a11y-witness/nvda-worker";
import { fleetScriptPaths } from "./fleet-scripts.mjs";
import { configuredWorkers } from "./fleet-env.mjs";

// Resolved from THIS module: the fleet scripts ship with this package, so a cwd-relative path was only ever
// right when run from the repo root.
const CTL = fleetScriptPaths().workerCtl;
// From the worker PACKAGE, not from the cwd. This was `resolve("src/capture/nvda")` and then
// `resolve("packages/nvda-worker/src")` — a repo-layout guess that had to be edited every time the worker
// moved, and that silently pointed at nothing whenever the cwd was not the repo root.
const NVDA_DIR = workerSourceDir();
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
    const inTree = /CAPTURE_PROTOCOL_VERSION = (\d+)/.exec(
      readFileSync(resolve(NVDA_DIR, "capture-core.mjs"), "utf8"))?.[1];
    const committed = /CAPTURE_PROTOCOL_VERSION = (\d+)/.exec(
      execFileSync("git", ["show", "HEAD:packages/nvda-worker/src/capture-core.mjs"], { encoding: "utf8" }))?.[1];
    if (inTree && committed && inTree !== committed) {
      return `\nNOTE: your working tree has CAPTURE_PROTOCOL_VERSION = ${inTree} but HEAD has ${committed}.\n` +
        "That alone changes the local hash, so the guests may not be stale at all. Deploying it would\n" +
        "invalidate every cached capture — `npm run worker:deploy` refuses unless you pass\n" +
        "--allow-protocol-change.\n";
    }
  } catch { /* not a git checkout; nothing to add */ }
  return "";
}

const localVersion = () => codeVersion(NVDA_DIR);

function workerUrls() {
  // This preferred A11Y_WORKER while doctor preferred A11Y_WORKERS, so with both set the two commands
  // described different machines -- and "doctor is happy" / "a worker is stale" could be about disjoint
  // sets. One parser now, in fleet-env.mjs, which also owns the inventory.
  const named = configuredWorkers();
  if (named.length) return named.map((w) => w.url);
  const pool = JSON.parse(execFileSync(CTL, ["pool"], { encoding: "utf8" }));
  return pool.filter((vm) => vm.ip).map((vm) => `http://${vm.ip}:${vm.port}`);
}

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
  const expected = localVersion();
  const urls = workerUrls();
  console.log(`this checkout: ${expected}`);
  if (!urls.length) {
    console.log("no worker is running — nothing to compare (start one, or a run will)");
    process.exit(0);
  }

  let stale = 0;
  for (const url of urls) {
    let actual;
    try {
      actual = await versionOf(url);
    } catch (e) {
      console.log(`  ${url}  unreachable (${e.message})`);
      continue;
    }
    // "absent" means the worker predates /health.code, which is itself a stale deploy.
    const ok = actual === expected;
    if (!ok) stale += 1;
    console.log(`  ${url}  ${actual}  ${ok ? "matches" : "STALE — redeploy and REBOOT the guest"}`);
  }
  if (stale) {
    console.log(`\n${stale} stale worker(s). A restart via \`utmctl exec\` silently does nothing on`);
    console.log("some guests; rebooting the VM always picks up a pushed file:");
    console.log("  utmctl stop <uuid> --request && utmctl start <uuid>");
      console.log("  ...or simply: npm run worker:deploy");
      const note = protocolBumpNote();
      if (note) console.log(note);
  }
  process.exit(stale ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
