// @ts-check
/**
 * Refuse a flag this command does not read.
 *
 * Every CLI here parses argv the same way — `process.argv.find((a) => a.startsWith("--only="))` or
 * `process.argv.includes("--resume")` — and every one of them therefore IGNORES anything it does not
 * recognise. A mistyped, renamed or hallucinated flag runs the default and reports success, and the
 * operator believes their value was applied. That is the same defect as an Ansible extra var a job does
 * not read, one layer out, and this repo has paid for it twice:
 *
 *   - a blocker's own message told the reader to run `--write-baseline`; the flag is `--update-baseline`
 *   - `--only=route-title-stale` covered 1 of the 7 cases in that family, because the match was exact-id
 *
 * Neither produced an error. Both produced a plausible wrong answer, which this file's governing rule
 * says to replace with a refusal that names the cause.
 *
 * ## Why the known list is passed in rather than read from the caller's source
 *
 * Deriving it at runtime — reading the calling module and regexing out its `--flags` — needs no
 * maintenance, and is wrong for one reason that matters: a CLI whose flags are consumed by a HELPER in
 * another module would refuse them, so the guard would break exactly the commands with the most moving
 * parts. The list is explicit here and `cli-flags.test.ts` derives the same set from source and pins the
 * two equal, which is this repo's remedy when a duplication is forced.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** How far apart two flags may be and still be worth suggesting. One typo, or one word. */
const NEAR = 4;

/**
 * Levenshtein, small and iterative — the inputs are flag names, never long strings.
 * @param {string} a @param {string} b @returns {number}
 */
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * The flag name alone: `--shard=0/4` and `--shard` both name `--shard`.
 * @param {string} argument @returns {string}
 */
export function nameOf(argument) {
  const equals = argument.indexOf("=");
  return equals === -1 ? argument : argument.slice(0, equals);
}

/**
 * `--name=value`'s value, or `undefined` if `--name=` was never passed. audit §9's "argv parsing" row:
 * VALIDATION is owned here (`refuseUnknownFlags`), but 15+ files each hand-rolled this exact three-line
 * idiom for EXTRACTION, and one of them had already drifted from the rest.
 *
 * MEASURED before writing this, across all fifteen, against five vectors (a normal value, a missing flag,
 * an empty value, a repeated flag, and a value containing its own `=`): fourteen agreed on all five —
 * `argv.find((a) => a.startsWith("--name=")).slice("--name=".length)`, verbatim or with `name` templated
 * in. `fleet-discover.mjs`'s `arg()` used `.split("=")[1]` instead, which is identical on four vectors and
 * silently WRONG on the fifth: `--url=http://host?a=b` came back as `"http://host?a"`, truncated at the
 * value's own `=`. Dormant today — that helper is only ever asked for `--cidr=` and `--port=`, neither of
 * which can contain one — but a live discrepancy the day it is asked for a URL or a `key=value` pair.
 *
 * Kept as `.slice`, matching the fourteen rather than the one, and `fleet-discover.mjs` converted to it.
 *
 * @param {readonly string[]} argv @param {string} name
 * @returns {string | undefined}
 */
