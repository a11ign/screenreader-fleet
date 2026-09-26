// @ts-check
/**
 * `A11Y_WORKERS`, derived from the Ansible inventory — so a machine is added in ONE place.
 *
 *     eval "$(npm run --silent fleet:env)"
 *     npm run fleet:env -- --list        # just the URLs, one per line
 *
 * ## Why derive rather than maintain both
 *
 * The fleet was a comma-separated string in an environment variable, which was fine for two VMs and is the
 * wrong shape for twelve boxes. Ansible needs an inventory regardless, so the choice is not "one format or
 * two" but "one source of truth or two" — and two is how a box comes to be provisioned but never dispatched
 * to, or dispatched to but never updated. Both of those are silent: the run simply never sends that box a
 * case, and nothing reports a machine it does not know about.
 *
 * ## Why this reads the file rather than shelling out to `ansible-inventory`
 *
 * `ansible-inventory --list` is authoritative and would be the better answer if Ansible were always
 * present. It is not: the control plane runs captures, and requiring an Ansible install before a capture
 * run could start would make the fleet tooling a dependency of the thing it exists to serve.
 *
 * ## Strict on purpose
 *
 * A hand-rolled reader for a subset of YAML is exactly the sort of thing that quietly returns four hosts
 * out of twelve after somebody reformats the file — and a SHORT fleet list is invisible, because a run with
 * eight workers looks like a run with eight workers. So this refuses rather than guesses: anything that
 * looks like a host entry but does not parse is an error naming the line, and finding no hosts at all is an
 * error too.
 */
import { readFileSync } from "node:fs";

import { assertWorkerUrl } from "./worker-http.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./cli-flags.mjs";

/**
 * its output is `eval`-ed by a shell, so a wrong shape is executed rather than read.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags(["--list"], { entry: import.meta.url, command: "npm run fleet:env" });

export const DEFAULT_WORKER_PORT = 8765;

/**
 * The fleet named by the environment — ONE parser, because there were three that did not agree.
 *
 * `doctor.mjs` preferred `A11Y_WORKERS`, `check-worker-code.mjs` preferred `A11Y_WORKER`, and the
 * dataset runner read only `A11Y_WORKERS`. With both variables set, `doctor` and `worker:code` reported
 * on **different machines** — so "doctor says the fleet is fine" and "worker:code says a worker is
 * stale" could be statements about two disjoint sets, with nothing to say so.
 *
 * `A11Y_WORKERS` wins, matching the dataset runner: the plural names the pool a run dispatches across,
 * and a diagnostic that describes a different set from the one that will do the work is worse than no
 * diagnostic. Each entry is trimmed and de-slashed, because `A11Y_WORKERS=a, b` otherwise yields a URL
 * with a leading space — a configuration typo wearing a dead-machine costume.
 *
 * Returns `[]` rather than null when neither is set: "no worker was named" is a normal state that means
 * "find the local VMs", and every caller already branches on emptiness.
 *
 * @returns {Array<{ name: string, url: string }>}
 */
