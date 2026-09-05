import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveWorkerPool } from "./fleet-env.mjs";

/**
 * WHICH FLEET AM I ABOUT TO USE — one answer, in one place.
 *
 * Three modules held three different answers, and the corpus capture path carried a comment saying they
 * had been unified. Measured 2026-08-29 on one machine at one moment:
 *
 *   doctor.mjs                        named -> inventory
 *   check-worker-code.mjs             named -> LOCAL UTM POOL -> inventory
 *   capture-screenreader-dataset.mjs  named -> LOCAL UTM POOL -> lease   (never read the inventory)
 *
 * `doctor` reported five bare-metal boxes and `worker:code` a laptop VM. The unification the comment
 * described covered the NAMED half only; the fallback order below it was still three separate answers.
 *
 * Deleting a copy is this repo's first-choice remedy for a fact stated twice, and the copies are now gone
 * — but "gone" rots back. This test DISCOVERS the fallback shape rather than naming the three modules, so
 * a fourth resolver is caught on the day it is written.
 */
const ROOT = join(import.meta.dirname, "../../..");
const NONE = () => [];
const one = (url: string) => () => [url];

test("the inventory beats the deprecated local pool", () => {
  const { urls } = resolveWorkerPool({
    named: NONE, inventory: one("http://inv:8765"), local: one("http://utm:8765"),
  });
  assert.deepEqual(urls, ["http://inv:8765"]);
});

test("an explicit A11Y_WORKER(S) beats both — naming workers means you are managing them", () => {
  const { urls, source } = resolveWorkerPool({
    named: () => [{ url: "http://named:8765" }], inventory: one("http://inv:8765"), local: one("http://utm:8765"),
  });
  assert.deepEqual(urls, ["http://named:8765"]);
  assert.equal(source, "A11Y_WORKER(S)");
});

test("nothing anywhere names all three places it looked", () => {
  // "none here" and "none anywhere" are different answers. A bare "nothing to compare" is what let
  // `worker:code` insist it had no workers while five sat in the inventory it had already read.
  const { urls, source } = resolveWorkerPool({ named: NONE, inventory: NONE, local: NONE });
  assert.deepEqual(urls, []);
  for (const place of ["A11Y_WORKER", "inventory.yml", "local"]) {
    assert.ok(source.includes(place), `the empty answer must say it looked in ${place}: ${source}`);
  }
});

/** Every non-test source file under packages/, as [path, text]. */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
        walk(path);
        continue;
      }
      if (!/\.(mjs|ts)$/.test(entry.name) || /\.test\.[cm]?ts$/.test(entry.name)) continue;
      out.push([path.slice(ROOT.length + 1), readFileSync(path, "utf8")]);
    }
  };
  walk(join(ROOT, "packages"));
  return out;
}

/** Source with `//` and block comments blanked, so a MENTION is never read as a call. */
function code(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""));
}

const firstLine = (lines: string[], pattern: RegExp) => lines.findIndex((l) => pattern.test(l));

/**
 * Split a file into its top-level declarations, so an ordering check can be asked of ONE function
 * rather than the whole file.
 *
 * FOUND 2026-09-06: `local-vm.ts` calls `findLocalVm(` for three unrelated reasons — the resolution
 * decision in `leaseWorker`, a "is it busy" check in `releaseVm`, and a "did it come up" check in
 * `acquireLocalWorker` — and its own `findLocalVm`/`leaseWorkerPool` DEFINITIONS live in the same file.
 * A whole-file "first occurrence of the pattern" search finds whichever of those five is textually
 * first, which has nothing to do with `leaseWorker`'s own precedence — so widening the LOCAL pattern to
 * include `findLocalVm(` (below) without ALSO narrowing the search to one function would trade one
 * blind spot (missing `leaseWorker` entirely) for a worse one (flagging it, or clearing it, for a
 * reason unrelated to what it actually does).
 *
 * A new top-level function starts at column 0 — this repo's own style throughout `packages/` — so
 * chunking on that line shape needs no brace-counting and cannot be confused by a brace inside a string
 * or a regex literal, which a real parser would have to guard against and a chunker by line shape does
 * not need to.
 */