export function flagValue(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

/**
 * Which of `argv` are flags this command does not know. PURE, so it is testable without a process.
 *
 * A bare `--` is npm's separator and never a flag. Anything not starting with `-` is positional — a URL,
 * a worker address, a page path — and is not this guard's business.
 *
 * SINGLE-DASH FLAGS ARE INSPECTED TOO, AND THE OMISSION COST A 14-MINUTE FLEET OPERATION.
 *
 * This read `startsWith("--")`, on the reasoning that only long flags are ever this repo's own. But an
 * ANSIBLE-shaped argument is single-dash, and several of these commands wrap `ansible-playbook` — so
 * `npm run fleet:provision -- -e worker_edge_allow_downgrade=true` passed straight through the guard,
 * was never forwarded by the wrapper, and the whole fleet was provisioned WITHOUT the authorisation the
 * operator believed they had given. Measured 2026-09-05. The role then refused, correctly, with a message
 * telling the operator to pass the very flag they had just passed.
 *
 * That is precisely the defect this file exists to prevent — "an ignored flag runs the default and reports
 * success" — surviving inside its own remedy, because the remedy was written to match one flag SHAPE
 * rather than the idea of a flag. `-e` is not a URL and not a page path; nothing positional here begins
 * with a dash followed by a letter, which is what makes this safe to refuse rather than merely warn on.
 */
/**
 * @param {string[]} argv @param {string[]} known @returns {string[]}
 */
export function unknownFlags(argv, known) {
  const accepted = new Set(known.map(nameOf));
  return argv
    .filter((argument) => argument !== "--" && (argument.startsWith("--") || /^-[A-Za-z]/.test(argument)))
    .map(nameOf)
    .filter((flag) => !accepted.has(flag));
}

/**
 * The closest known flag, when there is one close enough to be a likely typo rather than a guess.
 * @param {string} flag @param {string[]} known @returns {string | undefined}
 */
export function didYouMean(flag, known) {
  const ranked = known.map(nameOf)
    .map((candidate) => ({ candidate, gap: distance(flag, candidate) }))
    .sort((left, right) => left.gap - right.gap);
  return ranked[0] && ranked[0].gap <= NEAR ? ranked[0].candidate : undefined;
}

/**
 * Refuse, naming the flag and what this command does take. Exits 2; does not return on failure.
 *
 * `command` names the thing a human typed — the npm script, not the file — because that is what they will
 * retype. Defaults to the script's basename, which is right for the ones invoked directly.
 */
/**
 * @param {string[]} known  Every flag this command reads, `--name` or `--name=`.
 * @param {{entry: string, argv?: string[], command?: string}} options
 *   `entry` is the caller's `import.meta.url`, and it is REQUIRED. `command` names the thing a HUMAN
 *   typed — the npm script, not the file — because that is what they will retype.
 */
// NO `= {}` DEFAULT, because `entry` is required and the docstring above has always said so. A default
// that lets the whole options object be omitted contradicts that: it produces `entry === undefined`, and
// the guard below decides whether THIS module is the command by comparing `entry` against argv[1] -- so a
// caller who forgot it would get a guard that silently never fires. Types found the contradiction the
// moment this file entered the program. Every one of the 60 real call sites passes it.
export function refuseUnknownFlags(known, { entry, argv = process.argv.slice(2), command }) {
  // ONLY WHEN THIS MODULE IS THE COMMAND, never when it is imported.
  //
  // These calls sit at module top level, so they run on IMPORT — and then inspect the IMPORTING process's
  // argv. Measured 2026-08-27, an hour after the guards went in: `capture-real-pages --role=calibration`
  // imports `fleet-env.mjs`, whose guard woke up, saw `--role`, decided it did not know it, and killed a
  // 50-page capture with "unknown flag --role — did you mean --list?". The guard was right about its own
  // flags and asking the wrong process.
  //
  // `entry` is REQUIRED rather than defaulted, for the reason `createHostThrottle`'s `minGapMs` is: a
  // default here would silently restore exactly this behaviour for any caller who forgot it, and the
  // failure mode is a guard that fires on somebody else's command line.
  if (!entry) {
    throw new TypeError("refuseUnknownFlags needs { entry: import.meta.url } — without it the guard runs "
      + "on import and inspects the importing process's flags");
  }
  if (entry !== pathToFileURL(process.argv[1] ?? "").href) return;
  const unknown = unknownFlags(argv, known);
  if (unknown.length === 0) return;
  const name = command ?? basename(process.argv[1] ?? "this command");
  for (const flag of unknown) {
    const near = didYouMean(flag, known);
    console.error(`  ${name}: unknown flag ${flag}${near ? ` — did you mean ${near}?` : ""}`);
  }
  // "It takes: " with nothing after it is what a command taking NO flags printed, and that reads like the
  // guard failed to find its own list rather than like an answer. First hit by `release:provenance`, the
  // first zero-flag CLI here -- the branch existed for months with no caller to exercise it.
  const accepted = [...known].map(nameOf).sort();
  console.error(accepted.length === 0
    ? "  It takes no flags at all."
    : `  It takes: ${accepted.join(" ")}`);
  console.error("  Refusing rather than ignoring it: an ignored flag runs the default and reports success.");
  process.exit(2);
}
