// Can I run right now? One command, one answer.
//
//   npm run doctor            human-readable, with the fix for anything broken
//   npm run doctor -- --json  machine-readable, for an agent
//
// This exists because "is the environment ready" took five commands and some inference, and
// the inference went wrong: a healthy VM was reported as a corrupted one because `utmctl`
// answers `unknown` when the UTM app is closed. Every check below therefore reports what it
// observed AND the exact command that fixes it, so nothing has to be deduced.
//
// Exit codes: 0 ready, 1 something is broken (details in the report).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { availableHostMemoryMb, workersHostCanRun } from "./host-capacity.mjs";
import { fleetConsistency, describeMismatches } from "./fleet-consistency.mjs";
import { assessWorker } from "./worker-health.mjs";
import { fleetScriptPaths } from "./fleet-scripts.mjs";

const run = promisify(execFile);
const JSON_OUT = process.argv.includes("--json");
const WORKER_ENV = process.env.A11Y_WORKER ?? null;
const PAGES_PORT = Number(process.env.DATASET_PAGES_PORT || 5050);
// The lifecycle script ships beside this one in the fleet package. It was `../scripts/local-worker/...`,
// resolved from this module — correct while doctor lived in `scripts/`, and silently wrong the moment it
// moved: doctor then reported "no local VM tooling here" on a host with three registered VMs, which reads as
// a broken environment rather than a broken path.
const CTL = fleetScriptPaths().workerCtl;
const DATASET = resolve(process.cwd(), "runs/screenreader-dataset");
const PROBE_TIMEOUT_MS = 8000;

const checks = [];
const add = (name, ok, detail, fix = null) => checks.push({ name, ok, detail, fix });

function commandError(error) {
  const observed = [error?.stderr, error?.stdout, error?.message]
    .map((value) => String(value ?? "").trim())
    .find(Boolean) || "unknown command failure";
  return observed.replace(/\s+/g, " ").slice(0, 400);
}

function workerControlFix(observed) {
  if (/no VM named|no worker VM registered/i.test(observed)) {
    return "UTM has no registered worker VM; re-register the existing a11y-worker*.utm bundles in UTM, then re-run " + `${CTL} pool`;
  }
  return existsSync("/Applications/UTM.app")
    ? "unlock the Mac if it is locked, then re-run " + `${CTL} pool`
    : `${CTL} pool   # launches UTM if it is installed`;
}

async function shell(cmd, args, timeout = 30000) {
  const { stdout } = await run(cmd, args, { timeout, encoding: "utf8" });
  return stdout.trim();
}

async function httpJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// --- the checks -----------------------------------------------------------

async function checkJudge() {
  const backend = (process.env.JUDGE_BACKEND ?? "codex").toLowerCase();
  if (backend !== "codex") {
    const key = backend === "anthropic" ? "ANTHROPIC_API_KEY" : "JUDGE_BASE_URL";
    return add("judge", !!process.env[key], `backend=${backend}`, `export ${key}=...`);
  }
  try {
    await shell("codex", ["--version"], 15000);
    add("judge", true, "codex CLI present (login is not checked here)");
  } catch {
    add("judge", false, "codex CLI not found", "install Codex and run: codex login");
  }
}

