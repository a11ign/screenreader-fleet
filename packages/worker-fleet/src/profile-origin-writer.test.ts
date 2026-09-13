/**
 * row 1201: PROVISIONING WRITES THE ADOPTION RECORD, BECAUSE ONLY PROVISIONING KNOWS IT.
 *
 * `browser-profile.mjs` decides whether an Edge profile was adopted or created fresh. Before row 1201
 * that rested entirely on the presence of Edge's own `Local State` file: if Edge stopped writing it,
 * every profile would read as FRESH, the capture cache key would move, and nothing would say so — the
 * failure mode and the ordinary answer are the same absence.
 *
 * THE WORKER CANNOT WRITE THE RECORD, which is why this task exists rather than a line in the worker.
 * Nothing in `packages/nvda-worker` creates the profile directory — Edge does, on first run — so at a
 * profile's first encounter the only evidence available to the worker IS `Local State`. A worker writing
 * the record would be recording that inference and reading it back later as a fact: one witness wearing
 * the appearance of two.
 *
 * `win_file` is the one place the answer exists, because it reports `changed` when it CREATED the
 * directory. The fact is read from the action that established it, not inferred afterwards from a tree.
 *
 * ASSERTED AGAINST THE PARSED YAML, never a text search of the file. A grep would match the words in
 * this repository's own comments — the defect `stripComments` was added for one row over, and a task
 * file has no comment-stripping equivalent, so the parse IS the remedy here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// BY RELATIVE PATH to the source, never the package import -- `browsers.mjs` is not in the package's
// `exports` map, and importing the PUBLISHED package would resolve to a `dist` that can be stale
// against this worktree. The same technique, for the same reason, as `fault-remediation.test.ts`.
import { BROWSERS, browserProfileDir } from "../../nvda-worker/src/browsers.mjs";

const BESPOKE = fileURLToPath(
  new URL("../../control/ansible/roles/worker/tasks/bespoke.yml", import.meta.url));

/** The literal words, planted rather than imported — see this file's sibling clause for why. */
const ORIGIN_FILE = ".a11y-profile-origin";
const ADOPTED = "adopted-existing";
const FRESH = "created-fresh";

function tasks(): BespokeTask[] {
  return parse(readFileSync(BESPOKE, "utf8")) as BespokeTask[];
}

/** The shape this file asserts on. Typed rather than `any`: an `any` cast has hidden a filter on a
 * field nobody fetched in this repository before, and these assertions are exactly field reads. */
type WinCopy = { dest?: string; content?: string; force?: boolean };
type BespokeTask = {
  "ansible.windows.win_copy"?: WinCopy;
  register?: string;
  loop?: string;
};

function writerTask(): BespokeTask {
  const found = tasks().filter((t) => JSON.stringify(t["ansible.windows.win_copy"] ?? "").includes(ORIGIN_FILE));
  // POSITIVE CONTROL: a file that stopped parsing and a file with no writer produce the same empty list.
  assert.equal(found.length, 1,
    `expected exactly one task writing ${ORIGIN_FILE}; found ${found.length} across ${tasks().length} `
    + "parsed tasks. Zero with a non-zero task count means the writer is gone; zero tasks means the YAML "
    + "stopped parsing, and those are different failures");
  return found[0];
}

test("row 1201 clause 1: provisioning writes the origin record, and does so from win_file's own result", () => {
  const copy = writerTask()["ansible.windows.win_copy"] ?? {};
  assert.match(String(copy.content), new RegExp(FRESH),
    "the fresh case must be written by its literal name");
  assert.match(String(copy.content), new RegExp(ADOPTED),
    "and so must the adopted case, or one branch records nothing");
  // THE FACT MUST COME FROM THE ACTION THAT ESTABLISHED IT. `item.changed` is win_file reporting that it
  // CREATED the directory. Deriving it from the tree instead -- "does Local State exist" -- would be the
  // circularity this whole row exists to avoid, written in YAML.
  assert.match(String(copy.content), /item\.changed/,
    "the record must be conditioned on win_file's `changed`, not on anything read back from disk");
});