function functionChunks(lines: string[]): { from: number; lines: string[] }[] {
  const starts: number[] = [];
  lines.forEach((l, i) => { if (/^(export\s+)?(async\s+)?function\s+\w+\s*\(/.test(l)) starts.push(i); });
  return starts.map((from, i) => ({ from, lines: lines.slice(from, starts[i + 1] ?? lines.length) }));
}

test("every FUNCTION that reads BOTH sources asks the inventory FIRST", () => {
  // The property, not the mechanism. Three modules differ legitimately in LIFECYCLE — the corpus path
  // must build lease objects, `doctor` reports rather than dispatches — so requiring them all to call
  // `resolveWorkerPool` would be wrong. What must not differ is the ORDER, which is what drifted.
  //
  // An earlier version of this test required delegation and flagged all three, including
  // `fleet-playbook.mjs`, which mentions `utmctl` only in a comment. Comments are blanked here for
  // exactly that reason: a test that reads source TEXT must at least read the code half of it.
  //
  // PER FUNCTION, not per file, since 2026-09-06 — see `functionChunks`. `leaseWorker` escaped this test
  // entirely before then: it read only `findLocalVm(`, which the LOCAL pattern below did not even
  // recognise, so the whole file was skipped as reading neither source. Widening the pattern without
  // also narrowing the search to one function at a time would have made `local-vm.ts` a permanent false
  // positive instead — `findLocalVm(` is defined in this file and called twice more for reasons that have
  // nothing to do with resolution order.
  const offenders: string[] = [];
  for (const [path, text] of sources()) {
    if (path.endsWith("fleet-env.mjs") || path.endsWith("worker-precedence.test.ts")) continue;
    const lines = code(text);
    // A module that DELEGATES has no order of its own to get wrong; it passes both readers in and
    // `resolveWorkerPool` decides. Without this, `check-worker-code.mjs` is flagged for the line that
    // DEFINES `localPoolUrls` — a definition is not a precedence.
    if (lines.some((l) => /resolveWorkerPool\(/.test(l))) continue;
    for (const chunk of functionChunks(lines)) {
      const local = firstLine(chunk.lines, /localPoolUrls\(|leaseWorkerPool\(|findLocalVm\(/);
      const inventory = firstLine(chunk.lines, /inventoryWorkerUrls\(|namedInventoryWorkers\(/);
      if (local === -1 || inventory === -1) continue;
      if (inventory > local) {
        offenders.push(`${path}: local at line ${chunk.from + local + 1}, `
          + `inventory at ${chunk.from + inventory + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "the local UTM guests are DEPRECATED; inventory.yml is the fleet, and a "
    + "function that prefers the pool describes a different fleet from `doctor` and `worker:code`:\n  "
    + offenders.join("\n  "));
});

test("functionChunks actually isolates leaseWorker, so the property above is not vacuous", () => {
  // Proof this discovery examines the right span, not just that it happens to report zero offenders.
  // `local-vm.ts` is exactly the file the OLD, whole-file version of this test was blind to, and
  // `findLocalVm(` is called three times in it for three unrelated reasons — this pins that exactly ONE
  // of those three lands inside `leaseWorker`'s own chunk, which is the span that actually matters.
  const text = readFileSync(join(ROOT, "packages/worker-fleet/src/local-vm.ts"), "utf8");
  const chunks = functionChunks(code(text));
  const lease = chunks.find((c) => /^export async function leaseWorker\(/.test(c.lines[0]));
  assert.ok(lease, "leaseWorker must be found as its own chunk");
  const findLocalVmHits = (chunk: { lines: string[] }) => chunk.lines.filter((l) => /findLocalVm\(/.test(l)).length;
  assert.equal(findLocalVmHits(lease!), 1, "leaseWorker's chunk must contain exactly its OWN call, "
    + "neither releaseVm's busy-check nor acquireLocalWorker's readiness re-check");
  assert.ok(lease!.lines.some((l) => /inventoryWorkerUrls\(/.test(l)), "and must contain its inventory call");
  const total = chunks.reduce((n, c) => n + findLocalVmHits(c), 0);
  assert.equal(total, 4, "the fixture's own premise: `findLocalVm(` appears four times in this file -- its "
    + "own definition plus three real calls (leaseWorker, releaseVm, acquireLocalWorker) -- if this "
    + "changes, re-check which chunk each occurrence landed in before trusting the count above");
});
