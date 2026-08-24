/**
 * What is every worker doing, right now?
 *
 *     npm run fleet:status
 *     npm run fleet:status -- --json
 *
 * ## Why this exists
 *
 * The request that started this was "switch to webhooks instead of polling for status". The efficiency
 * half of that premise does not survive measurement — a full 1,061-case corpus run makes ~3,192 worker
 * requests in four hours, two thirds of which are the captures themselves — but the half underneath it
 * is exactly right: **you cannot see what your boxes are doing.** `capture-status.mjs` prints one
 * `worker:` line and probes that one worker, even for a twelve-machine pool.
 *
 * So: this IS polling, and calling it anything else would be dishonest. What makes it cheap is that it
 * polls only when a human asks, and that both endpoints it reads are already deployed.
 *
 * ## `/progress` was already there, consumed by nothing
 *
 * Every worker has served `GET /progress` since the day a capture that hung for five minutes could only
 * tell you that it had died. It exposes the in-flight capture's URL, elapsed time and phase marks — free
 * visibility, already on every box, read by no code anywhere in this repo until now. That is why this
 * command needs no worker-side change and therefore no redeploy.
 *
 * ## The two questions it answers that a per-worker curl cannot
 *
 * - **Which box is degrading?** `assessWorker` judges on the RECOVERY RATE, not failures, because the
 *   worker's own retry absorbs faults and `failures` stays 0 while a guest runs at three times the cost
 *   of its neighbours.
 * - **Are these boxes still interchangeable?** `fleetConsistency` compares the fields that are in the
 *   CAPTURE CACHE KEY. A split fleet does not error; it just stops hitting the cache, "which reads as
 *   ordinary churn rather than as a split fleet".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { requestJson } from "./worker-http.mjs";
import { configuredWorkers, workersFromInventory, workerNamesFromInventory, portFromGroupVars }
  from "./fleet-env.mjs";
import { assessWorker } from "./worker-health.mjs";
import { fleetConsistency, describeMismatches } from "./fleet-consistency.mjs";

/** Short: a status table is unreadable if one slow box holds it up. */
const PROBE_TIMEOUT_MS = 5_000;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * The fleet, from the environment if it names one, otherwise from the inventory.
 *
 * Both, because the two are used at different moments: `A11Y_WORKERS` is what a run has set, and the
 * inventory is the durable definition. Falling back rather than requiring the env var means this works
 * in a fresh shell, which is when you most want to ask what the fleet is doing.
 */
export function fleetToProbe() {
  const named = configuredWorkers();
  if (named.length) return named;
  try {
    const inventory = readFileSync(fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url)), "utf8");
    const groupVars = readFileSync(
      fileURLToPath(new URL("../ansible/group_vars/a11y_workers.yml", import.meta.url)), "utf8");
    const port = portFromGroupVars(groupVars);
    // The INVENTORY NAME beside the address, because every command that acts on a worker takes the name
    // (`fleet:deploy --limit=a11y-worker-4`, `fleet:sleep`, `lab:job -e worker=`) while this report showed
    // only the address. On 2026-08-24 that cost a wrong action: this table named .224 as the box whose Edge
    // had drifted, and .224 is a11y-worker-FIVE — so `fleet:sleep --limit=a11y-worker-4` put a healthy
    // machine to sleep and left the drifted one serving. A report and a command that cannot be matched up
    // is a report you have to translate, and translation is where the mistake goes.
    const names = workerNamesFromInventory(inventory, { port });
    return workersFromInventory(inventory, { port })
      .map((url) => ({
        name: names[url] ? `${names[url]}  ${url.replace(/^https?:\/\//, "")}` : url.replace(/^https?:\/\//, ""),
        url,
      }));
  } catch (error) {
    throw new Error(
      "No fleet to report on: A11Y_WORKERS is unset and the inventory could not be read "
      + `(${error.message}). Set one, or add a host to packages/worker-fleet/ansible/inventory.yml.`,
      { cause: error });
  }
}

/**
 * One worker's state, from both endpoints.
 *
 * Unreachable is a RESULT, not a throw: a fleet report whose job is to say which box is missing must not
 * be taken down by the box that is missing.
 */
