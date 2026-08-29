// @ts-check
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { availableHostMemoryMb, workersHostCanRun } from "./host-capacity.mjs";
import { fleetConsistency, describeMismatches } from "./fleet-consistency.mjs";
import { assessWorker } from "./worker-health.mjs";
import { controlPlaneIsolation } from "./control-plane-isolation.mjs";
import { fleetScriptPaths } from "./fleet-scripts.mjs";
import { configuredWorkers } from "./fleet-env.mjs";
import { refuseUnknownFlags } from "./cli-flags.mjs";

/**
 * a mistyped `--json` prints for a human where a script expected a machine-readable answer, and the
 * caller parses the prose.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags(["--json"], { entry: import.meta.url, command: "npm run doctor" });

const run = promisify(execFile);
const JSON_OUT = process.argv.includes("--json");
// A11Y_WORKERS (plural) is how a bare-metal fleet is configured -- bootstrap-control-plane.sh tells you
// to set exactly that -- and this read only A11Y_WORKER. So doctor reported "no A11Y_WORKER set and no
// local VM tooling here" against a healthy fleet of ten machines, and doctor is the FIRST command
// CLAUDE.md tells an agent to run. The environment was fine and the entry point said it was broken.
//
// Parsed by fleet-env.mjs, which is the ONE place that answers "what is the fleet" -- see there for why
// the precedence had to be settled: doctor and worker:code disagreed, so they could report on two
// different sets of machines with nothing to say so.
const WORKERS_ENV = configuredWorkers();
const PAGES_PORT = Number(process.env.DATASET_PAGES_PORT || 5050);
// The lifecycle script ships beside this one in the fleet package. It was `../scripts/local-worker/...`,
// resolved from this module — correct while doctor lived in `scripts/`, and silently wrong the moment it
// moved: doctor then reported "no local VM tooling here" on a host with three registered VMs, which reads as
// a broken environment rather than a broken path.
const CTL = fleetScriptPaths().workerCtl;
// Resolved from THIS module, never the cwd. The scorer being resolved against `process.cwd()` is the
// defect that made a fresh clone unable to run its own default judge (see packages/scorer/src/index.ts),
// so nothing here may repeat it.
const SCORER_MODEL_DIR = fileURLToPath(new URL("../../scorer/models/screenreader-scorer/", import.meta.url));
const DATASET = resolve(process.cwd(), "runs/screenreader-dataset");
const PROBE_TIMEOUT_MS = 8000;

/** @type {any[]} */
/** @type {{ name: string, ok: boolean, detail: string, fix: string|null }[]} */
/** @type {{name: string, ok: boolean, detail: string, fix: string|null, advisory?: boolean}[]} */
const checks = [];
/**
 * One check's verdict, and its FIX. Every parameter is typed here rather than inferred, because `fix`
 * defaulting to `null` infers as exactly `null` -- so the argument that matters most, the sentence
 * telling a reader what to do about a failed check, was the one the compiler refused.
 *
 * @param {string} name @param {boolean} ok @param {string} detail @param {string|null} [fix]
 */
const add = (name, ok, detail, fix = null) => checks.push({ name, ok, detail, fix });

/**
 * A finding that is REAL and does not stop a run — reported every time, never blocking.
 *
 * `doctor` exits 0 when a run can PROCEED, and that contract is load-bearing: agents are told to read
 * `next_command` and act on it. An architectural debt is not a reason a capture cannot happen, so filing
 * one as a failure would make `doctor` say NOT READY on a machine that is fine — and a readiness command
 * that cries wolf is one people stop running, which is how the checks it does own stop being read.
 *
 * Distinct from `ok: true` for the opposite reason: silence is how ADR 0012 went years describing a system
 * that did not exist. It is stated on every run and excluded from the verdict.
 */
const advise = (/** @type {string} */ name, /** @type {string} */ detail, /** @type {string|null} */ fix = null) => checks.push({ name, ok: true, advisory: true, detail, fix });

function commandError(/** @type {any} */ error) {
  const observed = [error?.stderr, error?.stdout, /** @type {any} */ (error)?.message]
    .map((value) => String(value ?? "").trim())
    .find(Boolean) || "unknown command failure";
  return observed.replace(/\s+/g, " ").slice(0, 400);
}