export function configuredWorkers() {
  const raw = process.env.A11Y_WORKERS ?? process.env.A11Y_WORKER ?? "";
  const named = process.env.A11Y_WORKERS !== undefined ? "A11Y_WORKERS" : "A11Y_WORKER";
  return raw.split(",")
    .map((w) => w.trim())
    .filter(Boolean)
    // Validated, because this is the ENV route into the same defect the `--worker=` clients now refuse.
    // `A11Y_WORKERS=http://:8765` used to pass straight through to every consumer of this function --
    // `doctor`, `worker:code`, `fleet:status`, the dataset runner -- each of which would then report a
    // machine that cannot be addressed as one that is not answering. Note the empty case is untouched:
    // "no worker was named" is a normal state meaning "find the local VMs", and every caller branches on it.
    .map((url) => assertWorkerUrl(url, { source: named }))
    .map((url) => ({ name: url.replace(/^https?:\/\//, ""), url }));
}

// THE INVENTORY LIVES IN `packages/control`, because it describes the machines the CONTROL PLANE drives
// and it is read by the ansible that runs there. `packages/worker-fleet` is PUBLISHED, and `control` is
// never published (ADR 0012), so this constant is a real cycle -- audit §3.2 -- and NOT the sanctioned
// direction: `control` reaching `worker-fleet` by relative import is fine (control has no
// `node_modules`); this file, reaching back into a package that will not exist in an installed
// `node_modules/@a11ign/worker-fleet`, is what the audit calls "ships code whose data file lives in
// a package that is never published".
//
// FIXED 2026-09-06 by injection, not by moving this module: `doctor.mjs` and `check-worker-code.mjs` are
// PUBLISHED bins that must keep resolving a bare-metal fleet correctly when run as `npm run doctor` from
// this checkout, so the functions below take the path as an optional PARAMETER, defaulting to this
// constant. The default is not a fix in itself -- an installed tarball still ships one that points at a
// package it will never find -- but `inventoryWorkerUrls`/`namedInventoryWorkers` already catch that and
// return `[]`, which is this project's own supported "no bare-metal fleet declared here" answer (see their
// own comments). What injection buys is that the assumption is now a NAMED, overridable default rather
// than a hidden module constant -- a caller outside this monorepo (or a test) can supply its own path
// instead of silently inheriting one that can only ever resolve here.
const INVENTORY = fileURLToPath(new URL("../../control/ansible/inventory.yml", import.meta.url));
const GROUP_VARS = fileURLToPath(new URL("../../control/ansible/group_vars/a11y_workers.yml", import.meta.url));

/** A line that declares a host address, ignoring anything commented out. */
const HOST_LINE = /^\s*ansible_host\s*:\s*(\S+)\s*$/;
/** Anything that mentions the key but does not parse — a reformat, a quoted value, a list. */
const SUSPECT = /ansible_host\s*:/;
/** A mapping key, with or without an inline value. Indentation is the only thing that says where it sits. */
const KEY_LINE = /^(\s*)([A-Za-z_][\w.-]*)\s*:/;
/**
 * A host var declaring whether the host is in the CAPTURE SET. Absent means in: the default is unchanged, so
 * a host that says nothing needs no inventory edit.
 */
const CAPTURE_KEY = "a11y_capture";
const CAPTURE_LINE = new RegExp(`^(\\s*)${CAPTURE_KEY}\\s*:\\s*(\\S+)\\s*$`);
const CAPTURE_SUSPECT = new RegExp(`${CAPTURE_KEY}\\s*:`);

/**
 * The inventory group whose hosts are capture workers.
 *
 * This reader was GROUPLESS until 2026-08-21, and that was a live hazard rather than an untidiness: every
 * `ansible_host:` in the file became `http://<addr>:8765`, so adding any non-worker host to `inventory.yml`
 * -- the lab container, the control container, a switch -- would have silently added a phantom worker to
 * `A11Y_WORKERS`, and a run would have dispatched capture cases to it. That is the exact failure this
 * module's own header says it exists to prevent ("dispatched to but never updated", "both of those are
 * silent"), arriving through the door nobody had shut.
 */
export const WORKER_GROUP = "a11y_workers";

/**
 * One frame of the indentation stack: a key and the column it started at.
 *
 * @typedef {{indent: number, key: string}} Frame
 */

/**
 * A host as the inventory declares it — the ADDRESS and the NAME together.
 *
 * They travel as one value because separating them is what sent `fleet:sleep` at the wrong machine: every
 * tool that ACTS on a worker takes the name, every tool that REPORTS on one printed the address, and
 * nothing mapped between them. `collectHost` explains the incident.
 *
 * `capture` is false for a host that declares `a11y_capture: false`: enrolled, served, deployed to, and not
 * handed corpus cases.
 *
 * @typedef {{name: string|undefined, host: string, capture: boolean}} Host
 */

/**
 * The group a host sits in: the key directly beneath `children`.
 *
 * Ansible nests as `all.children.<group>.hosts.<name>`, so the group is positional rather than something
 * to pattern-match on a name. Reading it from the path means a group added later needs no change here.
 */
/** @param {Array<string|undefined>} path @returns {string|undefined} */
function groupOf(path) {
  const children = path.indexOf("children");
  return children === -1 ? undefined : path[children + 1];
}

/**
 * Track the YAML path by indentation — a stack, not a parser.
 *
 * Deliberately not a YAML library, for the reason the header gives about `ansible-inventory`: the control
 * plane must be able to read the fleet without installing anything. Indentation is sufficient because the
 * only question asked of the path is which group a host is in.
 */
/** @param {Frame[]} stack @param {string} line */
function descend(stack, line) {
  const match = line.match(KEY_LINE);
  if (!match) return;
  const indent = match[1].length;
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  stack.push({ indent, key: match[2] });
}

/**
 * Which group each line of the inventory sits in, index-aligned with `text.split(/\r?\n/)`.
 *
 * Exported so there is ONE group implementation. `fleet-discover.mjs` has its own host reader with its own
 * regexes -- two readers of one file, which this repo's notes call its most expensive recurring shape -- and
 * when this module became group-aware that one did not, so `fleet:discover` probed the lab container on
 * :8765 and reported it "ASLEEP?". A phantom worker in the diagnostic instead of in the dispatch list is
 * still a phantom worker. Rather than teach a second parser about groups, both now ask this.
 *
 * @param {string} text
 * @returns {Array<string | undefined>}
 */
export function groupPerLine(text) {
  /** @type {Frame[]} */
  const stack = [];
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return groupOf(stack.map((f) => f.key));
    if (!HOST_LINE.test(line)) descend(stack, line);
    return groupOf(stack.map((f) => f.key));
  });
}

/**
 * The hosts of one inventory group, each with whether it is in the capture set.
 *
 * ONE reader for both questions ("the whole fleet" and "the capture set"), because a second pass over the
 * file is a second parser, and this repo has paid for that shape already (`fleet-discover.mjs`).
 *
 * @param {string} text
 * @param {string} group
 * @returns {Host[]}
 */
function hostsInGroup(text, group) {
  /** @type {Host[]} */
  const hosts = [];
  /** @type {Frame[]} */
  const stack = [];
  /** @type {Map<string, {capture: boolean, line: number}>} */
  const declared = new Map();
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const match = line.match(HOST_LINE);
    if (match) {
      collectHost(hosts, { match, index, stack, group });
      return;
    }
    if (CAPTURE_SUSPECT.test(line)) {
      readCaptureDeclaration(declared, { line, index, stack });
      return;
    }
    if (SUSPECT.test(line)) {
      throw new Error(
        `inventory.yml:${index + 1} looks like a host entry but does not parse: ${line.trim()}\n`
        + "This reader understands `ansible_host: <address>` and nothing else, deliberately — a fleet list "
        + "that silently comes up short is invisible, because a run with fewer workers looks normal.");
    }
    descend(stack, line);
  });
  if (!hosts.length) {
    throw new Error(`no hosts found under ${group}.hosts in inventory.yml. Add one before running.`);
  }
  return applyCaptureDeclarations(hosts, declared, group);
}

