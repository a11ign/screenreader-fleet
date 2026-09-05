/**
 * Audit §9, "the HTTP client": `requestJson` (`worker-http.mjs`) exists specifically because global
 * `fetch` truncates a response silently past undici's ~300 s headers cap (see that file's own header) --
 * so a raw `fetch` reaching a capture worker is a live risk, not merely style. Four call sites were found
 * bypassing it. Three had no reason to and are converted here; the fourth talks to a different service
 * (the dataset page server, fetching raw HTML rather than the worker's JSON API) and is EXEMPT, following
 * `fleet-env.mjs`'s own precedent: read each site before converting it, and record a real reason rather
 * than converting on the strength of the pattern alone.
 *
 * Scoped to exactly the four sites the audit named, not a general repo-wide scan: a wider sweep found
 * several MORE raw-`fetch`-to-worker call sites in `packages/worker-fleet` (`protocol-guard.mjs`,
 * `compare-workers.mjs` twice, `check-worker-code.mjs`, `code-drift.mjs`) that this unit did not touch,
 * reported separately rather than converted blind or silently absorbed into this guard's scope.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relPath: string) => readFileSync(`${REPO}${relPath}`, "utf8");

const CONVERTED = [
  "packages/worker-fleet/src/doctor.mjs",
  "packages/lab/src/training/capture-status.mjs",
  "packages/lab/src/harnesses/capture-check.mjs",
];

const EXEMPT = {
  file: "packages/lab/src/training/capture-screenreader-dataset.mjs",
  reason: "fetches the dataset page server's raw HTML for a title check, not the worker's JSON API",
};

/**
 * The exact function this unit converted, per file -- checked by NAME rather than by the shape of a
 * fetch call, because the shape alone cannot tell "the worker's JSON API" from "the dataset page server":
 * `doctor.mjs` fetches BOTH, a few hundred lines apart, with `fetch(<url>, { signal:
 * AbortSignal.timeout(...) })` in both places. Only the worker one was converted; the page-server probe
 * at `doctor.mjs:423` is the same kind of legitimate exception as the EXEMPT entry below and out of scope
 * for this guard.
 */
const CONVERTED_FUNCTION: Record<string, string> = {
  "packages/worker-fleet/src/doctor.mjs": "httpJson",
  "packages/lab/src/training/capture-status.mjs": "workerState",
  "packages/lab/src/harnesses/capture-check.mjs": "workerIsServing",
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

test("the three converted call sites no longer bypass requestJson for a worker endpoint", () => {
  const stillRaw = CONVERTED.filter((file) => /\bfetch\(/.test(functionBody(read(file), CONVERTED_FUNCTION[file])));
  assert.deepEqual(stillRaw, [],
    `these functions still contain a raw fetch(:\n${stillRaw.map((f) => `${f} :: ${CONVERTED_FUNCTION[f]}()`).join("\n")}`);
  const missingImport = CONVERTED.filter((file) => !/requestJson/.test(read(file)));
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
