/**
 * A measurement taken against a busy box returns a plausible wrong number.
 *
 * That is what makes it worth a guard rather than a rule. Four times in two days a measurement ran against
 * something already in use and produced a figure: 429s read as sub-second capture times, a `keepAliveTimeout`
 * read as a NAT reap, 404s from a port another run had rebound. A measurement that FAILS is harmless; one
 * that returns a believable figure gets acted on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { refuseIfBusy } from "./measure-guard.mjs";

async function worker(health: Record<string, unknown> | null) {
  const s: Server = createServer((_req, res: ServerResponse) => {
    if (!health) return res.destroy();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(health));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => s.close(() => r())) };
}

test("a free fleet is measured without complaint", async () => {
  const w = await worker({ ready: true, ok: true });
  try {
    await refuseIfBusy([w.url], { what: "the reap interval" });
  } finally { await w.close(); }
});

test("A BUSY BOX IS REFUSED, and the refusal names what was not measured", async () => {
  const w = await worker({ ready: false, busy: true, ok: true });
  try {
    await assert.rejects(() => refuseIfBusy([w.url], { what: "the reap interval" }),
      (error: Error) => {
        assert.match(error.message, /REFUSING to measure the reap interval/);
        assert.match(error.message, /busy/);
        return true;
      });
  } finally { await w.close(); }
});

test("`ready`, NEVER `ok` — a worker answers ok while NVDA cannot start", async () => {
  // The pool's dominant failure hid for a day behind exactly this distinction: `ok` only ever meant "the
  // HTTP server is answering". A guard keyed on it would wave through the box it exists to catch.
  const w = await worker({ ok: true, ready: false });
  try {
    await assert.rejects(() => refuseIfBusy([w.url], { what: "anything" }));
  } finally { await w.close(); }
});

test("UNREACHABLE IS NOT FREE", async () => {
  // Measuring against a box that cannot answer /health produces precisely the plausible-looking nonsense
  // this guard exists to prevent.
  const w = await worker(null);
  try {
    await assert.rejects(() => refuseIfBusy([w.url], { what: "the reap interval" }),
      (error: Error) => {
        assert.match(error.message, /unreachable/);
        return true;
      });
  } finally { await w.close(); }
});

test("one busy box in a fleet refuses the whole measurement, and says which", async () => {
  const free = await worker({ ready: true });
  const busy = await worker({ ready: false, busy: true });
  try {
    await assert.rejects(() => refuseIfBusy([free.url, busy.url], { what: "throughput" }),
      (error: Error) => {
        assert.match(error.message, /1 of 2 worker\(s\)/);
        assert.ok(error.message.includes(busy.url), "the refusal must name the box that is busy");
        return true;
      });
  } finally { await free.close(); await busy.close(); }
});

/**
 * DISCOVERY: a guard that nothing calls is a guard that never runs.
 *
 * `refuseIfBusy` was written for four measured incidents — a transport probe against a box running a gate
 * read 12 straight 429s as timings — and then wired to NOTHING. Its only reference was this file, which
 * is the `scorer:verify` shape exactly: a security check that existed and that no script, playbook or
 * module ever invoked.
 *
 * Found by scanning for modules no production file imports, which is the same scan that found
 * `completeness.ts` duplicating C2. Both were invisible to every test and every gate.
 */
test("a MEASUREMENT tool refuses a busy box, rather than sampling it", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Tools whose whole output is per-worker timing. A number taken from a busy box is not slow, it is wrong.
  const MEASURERS = ["packages/worker-fleet/src/compare-workers.mjs"];
  const unguarded = MEASURERS.filter((file) =>
    !/\brefuseIfBusy\s*\(/.test(strip(readFileSync(resolve(root, file), "utf8"))));
  assert.deepEqual(unguarded, [],
    "a tool that reports per-worker timings must refuse a worker that is not `ready`, or its numbers "
    + "describe whatever else that box was doing");
});
