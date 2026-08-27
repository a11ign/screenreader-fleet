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
refuseUnknownFlags(["--list"], { command: "npm run fleet:env" });

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

const INVENTORY = fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url));
const GROUP_VARS = fileURLToPath(new URL("../ansible/group_vars/a11y_workers.yml", import.meta.url));

/** A line that declares a host address, ignoring anything commented out. */
const HOST_LINE = /^\s*ansible_host\s*:\s*(\S+)\s*$/;
/** Anything that mentions the key but does not parse — a reformat, a quoted value, a list. */
const SUSPECT = /ansible_host\s*:/;
/** A mapping key, with or without an inline value. Indentation is the only thing that says where it sits. */
const KEY_LINE = /^(\s*)([A-Za-z_][\w.-]*)\s*:/;

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
 * The group a host sits in: the key directly beneath `children`.
 *
 * Ansible nests as `all.children.<group>.hosts.<name>`, so the group is positional rather than something
 * to pattern-match on a name. Reading it from the path means a group added later needs no change here.
 */
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
  const stack = [];
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return groupOf(stack.map((f) => f.key));
    if (!HOST_LINE.test(line)) descend(stack, line);
    return groupOf(stack.map((f) => f.key));
  });
}

/**
 * Worker URLs from the text of an inventory file.
 *
 * Exported and pure so the strictness above is testable: a reader that has never been shown to reject
 * anything is a reader nobody knows the limits of.
 *
 * @param {string} text
 * @param {{ port?: number, group?: string }} [options]
 * @returns {string[]}
 */
export function workersFromInventory(text, { port = DEFAULT_WORKER_PORT, group = WORKER_GROUP } = {}) {
  const hosts = [];
  const stack = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const match = line.match(HOST_LINE);
    if (match) {
      collectHost(hosts, { match, index, stack, group });
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
  return hosts.map(({ host }) => `http://${host}:${port}`);
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
  const hosts = [];
  const stack = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const match = line.match(HOST_LINE);
    if (match) return collectHost(hosts, { match, index, stack, group });
    descend(stack, line);
  });
  return Object.fromEntries(hosts.map(({ name, host }) => [`http://${host}:${port}`, name]));
}

/**
 * Keep this host if it is in the worker group; refuse it if it is in no group at all.
 *
 * A host outside every group is the ambiguous case, and it gets an error rather than a default. Including
 * it recreates the phantom-worker bug; dropping it silently is how a fleet list comes up short — and this
 * module exists because both of those are invisible. So it says which line, and which group it expected.
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
    hosts.push({ name: stack[stack.length - 1]?.key, host: match[1].replace(/^["']|["']$/g, "") });
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
 */
export function inventoryWorkerUrls() {
  try {
    const port = portFromGroupVars(readFileSync(GROUP_VARS, "utf8"));
    return workersFromInventory(readFileSync(INVENTORY, "utf8"), { port });
  } catch {
    // No inventory, or one that does not parse, means "no bare-metal fleet declared here" — a local-VM-only
    // checkout is a supported setup. Rethrowing would make a hint fail the command it is only advising.
    return [];
  }
}

function main() {
  const port = portFromGroupVars(readFileSync(GROUP_VARS, "utf8"));
  const workers = workersFromInventory(readFileSync(INVENTORY, "utf8"), { port });
  if (process.argv.includes("--list")) {
    process.stdout.write(`${workers.join("\n")}\n`);
    return;
  }
  // Shell-quoted, so `eval "$(npm run --silent fleet:env)"` is safe even if a hostname ever contains
  // something the shell would otherwise split on.
  process.stdout.write(`export A11Y_WORKERS='${workers.join(",")}'\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
