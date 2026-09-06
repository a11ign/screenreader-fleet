/**
 * architecture-audit.md §5's last open item: at least one capture client built its `POST /capture` body
 * by hand instead of through one place, so a new wire field could reach some clients and not others —
 * "a fix applied at ONE call site when the behaviour reaches several", this repo's most expensive
 * recurring shape.
 *
 * ## What was measured before deciding the remedy
 *
 * Every module that dispatches a capture builds its OWN request body (there is no shared body-building
 * function to route through — `captureTolerantly`, `capture-client.mjs`, only owns the transport: id,
 * retry, recovery. `body` is a parameter it is handed, never something it assembles). Read all seven:
 *
 *   - Two build the body from a PER-CASE/PAGE OBJECT carrying its own `probe*` declarations
 *     (`capture-real-pages.mjs`, `capture-screenreader-dataset.mjs`) — the shape where a new probe field
 *     can be silently dropped if the forwarding code names fields instead of matching a prefix.
 *   - Five send a FIXED, SMALL set of fields chosen for one narrow purpose, wired to CLI flags or a
 *     literal test fixture rather than to an open-ended per-case object
 *     (`repeat-capture.mjs`, `capture-fixtures.mjs`, `page-identity-rate.mjs`,
 *     `occurrence-verdict-stability.mjs`, `capture-check.mjs`) — structurally immune to the same defect,
 *     because there is no dynamic object whose keys could silently fail to reach the wire.
 *
 * A SINGLE SHARED BUILDER across all seven was tried on paper and rejected: the five fixed-policy clients
 * would have had to pass `undefined` for every field they deliberately do not send, and the two
 * case-driven ones need arbitrary future `probe*` keys forwarded generically, which a parameter list
 * cannot express any better than the status quo. Forcing one function over genuinely different requests
 * is the over-abstraction CLAUDE.md warns against, not the fix for "a fact stated twice".
 *
 * The REAL defect was narrower and was found by reading, not by counting: `capture-screenreader-dataset.
 * mjs`'s `captureOptions()` enumerated ten `probe*` fields BY NAME, while its own sibling hops in the
 * identical pipeline (`case-matrix.mjs`, `generate-screenreader-dataset.mjs`, `acceptance-matrix.mjs`)
 * already forward `probe*` BY PREFIX — each citing the same lesson: "enumerating them is how this exact
 * defect happened three times in one feature". `probeOrder` lived this defect directly (built, and
 * unreachable from a case, until added to the named list by hand) before this fix closed the general
 * case. `probe-forward-by-prefix.test.ts` (co-located with `capture-screenreader-dataset.mjs`) proves
 * that fix is cache-key-safe against the real corpus.
 *
 * ## What this file checks
 *
 * That every discovered capture client is CLASSIFIED — case-driven (and therefore required to forward
 * `probe*` by prefix, not by name) or fixed-policy (with a stated reason it needs no such forwarding) —
 * the same "discover, then require classification" shape `worker-code-check.test.ts` already uses for
 * "who posts to `/capture` at all", reused rather than reinvented.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${REPO}${path}`, "utf8");

/**
 * Builds its body from a per-case/page object and MUST forward `probe*` by prefix rather than by name —
 * the shape a future probe field can silently fail to reach.
 */
const CASE_DRIVEN: Record<string, string> = {
  "packages/lab/src/training/capture-screenreader-dataset.mjs":
    "captureOptions(testCase) builds the body from a case's own declared fields",
};

/**
 * Sends a fixed, small set of fields for one narrow purpose — CLI-flag-driven or a literal fixture, never
 * an open-ended per-case object — so there is no dynamic key a naming choice could drop.
 */
const FIXED_POLICY: Record<string, string> = {
  "packages/lab/src/training/capture-real-pages.mjs":
    "a deliberately curated, hand-argued policy for every real page (probeForms off, probeNavigation on, "
    + "etc.) -- not derived from a per-page probe declaration, so there is nothing a prefix-forward could "
    + "pick up that isn't already named",
  "packages/lab/src/training/repeat-capture.mjs":
    "every field is wired to its own named CLI flag (--probe-forms, --probe-focus, ...); a new probe "
    + "needs a new flag, which is a visible addition, not a silent drop",
  "packages/lab/src/harnesses/capture-fixtures.mjs":
    "a fixed { url, steps, probeForms: true, probeFocus: true } for every eval fixture, not case-driven",
  "packages/lab/src/harnesses/page-identity-rate.mjs":
    "asks only whether a capture reads the right page -- { url, steps }, no probes at all",
  "packages/lab/src/harnesses/occurrence-verdict-stability.mjs":
    "one literal body for one named page, hardcoded in the file",
  "packages/lab/src/harnesses/capture-check.mjs":
    "a fixed regression-check body, { url, steps, probeForms }, not derived from case data",
};

/** The exact discovery `worker-code-check.test.ts` already uses for "who dispatches a capture". */
function captureClients(): string[] {
  const found: string[] = [];
  for (const dir of ["packages/lab/src/training", "packages/lab/src/harnesses"]) {
    for (const entry of readdirSync(`${REPO}${dir}`)) {
      if (!entry.endsWith(".mjs")) continue;
      const path = `${dir}/${entry}`;
      const source = read(path);
      const dispatches = /["'`][^"'`]*\/capture["'`][^]{0,120}?method:\s*["']POST["']/.test(source)
        || /\bcaptureTolerantly\(/.test(source);
      if (dispatches) found.push(path);
    }
  }
  return found.sort();
}

const CLIENTS = captureClients();

test("capture clients are still found -- the vacuity guard for the discovery itself", () => {
  assert.ok(CLIENTS.length >= 5,
    `found only ${CLIENTS.length} capture clients -- either most were removed, or the dispatch pattern `
    + "changed and this regex needs updating, not the count relaxed");
});

test("every capture client that builds a request body is classified", () => {
  const classified = new Set([...Object.keys(CASE_DRIVEN), ...Object.keys(FIXED_POLICY)]);
  const unclassified = CLIENTS.filter((path) => !classified.has(path));
  assert.deepEqual(unclassified, [],
    "a capture client dispatches work and nobody has said whether it builds its body from a per-case "
    + "object (and therefore must forward probe* by PREFIX, never by name) or from a fixed policy (and "
    + "must say why no per-case forwarding is needed):\n"
    + unclassified.map((p) => `  ${p}`).join("\n"));
});

test("every CASE_DRIVEN client forwards probe* by prefix, not only by name", () => {
  const byNameOnly: string[] = [];
  for (const path of Object.keys(CASE_DRIVEN)) {
    const source = read(path);
    // The exact shape the three sibling hops already use: filter Object.entries by a "probe" prefix.
    const hasProxyForward = /startsWith\(["']probe["']\)/.test(source);
    if (!hasProxyForward) byNameOnly.push(path);
  }
  assert.deepEqual(byNameOnly, [],
    "these build a body from a per-case object but forward probe* fields by NAME only -- a probe field "
    + "declared on a future case will silently never reach the worker, exactly the architecture-audit.md "
    + `§5 defect this file exists to prevent:\n${byNameOnly.join("\n")}`);
});

test("every classified path is real, so the lists cannot rot into a no-op", () => {
  for (const path of [...Object.keys(CASE_DRIVEN), ...Object.keys(FIXED_POLICY)]) {
    assert.ok(read(path).length > 0, `${path} does not exist`);
  }
});