// Workers, as a POOL, and with the right idea of what "ready" means.
//
// This check used to look at one VM and fail if it was not started. That was true before runs
// managed the VM themselves; now a stopped worker is the correct resting state -- a run starts
// what it needs and puts it back afterwards -- so reporting it as FAIL told an agent the
// environment was broken when it was idle. One did exactly that: it went hunting for a
// decommissioned worker on another host and then reached for the UTM GUI.
//
// Ready means "a run can proceed", not "everything is already running".
async function checkWorker() {
  if (WORKER_ENV) {
    try {
      const health = await httpJson(`${WORKER_ENV.replace(/\/$/, "")}/health`);
      return add("worker", health.screenReader === "NVDA", `A11Y_WORKER ${WORKER_ENV} — ${JSON.stringify(health)}`);
    } catch (e) {
      return add("worker", false, `A11Y_WORKER ${WORKER_ENV} unreachable (${e.message})`,
        "check that machine is up and its a11ysrv task is running; or unset A11Y_WORKER to use the local pool");
    }
  }
  if (process.platform !== "darwin" || !existsSync(CTL)) {
    return add("worker", false, "no A11Y_WORKER set and no local VM tooling here",
      "set A11Y_WORKER=http://host:8765, or see docs/getting-started.md");
  }

  let pool;
  try {
    pool = JSON.parse(await shell(CTL, ["pool"], 90000));
  } catch (e) {
    return add("worker", false, `could not query the local pool (${commandError(e)})`,
      workerControlFix(commandError(e)));
  }
  if (!pool.length) {
    return add("worker", false, "no worker VM registered",
      "UTM has no registered worker VM; re-register an existing a11y-worker*.utm bundle, or build one from docs/getting-started.md");
  }

  const running = pool.filter((vm) => vm.state === "started");
  const healthy = pool.filter((vm) => vm.healthy);
  const brokenlyRunning = running.filter((vm) => !vm.healthy);
  const summary = pool.map((vm) => `${vm.name}=${vm.healthy ? vm.ip : vm.state}`).join(" ");

  // A VM that is RUNNING but not answering is a genuine fault. One that is stopped is not.
  if (brokenlyRunning.length) {
    add("worker", false, `${summary} — ${brokenlyRunning.map((v) => v.name).join(", ")} running but not answering`,
      "Start-ScheduledTask -TaskName a11ysrv on that guest, or " + `${CTL} stop && ${CTL} up`);
  } else if (healthy.length) {
    add("worker", true, `${healthy.length}/${pool.length} ready — ${summary}`);
  } else {
    add("worker", true, `${pool.length} worker(s), all stopped — a run starts them automatically (${summary})`);
  }
  await checkDegradedWorkers(pool);
  await checkFleetConsistency(pool);
  checkHostCapacity(pool);
  const busy = pool.filter((vm) => vm.busy);
  if (busy.length) {
    add("contention", false, `${busy.map((v) => v.name).join(", ")} busy with a capture — another shell or agent is using the pool`,
      "wait for it, or you will both see the other's restarts as breakage");
  }
}

// A guest whose NVDA fails on every capture keeps serving and keeps passing — it just costs 4x.
//
// The run's eviction rule needs three consecutive FAILURES, and the worker's own retry means there are
// none, so this never surfaced anywhere. Measured on this pool: one worker needed a recovery on 4 of 4
// captures (nvdaStart 19.1s each, WALL 122.9s) beside one that needed none (WALL 40.6s). Reported, not
// failed: a degraded worker is slow, not broken, and pulling it costs more throughput than it saves.
async function checkDegradedWorkers(pool) {
  for (const vm of pool.filter((v) => v.healthy && v.ip)) {
    let health;
    try {
      health = await httpJson(`http://${vm.ip}:${vm.port}/health`);
    } catch {
      continue; // unreachable is already the worker check's business
    }
    const { degraded, reason } = assessWorker(health.vitals);
    if (degraded) {
      add(`worker ${vm.name}`, true, `DEGRADED — ${reason}`,
        `powershell -File scripts/provision-nvda-worker.ps1   # on ${vm.name}, in the interactive session`);
    }
  }
}

/**
 * Are the guests interchangeable?
 *
 * The pool assumes so: cases go to whichever worker is free, the cache lets any guest reuse another's
 * evidence, and a good/bad pair is only comparable because both halves came from equivalent machines.
 * Two real divergences happened in one day -- Edge auto-updated on one guest while the others stayed
 * behind, and StartupBoostEnabled read 1 on two guests and 0 on a third -- and BOTH were caught by a
 * human reading a console by eye. That is not a detection mechanism.
 *
 * Never a FAIL. A run on slightly mismatched guests is worse than one on matched guests and far better
 * than no run, and a diagnostic must not be the thing that takes the pool offline.
 */
async function checkFleetConsistency(pool) {
  const guests = [];
  for (const vm of pool.filter((v) => v.healthy && v.ip)) {
    try {
      const health = await httpJson(`http://${vm.ip}:${vm.port}/health`);
      guests.push({ worker: `http://${vm.ip}:${vm.port}`, environment: health.environment, policy: null });
    } catch {
      continue; // unreachable is the worker check's business, not this one
    }
  }
  const { consistent, mismatches } = fleetConsistency(guests);
  if (guests.length < 2) return;
  if (consistent) {
    add("fleet", true, `${guests.length} guests agree on browser, screen reader, OS and protocol`);
    return;
  }
  add("fleet", true, `INCONSISTENT — ${describeMismatches(mismatches).join("; ")}`,
    "npm run fleet:normalise   # applies the baseline to every guest, elevated");
}

