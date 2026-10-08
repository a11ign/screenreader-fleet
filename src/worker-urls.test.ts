import { test } from "node:test";
import assert from "node:assert/strict";
import { workerUrls } from "./check-worker-code.mjs";

/**
 * `worker:code` reported "no worker is running — nothing to compare" while five bare-metal workers served
 * `/health` and every one of them was STALE against the checkout. The same command with `A11Y_WORKERS` set
 * reported `5 stale worker(s)`. The quiet answer was the wrong one, and this command exists to stop a
 * corpus being captured on the wrong code — so a false clean from it IS the failure it prevents.
 *
 * These pin the precedence and, above all, that the last resort is the inventory rather than silence.
 */
const NONE = () => [];
const two = (...urls: string[]) => () => urls;

test("an explicitly named worker wins — naming one means you are managing it", () => {
  const { urls, source } = workerUrls({
    named: () => [{ name: "named", url: "http://named:8765" }], local: two("http://local:8765"),
    inventory: two("http://inv:8765"),
  });
  assert.deepEqual(urls, ["http://named:8765"]);
  assert.equal(source, "A11Y_WORKER(S)");
});

test("the INVENTORY beats the local pool — the local guests are deprecated", () => {
  // REVERSED 2026-08-29, and the old assertion is worth recording because it was correct when written.
  // It read "the local pool beats the inventory, because a VM on this Mac is the one you are about to
  // use" — true while the local UTM guests WERE the fleet. They were a testing arrangement and are
  // deprecated; capture runs on the bare metal in `inventory.yml`, which ADR 0012 calls the single source
  // of truth.
  //
  // Left as it was, this is the divergence measured the same day: `doctor` (named -> inventory) reported
  // five bare-metal boxes while `worker:code` (named -> local -> inventory) reported a laptop VM, on the
  // same machine at the same moment. A stale-code check that examines the wrong fleet is a false clean,
  // which is the exact failure this command exists to prevent.
  const { urls, source } = workerUrls({
    named: NONE, local: two("http://local:8765"), inventory: two("http://inv:8765"),
  });
  assert.deepEqual(urls, ["http://inv:8765"]);
  assert.match(source, /inventory\.yml/);
});

test("with an inventory AND no local VM, the local pool is never even asked", () => {
  // Reading it means shelling out to `utmctl`, which on a Mac with UTM closed reports a healthy VM's
  // state as `unknown` and costs seconds. A deprecated path should not be on the fast path.
  let asked = false;
  workerUrls({ named: NONE, local: () => { asked = true; return []; }, inventory: two("http://inv:8765") });
  assert.equal(asked, false, "the inventory answered, so the deprecated pool must not be consulted");
});

test("with NO inventory the local pool still works, and says it is deprecated", () => {
  // A contributor with one Mac and no hardware is a supported setup — `docs/getting-started.md` builds
  // exactly that. Deprecated means "not first", never "removed", and the source string must say so or an
  // operator cannot tell which of the two they are looking at.
  const { urls, source } = workerUrls({ named: NONE, local: two("http://local:8765"), inventory: NONE });
  assert.deepEqual(urls, ["http://local:8765"]);
  assert.match(source, /DEPRECATED/);
});

test("with no env and no local VM it asks the INVENTORY, rather than reporting nothing to compare", () => {
  // The regression itself. `inventoryWorkerUrls` was already imported and already read to print the
  // remedy, so the command could name five workers it should have checked while insisting it had none.
  const { urls, source } = workerUrls({
    named: NONE, local: NONE, inventory: two("http://a:8765", "http://b:8765"),
  });
  assert.deepEqual(urls, ["http://a:8765", "http://b:8765"]);
  assert.equal(source, "inventory.yml");
});

test("every source names itself, so a reading is never ambiguous about what it examined", () => {
  // "all current" means nothing until you know whether it examined the fleet you are about to capture on
  // or the empty pool on a laptop. An unnamed source is how `unchecked` comes to read as `clean`.
  const sources = [
    workerUrls({ named: () => [{ name: "n", url: "u" }], local: NONE, inventory: NONE }).source,
    workerUrls({ named: NONE, local: two("u"), inventory: NONE }).source,
    workerUrls({ named: NONE, local: NONE, inventory: two("u") }).source,
  ];
  assert.equal(new Set(sources).size, 3, `sources must be distinguishable, got ${sources.join(" / ")}`);
  for (const s of sources) assert.ok(s && s.length > 3, `unhelpful source: ${JSON.stringify(s)}`);
});

test("genuinely nothing anywhere is still empty — the fallback must not invent a worker", () => {
  const { urls } = workerUrls({ named: NONE, local: NONE, inventory: NONE });
  assert.deepEqual(urls, []);
});