function workerControlFix(/** @type {any} */ observed) {
  if (/no VM named|no worker VM registered/i.test(observed)) {
    return "UTM has no registered worker VM; re-register the existing a11y-worker*.utm bundles in UTM, then re-run " + `${CTL} pool`;
  }
  return existsSync("/Applications/UTM.app")
    ? "unlock the Mac if it is locked, then re-run " + `${CTL} pool`
    : `${CTL} pool   # launches UTM if it is installed`;
}

async function shell(/** @type {any} */ cmd, /** @type {any} */ args, timeout = 30000) {
  const { stdout } = await run(cmd, args, { timeout, encoding: "utf8" });
  return stdout.trim();
}

async function httpJson(/** @type {any} */ url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// --- the checks -----------------------------------------------------------

/**
 * IS THE FLEET KEY SITTING NEXT TO 100 MB OF PACKAGES NOBODY AUDITED? — ADR 0012, checked rather than
 * asserted.
 *
 * Found on 2026-08-29 to be violated on BOTH machines the ADR is about: the control plane carried 56 MB
 * and 121 packages beside the key, and this laptop carries 103 MB beside the same key plus the lab key.
 * The document was accurate about the intent and described a system that did not exist — which is worse
 * than no document, because it is read as a guarantee.
 *
 * Reported by `doctor` because that is the command whose whole promise is that every check names its own
 * fix, and because a check nobody runs is one this repo has learned not to write.
 */
function checkControlPlaneIsolation() {
  // `~` is a SHELL expansion, not a filesystem one: `existsSync("~/.ssh/...")` is always false, which
  // would make this guard report every machine as compliant. The silent-pass failure mode, in the guard
  // written because a document silently passed.
  const raw = process.env.A11Y_SSH_KEY || "~/.ssh/a11y-witness_ed25519";
  const keyPath = raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : raw;
  const hasFleetKey = existsSync(keyPath);
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  const hasNodeModules = existsSync(resolve(root, "node_modules"));
  // A workspace is a checkout with sources, which is what makes "delete node_modules" the wrong advice
  // here and the right advice on a control plane.
  const isWorkspace = existsSync(resolve(root, "packages")) && existsSync(resolve(root, "package.json"));
  const verdict = controlPlaneIsolation({ hasNodeModules, hasFleetKey, isWorkspace });
  // NOT a hard failure: this machine cannot do its job without the key today, and a doctor that refuses
  // to say READY over an architectural debt would simply be ignored. It is reported every run so it stays
  // visible, which is the difference between a known debt and a forgotten one.
  if (!verdict.violated) return add("isolation", true, verdict.why);
  advise("isolation", verdict.why,
    "docs/control-plane-plan.md L3 — drive the control plane rather than holding its keys");
}


// The DEFAULT here was "codex", and every part of that was wrong. `judge.ts` has no codex case at all —
// it offers local, anthropic and openai — so with JUDGE_BACKEND unset (the normal case) this told the
// operator to "install Codex and run: codex login" for a backend the product cannot use. And setting
// JUDGE_BACKEND=local fell into the other branch and checked JUDGE_BASE_URL, which local does not need.
// Both answers were wrong, in a command whose whole promise is that every check names its own fix.
//
// Mirrors judge.ts's default deliberately: a doctor that disagrees with the thing it inspects is worse
// than no doctor.
async function checkJudge() {
  // `||`, not `??`: an env var set to the EMPTY string is how CI passes "unset", and `??` only defaults
  // on nullish — so an empty JUDGE_BACKEND matched no backend and reported a typo that nobody made.
  const backend = (process.env.JUDGE_BACKEND || "local").toLowerCase();
  if (backend === "local") {
    const weights = resolve(SCORER_MODEL_DIR, "model.safetensors");
    return add("judge", existsSync(weights),
      existsSync(weights) ? "backend=local, trained scorer present" : "backend=local, but the trained scorer is missing",
      `expected weights at ${weights} — they ship in the repo, so this means an incomplete checkout`);
  }
  if (backend === "anthropic" || backend === "openai") {
    const key = backend === "anthropic" ? "ANTHROPIC_API_KEY" : "JUDGE_BASE_URL";
    return add("judge", !!process.env[key], `backend=${backend}`, `export ${key}=...`);
  }
  // Refuse an unknown backend rather than reporting on one that will not run — the same rule action.yml
  // applies, because a typo must not quietly change which judge assessed the page.
  add("judge", false, `backend=${backend} is not one of local, anthropic, openai`,
    "unset JUDGE_BACKEND to use the default local scorer");
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
  if (WORKERS_ENV.length) return checkConfiguredFleet(WORKERS_ENV);
  if (process.platform !== "darwin" || !existsSync(CTL)) {
    return add("worker", false, "no A11Y_WORKERS set and no local VM tooling here",
      "set A11Y_WORKERS=http://host:8765[,http://host2:8765], or see docs/getting-started.md");
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

  const running = pool.filter((/** @type {any} */ vm) => vm.state === "started");
  const healthy = pool.filter((/** @type {any} */ vm) => vm.healthy);
  const brokenlyRunning = running.filter((/** @type {any} */ vm) => !vm.healthy);
  const summary = pool.map((/** @type {any} */ vm) => `${vm.name}=${vm.healthy ? vm.ip : vm.state}`).join(" ");

  // A VM that is RUNNING but not answering is a genuine fault. One that is stopped is not.
  if (brokenlyRunning.length) {
    add("worker", false, `${summary} — ${brokenlyRunning.map((/** @type {any} */ v) => v.name).join(", ")} running but not answering`,
      "Start-ScheduledTask -TaskName a11ysrv on that guest, or " + `${CTL} stop && ${CTL} up`);
  } else if (healthy.length) {
    add("worker", true, `${healthy.length}/${pool.length} ready — ${summary}`);
  } else {
    add("worker", true, `${pool.length} worker(s), all stopped — a run starts them automatically (${summary})`);
  }
  // Same shape as a configured fleet, so the two diagnostics below have ONE implementation. They were
  // pure functions over /health JSON that only the UTM branch could reach, which meant a bare-metal
  // fleet -- the direction this project is going -- got neither.
  const reachable = pool.filter((/** @type {any} */ v) => v.healthy && v.ip)
    .map((/** @type {any} */ v) => ({ name: v.name, url: `http://${v.ip}:${v.port}` }));
  await checkDegradedWorkers(reachable);
  await checkFleetConsistency(reachable);
  checkHostCapacity(pool);
  const busy = pool.filter((/** @type {any} */ vm) => vm.busy);
  if (busy.length) {
    add("contention", false, `${busy.map((/** @type {any} */ v) => v.name).join(", ")} busy with a capture — another shell or agent is using the pool`,
      "wait for it, or you will both see the other's restarts as breakage");
  }
}

/**
 * The fleet named by A11Y_WORKERS: probe every one, report per worker, never fail on a single loss.
 *
 * "Ready means a run can proceed" is this file's own rule, and for a fleet that means AT LEAST ONE
 * worker answering -- not all of them. The dispatcher already evicts a worker after three consecutive
 * failures and requeues its cases (capture-decisions.mjs), so one dead machine costs throughput, not
 * the run. Failing the whole check for it would tell an agent the environment is broken when nine
 * workers are sitting idle and ready, which is the exact mistake the comment above checkWorker
 * describes for a stopped VM.
 */
async function checkConfiguredFleet(/** @type {any} */ workers) {
  const probed = [];
  for (const w of workers) {
    try {
      probed.push({ ...w, health: await httpJson(`${w.url}/health`) });
    } catch (e) {
      probed.push({ ...w, health: null, error: /** @type {any} */ (e).message });
    }
  }
  const reachable = probed.filter((p) => p.health);
  const ready = reachable.filter((p) => p.health.ready);
  const state = (/** @type {any} */ p) => {
    if (!p.health) return "unreachable";
    if (p.health.busy) return "busy";
    return p.health.ready ? "ready" : "not-ready";
  };
  const summary = probed.map((p) => `${p.name}=${state(p)}`).join(" ");

  if (!reachable.length) {
    return add("worker", false, `${workers.length} configured, none answering — ${summary}`,
      "check those machines are up and their a11ysrv task is running; "
      + `curl ${workers[0].url}/health from this host`);
  }
  // A worker that answers but is not ready is normal right after a boot and clears on its own --
  // /health's own note says so -- which is why this reports the count rather than failing on it.
  add("worker", true, `${ready.length}/${workers.length} ready — ${summary}`);

  const unreachable = probed.filter((p) => !p.health);
  if (unreachable.length) {
    add("fleet reach", true, `${unreachable.length} not answering: ${unreachable.map((p) => p.name).join(", ")}`
      + " — the run will dispatch to the rest");
  }

  await checkDegradedWorkers(workers);
  await checkFleetConsistency(workers);

  // Contention only matters when there is nowhere left to dispatch. One busy worker in a fleet of ten
  // is a run in progress, not a conflict -- flagging it would make doctor fail during normal use.
  if (reachable.length && reachable.every((p) => p.health.busy)) {
    add("contention", false, `all ${reachable.length} reachable worker(s) busy — another run or agent has the fleet`,
      "wait for it, or you will both see the other's restarts as breakage");
  }
}

// A guest whose NVDA fails on every capture keeps serving and keeps passing — it just costs 4x.
//
// The run's eviction rule needs three consecutive FAILURES, and the worker's own retry means there are
// none, so this never surfaced anywhere. Measured on this pool: one worker needed a recovery on 4 of 4
// captures (nvdaStart 19.1s each, WALL 122.9s) beside one that needed none (WALL 40.6s). Reported, not
// failed: a degraded worker is slow, not broken, and pulling it costs more throughput than it saves.
async function checkDegradedWorkers(/** @type {any} */ workers) {
  for (const w of workers) {
    let health;
    try {
      health = await httpJson(`${w.url}/health`);
    } catch {
      continue; // unreachable is already the worker check's business
    }
    const { degraded, reason } = assessWorker(health.vitals);
    if (degraded) {
      add(`worker ${w.name}`, true, `DEGRADED — ${reason}`,
        `re-provision ${w.name}: packages/worker-fleet/src/provisioning/provision-nvda-worker.ps1, elevated,`
        + " in the interactive session");
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
async function checkFleetConsistency(/** @type {any} */ workers) {
  const guests = [];
  for (const w of workers) {
    try {
      const health = await httpJson(`${w.url}/health`);
      guests.push({ worker: w.url, environment: health.environment, policy: undefined });
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
    "re-provision the odd one out so every worker reports the same browser, screen reader, OS and protocol");
}

// Can this host actually hold the pool it has registered?
//
// Not a fault, and never a FAIL: a capped pool runs fine, just narrower. It is reported because the
// alternative is invisible. Three guests on this 36 GB Mac made every capture 1.6x slower than one
// and produced mute-NVDA failures, and from outside that reads as "the workers are degrading" rather
// than "the host is out of memory" — which is exactly how it was misread for a day.
function checkHostCapacity(/** @type {any} */ pool) {
  const availableMb = availableHostMemoryMb();
  if (availableMb === null || !pool.length) return;
  // Guests already up have paid for their memory and are not counted in `availableMb`, so they are
  // added back — otherwise a running worker makes the host look smaller than it is.
  const running = pool.filter((/** @type {any} */ vm) => vm.state === "started").length;
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

// The single most useful line for anything automated: what to run next. A list of green ticks
// still leaves a caller deciding, and deciding is where they go wrong.
function nextCommand() {
  const broken = checks.find((c) => !c.ok);
  if (!broken) return "npm run training:capture        # starts any stopped worker and releases it after";
  if (broken.name === "contention") return "wait — the pool is busy with another run";
  return broken.fix ?? "see the failing check above";
}

/**
 * Only when RUN, never on import.
 *
 * Every check here probes something real -- it spawns the Python scorer, polls each worker's `/health`,
 * looks for strays on the pages port and reads the run's progress file -- and then calls `process.exit`.
 * So importing this file ran the whole diagnostic against the fleet and then terminated the IMPORTING
 * process with doctor's verdict.
 *
 * A brace-depth scan for dangerous calls at module scope reports this file CLEAN, because the work is one
 * call deeper inside `checkJudge`/`checkWorker`/`checkDatasetPages`. Indirection is that check's blind
 * spot, which is why these guards were placed by reading each file rather than by running a tool over them.
 */
async function main() {
  checkControlPlaneIsolation();
  await checkJudge();
  await checkWorker();
  await checkDatasetPages();
  checkRunState();

  const ready = checks.every((c) => c.ok);

  if (JSON_OUT) {
    console.log(JSON.stringify({ ready, next_command: nextCommand(), checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.advisory ? "DEBT" : c.ok ? "OK  " : "FAIL"}  ${c.name.padEnd(11)} ${c.detail}`);
      if ((!c.ok || c.advisory) && c.fix) console.log(`        fix: ${c.fix}`);
    }
    console.log(`\n${ready ? "READY" : "NOT READY — see the fixes above"}`);
    console.log(`next: ${nextCommand()}`);
  }
  process.exit(ready ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