/**
 * Record `a11y_capture: true|false` against the host whose var it is — the nearest enclosing key.
 *
 * Strict for the reason the header gives: `a11y_capture: no` or `"false"` that this reader took for "not
 * declared" would leave a cold host in the capture set, and a capture guard would then refuse the run
 * naming the wrong cause. Only the two literals are read; anything else names its line.
 *
 * @param {Map<string, {capture: boolean, line: number}>} declared
 * @param {{line: string, index: number, stack: Frame[]}} at
 */
function readCaptureDeclaration(declared, { line, index, stack }) {
  const match = line.match(CAPTURE_LINE);
  const value = match?.[2];
  if (value !== "true" && value !== "false") {
    throw new Error(
      `inventory.yml:${index + 1} declares ${CAPTURE_KEY} but not as \`true\` or \`false\`: ${line.trim()}\n`
      + "This reader takes those two literals and nothing else, so a host is never left in or out of the "
      + "capture set by a spelling it did not understand.");
  }
  const indent = /** @type {RegExpMatchArray} */ (match)[1].length;
  const owner = [...stack].reverse().find((frame) => frame.indent < indent)?.key;
  declared.set(owner ?? "", { capture: value === "true", line: index + 1 });
}

/**
 * Attach each declaration to its host, and refuse one that belongs to no host of the group.
 *
 * A declaration on a group or on a host in another group would otherwise be read and dropped, which is the
 * silent shape this module exists to refuse: somebody believes a machine is out of the capture set and it is
 * not.
 *
 * @param {Host[]} hosts
 * @param {Map<string, {capture: boolean, line: number}>} declared
 * @param {string} group
 * @returns {Host[]}
 */
function applyCaptureDeclarations(hosts, declared, group) {
  const names = new Set(hosts.map((host) => host.name));
  for (const [owner, { line }] of declared) {
    if (!names.has(owner)) {
      throw new Error(
        `inventory.yml:${line} declares ${CAPTURE_KEY} on \`${owner}\`, which is not a host in ${group}.\n`
        + `Declare it directly under the host (\`${group}.hosts.<name>.${CAPTURE_KEY}\`); it is not read anywhere else.`);
    }
  }
  return hosts.map((host) => ({ ...host, capture: declared.get(host.name ?? "")?.capture ?? true }));
}

