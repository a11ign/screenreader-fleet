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

test("every module that reads BOTH sources asks the inventory FIRST", () => {
  // The property, not the mechanism. Three modules differ legitimately in LIFECYCLE — the corpus path
  // must build lease objects, `doctor` reports rather than dispatches — so requiring them all to call
  // `resolveWorkerPool` would be wrong. What must not differ is the ORDER, which is what drifted.
  //
  // An earlier version of this test required delegation and flagged all three, including
  // `fleet-playbook.mjs`, which mentions `utmctl` only in a comment. Comments are blanked here for
  // exactly that reason: a test that reads source TEXT must at least read the code half of it.
  const offenders: string[] = [];
  for (const [path, text] of sources()) {
    if (path.endsWith("fleet-env.mjs") || path.endsWith("worker-precedence.test.ts")) continue;
    const lines = code(text);
    // A module that DELEGATES has no order of its own to get wrong; it passes both readers in and
    // `resolveWorkerPool` decides. Without this, `check-worker-code.mjs` is flagged for the line that
    // DEFINES `localPoolUrls` — a definition is not a precedence.
    if (lines.some((l) => /resolveWorkerPool\(/.test(l))) continue;
    const local = firstLine(lines, /localPoolUrls\(|leaseWorkerPool\(/);
    const inventory = firstLine(lines, /inventoryWorkerUrls\(|namedInventoryWorkers\(/);
    if (local === -1 || inventory === -1) continue;
    if (inventory > local) {
      offenders.push(`${path}: local pool at line ${local + 1}, inventory at ${inventory + 1}`);
    }
  }
  assert.deepEqual(offenders, [], "the local UTM guests are DEPRECATED; inventory.yml is the fleet, and a "
    + "module that prefers the pool describes a different fleet from `doctor` and `worker:code`:\n  "
    + offenders.join("\n  "));
});
