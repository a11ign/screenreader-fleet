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
