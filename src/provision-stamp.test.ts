// Relocated from packages/worker-fleet/src/provision-stamp.test.ts by a11ign#5350 (the fleet-owned half).
// `provisionRevision` is a capture cache key AND a `fleet-consistency` MUST_MATCH field, compared for
// EQUALITY and never parsed. So anything that can move it for a reason unrelated to the guest's NVDA/Edge
// configuration is a fleet split with no operator remedy -- re-provisioning a box recomputes the same
// value, so the box cannot be converged, only reimaged.
//
// The script is PowerShell and cannot be executed from this host, so these assert on its SOURCE. That is
// normally this repo's own anti-pattern ("a test must not derive its expectations from source TEXT"), and
// the exception is deliberate and narrow: there is no Windows here, the alternative is reimplementing the
// hash in TypeScript, and a second implementation of a cache key is the fact-stated-twice defect in its
// most expensive form -- two spellings that agree until they do not.
//
// The core's copy of this test calls `stampEnvironmentFiles` from the core's own `scripts/test-support`. That
// file is not in this package, so the `$ENVIRONMENT_FILES` list is resolved here by hand: the variables the
// script assigns, then the array's own entries, terminated on a line-initial `)`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STAMP = readFileSync(fileURLToPath(new URL("./provisioning/stamp-provision-revision.ps1", import.meta.url)), "utf8");

/** `$NAME` references inside a double-quoted PowerShell string, replaced with the value the script assigned. */
function interpolate(text: string, variables: Map<string, string>): string {
  return text.replace(/\$(\w+)/g, (whole, name: string) => variables.get(name) ?? whole);
}

/** Every `$NAME = '...'` or `$NAME = "..."` assignment, in order, with double-quoted values interpolated. */
function scriptVariables(source: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const m of source.matchAll(/^\$(\w+)\s*=\s*(['"])(.*)\2\s*$/gm)) {
    variables.set(m[1], m[2] === '"' ? interpolate(m[3], variables) : m[3]);
  }
  return variables;
}

/**
 * The entries of `$ENVIRONMENT_FILES`, in order. Comment lines are skipped, and an entry that is a bare
 * `$VARIABLE` is resolved. The array ends at the first LINE-INITIAL `)`: a parenthesis inside a comment in
 * the array must not truncate it, or a present entry looks absent.
 */
function hashedEnvironmentFiles(source: string): string[] {
  const variables = scriptVariables(source);
  const start = source.indexOf("$ENVIRONMENT_FILES = @(");
  const end = source.slice(start).search(/^\)\s*$/m);
  assert.ok(start >= 0 && end > 0, "the $ENVIRONMENT_FILES array was not found; this test can no longer read the list");
  const body = source.slice(start + "$ENVIRONMENT_FILES = @(".length, start + end);
  const entries: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const quoted = /^(['"])(.*)\1$/.exec(line);
    if (quoted) entries.push(quoted[1] === '"' ? interpolate(quoted[2], variables) : quoted[2]);
    else if (/^\$\w+$/.test(line)) entries.push(variables.get(line.slice(1)) ?? line);
  }
  return entries;
}

test("the stamp hashes NORMALISED text, never raw bytes", () => {
  // Measured 2026-09-04: with `Get-FileHash` the same four blobs at one commit stamped dbb7d33409a9341d
  // from a CRLF checkout and 1052b80ca42398c7 from an LF one. Windows git converts to CRLF by default and
  // this repo has no `.gitattributes`, so which one a box got was a per-machine git setting nobody sets.
  assert.match(STAMP, /\[IO\.File\]::ReadAllText\(\$full\)\s*-replace\s*"`r`n",\s*"`n"/,
    "the stamp no longer normalises line endings before hashing, so it keys on how git checked the files "
    + "out. A box cloned with a different core.autocrlf reads INCONSISTENT for ever and re-provisioning "
    + "cannot converge it.");

  // The specific regression: reverting to the byte-level API. Checked against the HASHING LOOP rather than
  // the whole file, because the comment above it names `Get-FileHash` to explain what was wrong.
  const loop = STAMP.slice(STAMP.indexOf("$hashes = foreach"), STAMP.indexOf("$bytes ="));
  assert.ok(loop.length > 0, "the hashing loop has been restructured; this test can no longer find it");
  assert.doesNotMatch(loop, /Get-FileHash/,
    "the hashing loop hashes file BYTES again. That is the line-ending dependency returning.");
});

test("the FIVE hashed files are exactly the environment, and the list has not drifted", () => {
  // Adding a file here invalidates every cached capture, and REMOVING one silently stops the stamp
  // describing something a capture can observe -- which is the failure the script's own header records
  // ("all three paths vanished at once and $combined silently fell back to 'unknown'").
  //
  // FOUR BECAME FIVE ON 2026-09-05, deliberately, and this guard is what made it deliberate: it failed,
  // named the cost, and the list was updated as an act rather than a side effect. `a11y_speech_viewer.ps1`
  // writes `showSpeechViewerAtStartup`, which its own header calls "the highest-value setting on a worker
  // and the one that fails most quietly" -- with it ON, every interaction probe returns "NVDA Speech
  // Viewer" instead of the page's response, so a whole corpus is captured complete and wrong.
  //
  // The two launcher entries are the worker's published files (`@a11ign/screenreader-worker`), resolved from
  // this package's node_modules as the stamp resolves them. Their DIRECTORY is not asserted to exist: the
  // installed worker 0.9.0 does not ship a `launcher/` directory, and an existence check would fail on the
  // published layout rather than on a real drift. The list itself is what this test pins.
  assert.deepEqual(hashedEnvironmentFiles(STAMP), [
    "node_modules/@a11ign/screenreader-fleet/src/provisioning/provision-nvda-worker.ps1",
    "node_modules/@a11ign/screenreader-worker/launcher/run-server.cmd",
    "node_modules/@a11ign/screenreader-worker/launcher/apply-foreground-lock-timeout.ps1",
    "packages/control/ansible/roles/worker/defaults/main.yml",
    "packages/control/ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_speech_viewer.ps1",
  ], "the hashed-file list changed. That moves provisionRevision on every box, which is a full recapture — "
     + "intended or not, it must be a deliberate act rather than a side effect of moving a file.");
});

test("a missing file THROWS rather than being filtered out", () => {
  // The script's header records why: a previous version dropped missing paths with `Where-Object { $_ }`,
  // so a repo restructure removed all three at once and the stamp quietly became a constant.
  assert.match(STAMP, /throw "provision stamp:/,
    "a missing environment file no longer throws, so the stamp can silently describe less than it claims");
});