/**
 * Worker URLs from the text of an inventory file.
 *
 * `scope` says which question is asked. `"fleet"` (the default) is every enrolled worker -- what `doctor`,
 * `worker:code`, `fleet:status` and the deploy tooling mean, and they must keep seeing a worker that is
 * serving but not capturing. `"capture"` is the fleet minus every host that declares `a11y_capture: false`
 * -- what `A11Y_WORKERS` means. It is a string and not a flag because a boolean argument does not say
 * which of the two you got.
 *
 * Exported and pure so the strictness above is testable: a reader that has never been shown to reject
 * anything is a reader nobody knows the limits of.
 *
 * @param {string} text
 * @param {{ port?: number, group?: string, scope?: "fleet" | "capture" }} [options]
 * @returns {string[]}
 */
export function workersFromInventory(text, { port = DEFAULT_WORKER_PORT, group = WORKER_GROUP, scope = "fleet" } = {}) {
  const hosts = hostsInGroup(text, group);
  const chosen = scope === "capture" ? hosts.filter((host) => host.capture) : hosts;
  if (!chosen.length) {
    // An empty A11Y_WORKERS means "find the local VMs", which do not exist on the control plane -- so an
    // inventory with every host excluded must fail HERE, naming the cause, not as something unrelated.
    throw new Error(`every host under ${group}.hosts declares ${CAPTURE_KEY}: false, so the capture set is empty.`);
  }
  return chosen.map(({ host }) => `http://${host}:${port}`);
}

/**
 * The hosts left OUT of the capture set, so the command that leaves them out can say so.
 *
 * @param {string} text
 * @param {{ port?: number, group?: string }} [options]
 * @returns {{name: string, url: string}[]}
 */
export function hostsOutOfCaptureSet(text, { port = DEFAULT_WORKER_PORT, group = WORKER_GROUP } = {}) {
  return hostsInGroup(text, group)
    .filter((host) => !host.capture)
    .map(({ name, host }) => ({ name: name ?? host, url: `http://${host}:${port}` }));
}

/**
 * The inventory as `{ url -> name }`, so a report can say which machine a command would act on.
 *
 * Same parser, same group rules — deliberately not a second reader of the same file, which this repo
 * calls its most expensive recurring shape and has already paid for once in `fleet-discover.mjs`.
 *
 * @param {string} text
 * @param {{ port?: number, group?: string }} [options]
 * @returns {Record<string, string>}
 */
export function workerNamesFromInventory(text, { port = DEFAULT_WORKER_PORT, group = WORKER_GROUP } = {}) {
  /** @type {Host[]} */
  const hosts = [];
  /** @type {Frame[]} */
  const stack = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const match = line.match(HOST_LINE);
    if (match) return collectHost(hosts, { match, index, stack, group });
    descend(stack, line);
  });
  // Falls back to the ADDRESS when the inventory nests a host without a name. That cannot happen in a
  // well-formed inventory — Ansible keys hosts by name — but `undefined` reaching a report would print as
  // the string "undefined", which is this repo's worst failure shape: a value that looks like an answer.
  // An address is a worse label than a name and still identifies the machine, which is what this map is for.
  return Object.fromEntries(hosts.map(({ name, host }) => [`http://${host}:${port}`, name ?? host]));
}

/**
 * Keep this host if it is in the worker group; refuse it if it is in no group at all.
 *
 * A host outside every group is the ambiguous case, and it gets an error rather than a default. Including
 * it recreates the phantom-worker bug; dropping it silently is how a fleet list comes up short — and this
 * module exists because both of those are invisible. So it says which line, and which group it expected.
 *
 * @param {Host[]} hosts
 * @param {{match: RegExpMatchArray, index: number, stack: Frame[], group: string}} found
 */
