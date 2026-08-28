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

test("the local pool beats the inventory, because a VM on this Mac is the one you are about to use", () => {
  const { urls, source } = workerUrls({
    named: NONE, local: two("http://local:8765"), inventory: two("http://inv:8765"),
  });
  assert.deepEqual(urls, ["http://local:8765"]);
  assert.equal(source, "the local UTM pool");
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
