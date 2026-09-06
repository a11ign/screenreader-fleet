/**
 * Audit §9, "the HTTP client": `requestJson` (`worker-http.mjs`) exists specifically because global
 * `fetch` truncates a response silently past undici's ~300 s headers cap (see that file's own header) --
 * so a raw `fetch` reaching a capture worker is a live risk, not merely style. Four call sites were found
 * first. Three had no reason to bypass it and were converted; the fourth talks to a different service
 * (the dataset page server, fetching raw HTML rather than the worker's JSON API) and is EXEMPT, following
 * `fleet-env.mjs`'s own precedent: read each site before converting it, and record a real reason rather
 * than converting on the strength of the pattern alone.
 *
 * A wider sweep of `packages/worker-fleet` then found five MORE raw-`fetch`-to-worker call sites the
 * original audit never named -- reported rather than converted blind, because that package was mid-flight
 * on another unit at the time. All five are converted here, once that collision was gone: three were short
 * probes with the same "no reason to stay raw" shape as the first three, and two
 * (`protocol-guard.mjs`'s `servedProtocols`, `code-drift.mjs`'s `readWorkerCode`) sit on the deploy-guard
 * path and were checked against `control-has-no-dependencies.test.ts` before converting rather than
 * assumed safe, since `code-drift.mjs` exists specifically to be reachable from `packages/control` without
 * an npm dependency (ADR 0012) and its own header used to claim it imported nothing but
 * `node:child_process` -- now corrected, since `requestJson`'s only imports are `node:http`/`node:https`
 * and the guard passes with it in place.
 *
 * A THIRD sweep, tree-wide rather than scoped to `worker-fleet`, found one more:
 * `deploy-worker.mjs`'s `healthCode` -- the UTM VM deploy path's own `/health` probe, missed by both
 * earlier passes because neither was looking at that file. `fetch-wrapper-coverage.test.ts`
 * (`packages/lab/src/packaging/`) is the discovery that now covers the WHOLE tree, not just this package,
 * and is what should be extended the next time a site is found -- this file stays for the per-function
 * precision the tree-wide sweep does not need (it checks presence/absence of `fetch(` inside the exact
 * function that was converted, not merely that the file changed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relPath: string) => readFileSync(`${REPO}${relPath}`, "utf8");

const EXEMPT = {
  file: "packages/lab/src/training/capture-screenreader-dataset.mjs",
  reason: "fetches the dataset page server's raw HTML for a title check, not the worker's JSON API",
};

/**
 * The exact function(s) converted, per file -- checked by NAME rather than by the shape of a fetch call,
 * because the shape alone cannot tell "the worker's JSON API" from "the dataset page server": `doctor.mjs`
 * fetches BOTH, a few hundred lines apart, with `fetch(<url>, { signal: AbortSignal.timeout(...) })` in
 * both places. Only the worker one was converted; the page-server probe at `doctor.mjs:423` is the same
 * kind of legitimate exception as the EXEMPT entry below and out of scope for this guard.
 */
const CONVERTED_FUNCTIONS: Record<string, string[]> = {
  "packages/worker-fleet/src/doctor.mjs": ["httpJson"],
  "packages/lab/src/training/capture-status.mjs": ["workerState"],
  "packages/lab/src/harnesses/capture-check.mjs": ["workerIsServing"],
  "packages/worker-fleet/src/protocol-guard.mjs": ["servedProtocols"],
  "packages/worker-fleet/src/compare-workers.mjs": ["diagnostics", "vitals"],
  "packages/worker-fleet/src/check-worker-code.mjs": ["versionOf"],
  "packages/worker-fleet/src/code-drift.mjs": ["readWorkerCode"],
  "packages/worker-fleet/src/deploy-worker.mjs": ["healthCode"],
};

function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\bfunction ${name}\\(`));
  assert.ok(start >= 0, `could not find "function ${name}(" -- the function was renamed or removed, `
    + "which this guard needs to know about rather than silently checking nothing");
  // Up to the next top-level function/export, or end of file -- good enough for a single-function scope.
  const rest = source.slice(start + 1);
  const nextTop = rest.search(/\n(export )?(async )?function /);
  return rest.slice(0, nextTop === -1 ? undefined : nextTop);
}

test("every converted call site no longer bypasses requestJson for a worker endpoint", () => {
  const stillRaw: string[] = [];
  for (const [file, names] of Object.entries(CONVERTED_FUNCTIONS)) {
    const source = read(file);
    for (const name of names) {
      if (/\bfetch\(/.test(functionBody(source, name))) stillRaw.push(`${file} :: ${name}()`);
    }
  }
  assert.deepEqual(stillRaw, [], `these functions still contain a raw fetch(:\n${stillRaw.join("\n")}`);
  const missingImport = Object.keys(CONVERTED_FUNCTIONS).filter((file) => !/requestJson/.test(read(file)));
  assert.deepEqual(missingImport, [],
    `these files no longer import requestJson at all -- either the conversion regressed or the file `
    + `changed shape:\n${missingImport.join("\n")}`);
});

test("the one exempt call site is still raw fetch, and still says why", () => {
  const text = read(EXEMPT.file);
  assert.match(text, /\bfetch\(/, `${EXEMPT.file} no longer calls fetch( at all -- if it was converted, `
    + "delete this EXEMPT entry rather than leaving a stale one");
  assert.match(text, /EXEMPT from audit §9/,
    `${EXEMPT.file} carries a raw fetch( with no EXEMPT comment explaining why -- restore the reason, `
    + "which the audit could otherwise not tell from an oversight");
});