// Can this host actually hold the pool it has registered?
//
// Not a fault, and never a FAIL: a capped pool runs fine, just narrower. It is reported because the
// alternative is invisible. Three guests on this 36 GB Mac made every capture 1.6x slower than one
// and produced mute-NVDA failures, and from outside that reads as "the workers are degrading" rather
// than "the host is out of memory" — which is exactly how it was misread for a day.
function checkHostCapacity(pool) {
  const availableMb = availableHostMemoryMb();
  if (availableMb === null || !pool.length) return;
  // Guests already up have paid for their memory and are not counted in `availableMb`, so they are
  // added back — otherwise a running worker makes the host look smaller than it is.
  const running = pool.filter((vm) => vm.state === "started").length;
  const poolSize = pool.length;
  const limit = workersHostCanRun({ availableMb, alreadyRunning: running });
  const detail = `~${availableMb} MB available — room for ${Math.min(limit, poolSize)} of ${poolSize} worker(s)`;
  add("host memory", true, limit >= poolSize
    ? detail
    : `${detail}; the rest stay stopped so the run does not swap (override: A11Y_MAX_WORKERS)`);
}

// Dataset capture needs the pages served, and the guest must be able to reach them — the
// host's localhost is not reachable from inside the VM. The capture command leases the page
// server for the run, so an idle host with no listener on this port is ready, not broken.
async function checkDatasetPages() {
  const manifestPath = resolve(DATASET, "manifest.json");
  if (!existsSync(manifestPath)) {
    return add("dataset", false, "no manifest — the dataset has not been generated",
      "npm run training:generate");
  }
  // Ask for a REAL page, not `/`.
  //
  // "Something answers on :5050" is not the same as "our pages are being served", and the difference
  // has already cost a dataset: a stray server on that port reported "Capture complete: 3/3 cases"
  // while every transcript read "Error code: 404". A leftover `npx serve` from another directory
  // answers the root happily and 404s every case. Four of them were running on this host today, which
  // is how likely that is.
  const sample = JSON.parse(readFileSync(manifestPath, "utf8")).cases?.[0]?.id;
  const probe = sample ? `${sample}/good.html` : "";
  try {
    const response = await fetch(`http://localhost:${PAGES_PORT}/${probe}`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) {
      return add("pages", false, `:${PAGES_PORT} answers but returns HTTP ${response.status} for ${probe} — wrong directory`,
        `something else holds the port. Stop it; training:capture will lease the dataset server automatically`);
    }
    add("pages", true, `serving the dataset on :${PAGES_PORT} (verified ${probe || "/"})`);
  } catch {
    add("pages", true, `nothing serving on :${PAGES_PORT} — training:capture leases it automatically`);
  }
}

// A run left mid-flight is the difference between "start" and "--resume", and getting it
// wrong either re-captures for hours or silently skips work.
function checkRunState() {
  const progress = resolve(DATASET, "capture-progress.json");
  if (!existsSync(progress)) return add("run", true, "no capture run recorded");
  const p = JSON.parse(readFileSync(progress, "utf8"));
  if (!p.startedAt) return add("run", true, "no capture run recorded");
  if (!p.finishedAt) {
    return add("run", false, `a run is UNFINISHED (started ${p.startedAt})`,
      "npm run training:wait, or npm run training:capture -- --resume --no-cache");
  }
  const failed = Object.values(p.cases ?? {}).filter((c) => c.status === "failed").length;
  add("run", failed === 0, `last run ${p.outcome ?? "finished"}`,
    failed ? "npm run training:capture -- --resume --no-cache" : null);
}

// --- report ---------------------------------------------------------------

await checkJudge();
await checkWorker();
await checkDatasetPages();
checkRunState();

const ready = checks.every((c) => c.ok);

// The single most useful line for anything automated: what to run next. A list of green ticks
// still leaves a caller deciding, and deciding is where they go wrong.
function nextCommand() {
  const broken = checks.find((c) => !c.ok);
  if (!broken) return "npm run training:capture        # starts any stopped worker and releases it after";
  if (broken.name === "contention") return "wait — the pool is busy with another run";
  return broken.fix ?? "see the failing check above";
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ready, next_command: nextCommand(), checks }, null, 2));
} else {
  for (const c of checks) {
    console.log(`${c.ok ? "OK  " : "FAIL"}  ${c.name.padEnd(11)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`        fix: ${c.fix}`);
  }
  console.log(`\n${ready ? "READY" : "NOT READY — see the fixes above"}`);
  console.log(`next: ${nextCommand()}`);
}
process.exit(ready ? 0 : 1);