export async function probeWorker({ name, url }) {
  const ask = async (path) => {
    const response = await requestJson(`${url}${path}`, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json ?? {};
  };
  try {
    // Both at once. Twelve workers probed serially at a 5 s timeout is a minute of staring at nothing.
    const [health, progress] = await Promise.all([ask("/health"), ask("/progress")]);
    return { name, url, reachable: true, health, progress };
  } catch (error) {
    return { name, url, reachable: false, error: error.message ?? String(error) };
  }
}

/** `ready`, `busy`, `warming` or `unreachable` — four states, because collapsing any two loses the point. */
export function stateOf(probe) {
  if (!probe.reachable) return "unreachable";
  if (probe.health?.busy) return "busy";
  // `ready !== false`, matching workerIsUsable: a worker predating the field reports neither, and
  // calling that "warming" forever would be wrong about a perfectly good older guest.
  if (probe.health?.ready === false) return "warming";
  return "ready";
}

/**
 * What a busy worker is actually doing, in one line.
 *
 * **Gated on `busy`, which this function's own comment always claimed and the code never checked.**
 * `/progress` keeps the last capture's record after it finishes, so an IDLE worker reported the case it
 * had already completed — and `elapsedMs` keeps growing, so it presents as a capture that has been stuck
 * for however long the box has been sitting there. Observed: a `ready` worker showing
 * `36m41s @browserKeptAlive` half an hour after its run ended.
 *
 * That is not cosmetic. A long-running phase is precisely the signature this column exists to surface —
 * "a phase current for four minutes is the one that is stuck" — so a stale record is indistinguishable
 * from the fault it was built to detect, and it gets worse the longer the fleet is healthy. The repo's
 * "404 and 202 are different answers" rule, applied to a status display: *finished* and *still going*
 * must never render the same.
 */
export function activityOf(probe) {
  const progress = probe.progress;
  // `progress.busy`, not `health.busy`: `capturing` comes from this same payload, and health and progress
  // are two separate requests, so reading the flag from one and the case from the other samples two
  // different instants. Measured on a11y-worker-2: `{busy: false, capturing: ".../table-unassociated-
  // hilltown/bad.html", elapsedMs: 2526239}` -- 42 minutes after that capture finished, and still climbing.
  if (!progress?.busy) return "";
  if (!progress?.capturing) return "";
  const seconds = Math.round((progress.elapsedMs ?? 0) / MS_PER_SECOND);
  const elapsed = seconds >= SECONDS_PER_MINUTE
    ? `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}s`
    : `${seconds}s`;
  // The phase it is IN is the one after the last completed mark, so the mark's NAME plus its age is what
  // identifies a hang: a phase current for four minutes is the one that is stuck.
  const phase = progress.lastPhase ? ` @${progress.lastPhase}` : "";
  return `${elapsed}${phase}  ${shortUrl(progress.capturing)}`;
}

function shortUrl(url) {
  try {
    const { pathname, host } = new URL(url);
    return `${host}${pathname}`;
  } catch {
    return String(url);
  }
}

/** The per-worker rows, as data, so the renderer and `--json` cannot disagree about what was found. */
export function summarise(probes) {
  return probes.map((probe) => {
    const vitals = probe.health?.vitals ?? null;
    const assessment = assessWorker(vitals);
    return {
      name: probe.name,
      url: probe.url,
      state: stateOf(probe),
      code: probe.health?.code ?? null,
      captures: vitals?.captures ?? null,
      recoveries: vitals?.recoveries ?? null,
      degraded: assessment.degraded,
      degradedReason: assessment.reason,
      activity: activityOf(probe),
      error: probe.error ?? null,
    };
  });
}

function renderTable(rows) {
  const width = (pick) => Math.max(...rows.map((r) => String(pick(r) ?? "").length), 0);
  const nameWidth = Math.max(width((r) => r.name), "worker".length);
  const stateWidth = Math.max(width((r) => r.state), "state".length);

  const lines = [
    `  ${"worker".padEnd(nameWidth)}  ${"state".padEnd(stateWidth)}  ${"code".padEnd(16)}  vitals / doing`,
    `  ${"-".repeat(nameWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(16)}  ${"-".repeat(30)}`,
  ];
  for (const row of rows) {
    const vitals = row.captures === null
      ? (row.error ?? "")
      : `${row.captures} captures, ${row.recoveries} recoveries${row.degraded ? "  DEGRADED" : ""}`;
    lines.push(`  ${row.name.padEnd(nameWidth)}  ${row.state.padEnd(stateWidth)}  `
      + `${String(row.code ?? "-").padEnd(16)}  ${row.activity || vitals}`);
    // A degraded worker still SERVES, so it is a line under the row rather than a state: pulling it
    // from a small pool costs more throughput than it saves, and the run retires it on its own terms.
    if (row.degraded) lines.push(`  ${" ".repeat(nameWidth)}  -> ${row.degradedReason}`);
  }
  return lines;
}

export async function fleetStatus() {
  const workers = fleetToProbe();
  const probes = await Promise.all(workers.map(probeWorker));
  const rows = summarise(probes);
  const guests = probes
    .filter((p) => p.reachable)
    .map((p) => ({ worker: p.url, environment: p.health?.environment, policy: null }));
  const { consistent, mismatches } = fleetConsistency(guests);
  return { rows, consistent, mismatches, reachable: guests.length, total: workers.length };
}

async function main() {
  const status = await fleetStatus();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${renderTable(status.rows).join("\n")}\n\n`);
    // "reachable" said more than it measured. This probes ONE channel — HTTP :8765 — and a worker can serve
    // it perfectly while being unmanageable: on 2026-08-23 all four reported reachable and CONSISTENT while
    // `ansible-playbook deploy.yml` answered UNREACHABLE on every one, because the tailnet ACL grants
    // tcp:8765 and not tcp:22. Nothing here was wrong; the word invited a conclusion it does not support,
    // and an afternoon went into diagnosing a fleet that was healthy.
    process.stdout.write(`  ${status.reachable}/${status.total} serving /health (the capture channel)\n`);
    if (status.reachable === status.total) {
      process.stdout.write("  This says nothing about whether you can DEPLOY to them — that is SSH, and it "
        + "is\n  a separate channel with separate access. `npm run worker:code` compares what they serve\n"
        + "  against this checkout.\n");
    }
    if (status.reachable >= 2) {
      process.stdout.write(status.consistent
        ? "  fleet CONSISTENT — these workers are interchangeable for capture\n"
        : `  fleet INCONSISTENT — ${describeMismatches(status.mismatches).join("; ")}\n`);
    }
  }
  // Exit 1 when nothing answered. Every worker being down is a fault; ONE being down is not, because a
  // run evicts a dead worker and carries on — the same rule doctor applies.
  process.exit(status.reachable === 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
