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
import { fileURLToPath } from "node:url";

export const DEFAULT_WORKER_PORT = 8765;

const INVENTORY = fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url));
const GROUP_VARS = fileURLToPath(new URL("../ansible/group_vars/a11y_workers.yml", import.meta.url));

/** A line that declares a host address, ignoring anything commented out. */
const HOST_LINE = /^\s*ansible_host\s*:\s*(\S+)\s*$/;
/** Anything that mentions the key but does not parse — a reformat, a quoted value, a list. */
const SUSPECT = /ansible_host\s*:/;

/**
 * Worker URLs from the text of an inventory file.
 *
 * Exported and pure so the strictness above is testable: a reader that has never been shown to reject
 * anything is a reader nobody knows the limits of.
 *
 * @param {string} text
 * @param {{ port?: number }} [options]
 * @returns {string[]}
 */
export function workersFromInventory(text, { port = DEFAULT_WORKER_PORT } = {}) {
  const hosts = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return;
    const match = line.match(HOST_LINE);
    if (match) {
      hosts.push(match[1].replace(/^["']|["']$/g, ""));
      return;
    }
    if (SUSPECT.test(line)) {
      throw new Error(
        `inventory.yml:${index + 1} looks like a host entry but does not parse: ${line.trim()}\n`
        + "This reader understands `ansible_host: <address>` and nothing else, deliberately — a fleet list "
        + "that silently comes up short is invisible, because a run with fewer workers looks normal.");
    }
  });
  if (!hosts.length) {
    throw new Error("no hosts found in inventory.yml. Add one under a11y_workers.hosts before running.");
  }
  return hosts.map((host) => `http://${host}:${port}`);
}

/** The port the group vars declare, so it is stated once and not guessed here. */
export function portFromGroupVars(text) {
  const match = text.match(/^\s*a11y_port\s*:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : DEFAULT_WORKER_PORT;
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

if (import.meta.url === `file://${process.argv[1]}`) main();