test("row 1201 clause 2 (MUTATION TARGET): the record is written ONCE and never revised", () => {
  const copy = writerTask()["ansible.windows.win_copy"] ?? {};
  // `force: false` is load-bearing, not tidiness. Provisioning re-runs routinely, and on the second run
  // the directory exists BECAUSE THE FIRST RUN MADE IT -- so an overwrite would relabel a `created-fresh`
  // profile as `adopted-existing`, promoting cold evidence to warm. This is the assertion that turns red
  // if someone deletes the flag as noise.
  assert.equal(copy.force, false,
    "win_copy without `force: false` overwrites on every provisioning run, and the second run sees a "
    + "directory the FIRST run created -- so the record would flip to adopted-existing and a cold "
    + "profile would be reported as carrying the corpus's own evidence");
});

test("row 1201 clause 3: the directory task still registers the result the writer consumes", () => {
  // The two tasks are coupled: the writer reads `profile_dirs.results`. A rename of the register, or its
  // removal, leaves the writer looping over nothing -- which Ansible does silently, writing no file and
  // failing nothing. That is this repository's own "a reference without a consumer", inverted.
  const all = tasks();
  const dirTask = all.find((t) => t["register"] === "profile_dirs");
  assert.ok(dirTask, "no task registers `profile_dirs`, so the writer below loops over nothing and "
    + "writes no file -- silently, because a loop over an undefined result is not an error");
  const copy = writerTask();
  assert.match(String(copy["loop"]), /profile_dirs\.results/,
    "the writer must consume the register the directory task produces");
});

/**
 * row 1201: THE WRITER'S DESTINATION AND THE READER'S PATH ARE ONE FACT, PINNED HERE.
 *
 * `worker-judge` found them written twice with nothing comparing them — the shape this repository files
 * more than any other, inside the fix for a row about a single witness. **If they disagree, nothing
 * fails.** Every guest takes the no-record path, `USED_MARKER` stays the sole witness, and the behaviour
 * is byte-identical to not having shipped this at all: the fix's failure mode is indistinguishable from
 * its absence, which is the defect row 1201 exists to remove, reproduced in its own remedy.
 *
 * DERIVED FROM `browserProfileDir` ITSELF, not retyped. Driving the real function is what makes this a
 * comparison rather than a second copy: a rename of `profileName`, or a change to how the directory is
 * composed, fails here rather than on a guest three weeks later.
 */
test("row 1201 clause 4: the writer's dest IS the path the reader reads", () => {
  const copy = writerTask()["ansible.windows.win_copy"] ?? {};
  const before = process.env.LOCALAPPDATA;
  try {
    // A sentinel rather than a realistic value: if the substitution below silently failed, a realistic
    // root could still match by accident. This one cannot appear for any other reason.
    process.env.LOCALAPPDATA = "%LOCALAPPDATA%";
    for (const browser of [BROWSERS.edge, BROWSERS.chrome]) {
      const expected = `${browserProfileDir(browser)}\\${ORIGIN_FILE}`;
      const actual = String(copy.dest).replace("{{ item.item }}", browser.profileName);
      assert.equal(actual, expected,
        `the writer puts the record at ${actual} and the worker reads it from ${expected}. Two spellings `
        + "of one path: if they diverge nothing fails, every profile falls back to the marker, and the "
        + "behaviour is identical to not having shipped this row");
    }
  } finally {
    process.env.LOCALAPPDATA = before;
  }
});

test("row 1201 clause 5: the writer targets the directory the task above creates", () => {
  // The two Ansible tasks are also two copies. Pinning them removes the in-file drift independently of
  // the reader comparison above -- if the directory task's path changes, this fails whether or not
  // `browsers.mjs` moved with it.
  const all = tasks();
  const dirTask = all.find((t) => t["register"] === "profile_dirs");
  const dirPath = String((dirTask as { "ansible.windows.win_file"?: { path?: string } })
    ?.["ansible.windows.win_file"]?.path);
  const copy = writerTask()["ansible.windows.win_copy"] ?? {};
  // NORMALISED, because the same value is spelled differently in the two contexts and that difference is
  // correct: the directory task loops the bare list, so its variable is `item`; the writer loops the
  // REGISTERED RESULTS, where the original list entry is `item.item`. Comparing the raw strings asserts
  // a sameness that was never true -- my first version of this clause did, and failed on the difference
  // it should have been normalising. Everything OUTSIDE that expression must still match exactly.
  const normalise = (p: string) => p.replace("{{ item.item }}", "{{ item }}");
  assert.equal(normalise(String(copy.dest)), `${normalise(dirPath)}\\${ORIGIN_FILE}`,
    "the record must land inside the directory the task above created, spelled the same way -- these are "
    + "two lines in one file and drift between them is a one-character edit nothing else catches");
});