function collectHost(hosts, { match, index, stack, group }) {
  const found = groupOf(stack.map((frame) => frame.key));
  if (found === group) {
    // The inventory NAME comes along with the address. Ansible nests the host as
    // `...hosts.<name>.ansible_host`, so the name is the innermost frame the stack is still holding.
    //
    // Carried because every tool that ACTS on a worker takes the name (`-l a11y-worker-4`) while every
    // tool that REPORTS on one printed only the address — and nothing mapped them. On 2026-08-24 that
    // sent `fleet:sleep` at the wrong machine: `fleet:status` named .224 as the Edge-drifted box, and
    // .224 is a11y-worker-FIVE. Two commands, one fleet, no shared vocabulary.
    hosts.push({ name: stack[stack.length - 1]?.key, host: match[1].replace(/^["']|["']$/g, ""), capture: true });
    return;
  }
  if (found === undefined) {
    throw new Error(
      `inventory.yml:${index + 1} declares a host outside any group: ${match[0].trim()}\n`
      + `This reader takes workers from \`${group}\` only, so it cannot tell whether an ungrouped host is a `
      + "capture worker or something else on the network. Nest it under `all.children.<group>.hosts`.");
  }
}

/** The port the group vars declare, so it is stated once and not guessed here. */
/** @param {string} text @returns {number} */
export function portFromGroupVars(text) {
  const match = text.match(/^\s*a11y_port\s*:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : DEFAULT_WORKER_PORT;
}

/**
 * The workers declared in `inventory.yml` — i.e. the BARE-METAL fleet.
 *
 * Exists so a caller can tell a physical box from a local UTM VM, which decides how it is deployed to and
 * therefore what remedy to print. `worker:code` used to tell every stale worker to run `utmctl` and
 * `npm run worker:deploy`, which CANNOT reach a bare-metal box — it is a `utmctl file push` keyed on a VM
 * UUID and fails immediately off macOS. Following that advice on this fleet wastes the time it takes to
 * discover the tool was describing a different kind of machine.
 *
 * Reads the same file through the same parser as `main()`, rather than a second copy of the knowledge.
 *
 * `inventoryPath`/`groupVarsPath` are INJECTED, defaulting to this monorepo's own control-plane files —
 * see the comment above `INVENTORY` for why the default exists and what it does not fix on its own.
 *
 * @param {{ inventoryPath?: string, groupVarsPath?: string }} [paths]
 */
export function inventoryWorkerUrls({ inventoryPath = INVENTORY, groupVarsPath = GROUP_VARS } = {}) {
  try {
    const port = portFromGroupVars(readFileSync(groupVarsPath, "utf8"));
    return workersFromInventory(readFileSync(inventoryPath, "utf8"), { port });
  } catch {
    // No inventory, or one that does not parse, means "no bare-metal fleet declared here" — a local-VM-only
    // checkout is a supported setup. Rethrowing would make a hint fail the command it is only advising.
    return [];
  }
}

/**
 * The bare-metal fleet as `{name, url}` — the shape a REPORT needs.
 *
 * `fleet-status.mjs` already pairs the two, and its comment records what the address alone cost: "this
 * table named .224 as the box whose Edge had drifted, and .224 is a11y-worker-FIVE — so
 * `fleet:sleep --limit=a11y-worker-4` put a healthy machine to sleep and left the drifted one serving. A
 * report and a command that cannot be matched up is a report you have to translate, and translation is
 * where the mistake goes."
 *
 * Here rather than in each reporter, because that is the same pairing and a second copy would drift.
 *
 * `inventoryPath`/`groupVarsPath` are INJECTED, same reason and same default as `inventoryWorkerUrls`.
 *
 * @param {{ inventoryPath?: string, groupVarsPath?: string }} [paths]
 * @returns {{name: string, url: string}[]} empty when no inventory is declared, like `inventoryWorkerUrls`
 */
export function namedInventoryWorkers({ inventoryPath = INVENTORY, groupVarsPath = GROUP_VARS } = {}) {
  try {
    const port = portFromGroupVars(readFileSync(groupVarsPath, "utf8"));
    const inventory = readFileSync(inventoryPath, "utf8");
    const names = workerNamesFromInventory(inventory, { port });
    return workersFromInventory(inventory, { port })
      .map((url) => ({ name: names[url] ?? url.replace(/^https?:\/\//, ""), url }));
  } catch {
    return [];
  }
}

/**
 * WHICH WORKERS TO USE, AND WHERE THAT LIST CAME FROM — the one precedence, in one place.
 *
 * THREE MODULES HELD THREE DIFFERENT ANSWERS, and one of them carried a comment saying they had been
 * unified. Measured 2026-08-29:
 *
 *   doctor.mjs                        named -> inventory
 *   check-worker-code.mjs             named -> LOCAL UTM POOL -> inventory
 *   capture-screenreader-dataset.mjs  named -> LOCAL UTM POOL -> single-VM lease   (never reads inventory)
 *
 * The corpus capture path's own comment reads "One parser, in fleet-env.mjs. This copy and doctor's and
 * check-worker-code's had drifted apart on precedence, which meant a diagnostic could describe a different
 * fleet from the one about to run." That unification covered the NAMED half only; the fallback order below
 * it stayed three separate answers, so the sentence describes a fix that was half applied.
 *
 * The consequence is the one the comment predicted: on a Mac with any registered UTM guest, `worker:code`
 * reports the local VM while `doctor` reports the five bare-metal boxes, and a capture dispatches to
 * whichever the entry point happened to prefer.
 *
 * ## THE LOCAL UTM POOL IS LAST, and that is a deprecation, not a preference
 *
 * The local guests were a testing arrangement and are deprecated; `inventory.yml` is the fleet, and ADR
 * 0012 already calls it the single source of truth. So the pool is a fallback for a checkout with NO
 * inventory — a supported setup for an outside contributor with one Mac and no hardware — and never a
 * contender with one. Any other order reproduces the divergence above on every Mac that still has a bundle
 * registered.
 *
 * `local` is injected rather than imported: reading the UTM pool means shelling out to `utmctl`, and this
 * module is imported by everything that needs a worker list, including on Linux. A caller that has no
 * local-pool reader simply omits it.
 *
 * @param {{ named?: () => {url: string}[], inventory?: () => string[], local?: () => string[] }} readers
 * @returns {{ urls: string[], source: string }}
 */
export function resolveWorkerPool({
  named = configuredWorkers, inventory = inventoryWorkerUrls, local = () => [],
} = {}) {
  const configured = named();
  // Naming workers means you are managing them — nothing is started or stopped for you — so an explicit
  // list always wins. That half was already consistent everywhere; it is the fallback below that was not.
  if (configured.length) return { urls: configured.map((w) => w.url), source: "A11Y_WORKER(S)" };

  const fleet = inventory();
  if (fleet.length) return { urls: fleet, source: "inventory.yml" };

  const pool = local();
  if (pool.length) return { urls: pool, source: "the local UTM pool (DEPRECATED — see inventory.yml)" };

  // Names what it LOOKED IN, never a bare "nothing found". `lab:inventory`'s rule: "'none here' and 'none
  // anywhere' are different answers, and it now refuses to turn the first into the second."
  return { urls: [], source: "A11Y_WORKER(S), inventory.yml and the local UTM pool — all empty" };
}

/**
 * What `fleet:env` prints, as data: `stdout` is what a shell reads, `stderr` is what the operator reads.
 *
 * `mode: "list"` is the WHOLE fleet, one URL per line, and leaves nobody out. The default is the capture
 * set as an `export`, and it NAMES every host it left out on stderr -- an omission with no line is a
 * machine nothing reports, which is the failure this module's header is about. stderr, because stdout is
 * `eval`-ed.
 *
 * @param {string} text the inventory
 * @param {{ port?: number, mode?: "env" | "list" }} [options]
 * @returns {{stdout: string, stderr: string}}
 */
export function fleetEnvOutput(text, { port = DEFAULT_WORKER_PORT, mode = "env" } = {}) {
  if (mode === "list") {
    return { stdout: `${workersFromInventory(text, { port }).join("\n")}\n`, stderr: "" };
  }
  const workers = workersFromInventory(text, { port, scope: "capture" });
  const stderr = hostsOutOfCaptureSet(text, { port })
    .map(({ name, url }) =>
      `fleet:env: ${name} (${url}) is NOT in A11Y_WORKERS -- its inventory entry declares ${CAPTURE_KEY}: false. `
      + "It is still enrolled: `--list`, `doctor` and `fleet:status` name it.\n")
    .join("");
  // Shell-quoted, so `eval "$(npm run --silent fleet:env)"` is safe even if a hostname ever contains
  // something the shell would otherwise split on.
  return { stdout: `export A11Y_WORKERS='${workers.join(",")}'\n`, stderr };
}

function main() {
  const port = portFromGroupVars(readFileSync(GROUP_VARS, "utf8"));
  const { stdout, stderr } = fleetEnvOutput(readFileSync(INVENTORY, "utf8"),
    { port, mode: process.argv.includes("--list") ? "list" : "env" });
  process.stderr.write(stderr);
  process.stdout.write(stdout);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
