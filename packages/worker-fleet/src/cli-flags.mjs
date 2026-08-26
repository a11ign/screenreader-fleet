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

/** How far apart two flags may be and still be worth suggesting. One typo, or one word. */
const NEAR = 4;

/** Levenshtein, small and iterative — the inputs are flag names, never long strings. */
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

/** The flag name alone: `--shard=0/4` and `--shard` both name `--shard`. */
export function nameOf(argument) {
  const equals = argument.indexOf("=");
  return equals === -1 ? argument : argument.slice(0, equals);
}

/**
 * Which of `argv` are flags this command does not know. PURE, so it is testable without a process.
 *
 * A bare `--` is npm's separator and never a flag. Anything not starting with `--` is positional — a URL,
 * a worker address, a page path — and is not this guard's business.
 */
export function unknownFlags(argv, known) {
  const accepted = new Set(known.map(nameOf));
  return argv
    .filter((argument) => argument.startsWith("--") && argument !== "--")
    .map(nameOf)
    .filter((flag) => !accepted.has(flag));
}

/** The closest known flag, when there is one close enough to be a likely typo rather than a guess. */
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
export function refuseUnknownFlags(known, { argv = process.argv.slice(2), command } = {}) {
  const unknown = unknownFlags(argv, known);
  if (unknown.length === 0) return;
  const name = command ?? basename(process.argv[1] ?? "this command");
  for (const flag of unknown) {
    const near = didYouMean(flag, known);
    console.error(`  ${name}: unknown flag ${flag}${near ? ` — did you mean ${near}?` : ""}`);
  }
  console.error(`  It takes: ${[...known].map(nameOf).sort().join(" ")}`);
  console.error("  Refusing rather than ignoring it: an ignored flag runs the default and reports success.");
  process.exit(2);
}
