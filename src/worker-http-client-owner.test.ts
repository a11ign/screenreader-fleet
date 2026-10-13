// Relocated from control/src/fleet-layer/worker-http-client-owner.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * Audit §9, "the HTTP client": `requestJson` (`worker-http.ts`) exists specifically because global
 * `fetch` truncates a response silently past undici's ~300 s headers cap (see that file's own header) --
 * so a raw `fetch` reaching a capture worker is a live risk, not merely style. Four call sites were found
 * first. Three had no reason to bypass it and were converted; the fourth talks to a different service
 * (the dataset page server, fetching raw HTML rather than the worker's JSON API) and is EXEMPT: read each
 * site before converting it, and record a real reason rather than converting on the strength of the
 * pattern alone.
 *
 * A wider sweep then found MORE raw-`fetch`-to-worker call sites the original audit never named. Some were
 * short probes with the same "no reason to stay raw" shape as the first three, and two
 * (`protocol-guard.ts`'s `servedProtocols`, `code-drift.ts`'s `readWorkerCode`) sit on the deploy-guard
 * path and were checked against the control plane's no-dependency guard before converting rather than
 * assumed safe, since `code-drift` exists specifically to be reachable from the control plane without an
 * npm dependency (ADR 0012) and `requestJson`'s only imports are `node:http`/`node:https`.
 *
 * This file keeps the per-function precision a tree-wide sweep does not need: it checks presence/absence of
 * `fetch(` inside the exact function that was converted, not merely that the file changed. It covers the
 * functions THIS package owns; the call sites in the lab and the dataset-page-server exemption are checked
 * where they live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (file: string) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");

/**
 * The exact function(s) converted, per file -- checked by NAME rather than by the shape of a fetch call,
 * because the shape alone cannot tell "the worker's JSON API" from "the dataset page server": `doctor.ts`
 * fetches BOTH, a few hundred lines apart, with `fetch(<url>, { signal: AbortSignal.timeout(...) })` in
 * both places. Only the worker one was converted; the page-server probe (`checkDatasetPages`) is a
 * legitimate exception -- it fetches raw HTML, not the worker's JSON API -- and out of scope for this guard.
 */
const CONVERTED_FUNCTIONS: Record<string, string[]> = {
  "doctor.ts": ["httpJson"],
  "protocol-guard.ts": ["servedProtocols"],
  "compare-workers.ts": ["diagnostics", "vitals"],
  "check-worker-code.ts": ["versionOf"],
  "code-drift.ts": ["readWorkerCode"],
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

const callsRawFetch = (source: string, name: string): boolean => /\bfetch\(/.test(functionBody(source, name));

test("every converted call site no longer bypasses requestJson for a worker endpoint", () => {
  const stillRaw: string[] = [];
  for (const [file, names] of Object.entries(CONVERTED_FUNCTIONS)) {
    const source = read(file);
    for (const name of names) {
      if (callsRawFetch(source, name)) stillRaw.push(`${file} :: ${name}()`);
    }
  }
  assert.deepEqual(stillRaw, [], `these functions still contain a raw fetch(:\n${stillRaw.join("\n")}`);
  const missingImport = Object.keys(CONVERTED_FUNCTIONS).filter((file) => !/requestJson/.test(read(file)));
  assert.deepEqual(missingImport, [],
    `these files no longer import requestJson at all -- either the conversion regressed or the file `
    + `changed shape:\n${missingImport.join("\n")}`);
});

test("positive control: the detector sees a raw fetch inside the named function and only there", () => {
  // Without this the test above passes whether or not `callsRawFetch` can see anything at all.
  const source = [
    "async function probe(url) {",
    "  return await fetch(url);",
    "}",
    "async function other(url) {",
    "  return await requestJson(url);",
    "}",
    "export function tail() {",
    "  return fetch('x');",
    "}",
  ].join("\n");
  assert.equal(callsRawFetch(source, "probe"), true);
  assert.equal(callsRawFetch(source, "other"), false, "a fetch( in the NEXT function is not this function's");
  assert.throws(() => callsRawFetch(source, "gone"), /could not find "function gone\("/);
});

test("the converted-function list names functions that exist, so the guard cannot go vacuous", () => {
  const total = Object.values(CONVERTED_FUNCTIONS).flat().length;
  assert.ok(total >= 6, `only ${total} converted functions are listed; the list was emptied, not the codebase fixed`);
  for (const [file, names] of Object.entries(CONVERTED_FUNCTIONS)) {
    for (const name of names) assert.ok(functionBody(read(file), name).length > 0, `${file} :: ${name}`);
  }
});
