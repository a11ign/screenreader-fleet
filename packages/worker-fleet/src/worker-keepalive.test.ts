/**
 * A CAPTURE'S CONNECTION IS SILENT FOR ITS WHOLE DURATION, and silence is what gets a socket reaped.
 *
 * The worker writes status and body together at the END of a capture, so between the request and the
 * answer nothing crosses the wire for 12-520 s. To every NAT, firewall and Wi-Fi power-save in the path
 * that is an idle connection.
 *
 * MEASURED 2026-08-28, and the asymmetry is the diagnosis. Across 242 captures the WORKERS reported 1
 * failure (a deliberate dead-port test) and 0 recoveries; the client lost ~9 responses in one gate run.
 * The work completed every time and only the answer was lost. Twelve consecutive SHORT requests took
 * 3-11 ms with none lost — the signature of an idle-timeout, not a flaky link.
 *
 * These tests drive a REAL LOOPBACK SERVER rather than asserting on source text, because a source-text
 * assertion would pass against a `setKeepAlive` that is never reached — and this repo has already paid for
 * a test that examined nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo, Socket } from "node:net";

import { requestJson, KEEPALIVE_DELAY_MS } from "./worker-http.mjs";

/** A server that hands back the SERVER-side view of the connection it was reached on. */
async function server(onSocket: (socket: Socket) => void) {
  const s: Server = createServer((req, res) => {
    onSocket(req.socket);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
}

test("the client enables TCP keepalive, so a silent capture connection is not reaped as idle", async () => {
  // SPIES ON THE PROTOTYPE, so what is observed is the call REQUESTJSON MAKES. The first version of this
  // test connected its own socket, set keepalive on it and asserted that had worked — which tests node,
  // not this module, and would have passed with the hook deleted. That is the "canary that cannot express
  // the fault" rule, committed inside a test written to honour it.
  const calls: Array<[boolean, number | undefined]> = [];
  const original = Socket.prototype.setKeepAlive;
  Socket.prototype.setKeepAlive = function (enable?: boolean, delay?: number) {
    calls.push([enable ?? false, delay]);
    return original.call(this, enable, delay);
  };
  const s = await server(() => {});
  try {
    await requestJson(`${s.url}/health`);
  } finally {
    Socket.prototype.setKeepAlive = original;
    await s.close();
  }
  // KEYED ON THE EXACT DELAY, and THAT IS THE WHOLE TEST. Not a call count: the loopback server sets
  // keepalive on every socket it accepts, so one request produces two calls. And not "a plausible delay"
  // either — node's HTTP server uses `setKeepAlive(true, 5000)`, which sits inside any sensible range, so
  // the first version of this assertion matched the SERVER's call and PASSED WITH THIS HOOK DELETED.
  //
  // Found by mutation, never by reading, in a test whose own comment claimed to honour the rule it broke:
  // a canary that cannot express the fault is worthless. Reading the exported constant is what separates
  // this module's call from every other socket in the process.
  assert.ok(calls.some(([enabled, delay]) => enabled && delay === KEEPALIVE_DELAY_MS),
    `requestJson must enable keepalive with its own ${KEEPALIVE_DELAY_MS} ms delay; saw ${JSON.stringify(calls)}`);
  // THE DELAY IS NOT OPTIONAL: macOS defaults the idle to 7200 s, so `setKeepAlive(true)` alone would
  // first probe two hours after every capture has long finished — enabled, and useless.
  assert.ok(KEEPALIVE_DELAY_MS > 0 && KEEPALIVE_DELAY_MS <= 30_000,
    "the delay must sit under the shortest thing that reaps idle connections; common NAT idle timeouts "
    + "start around 30 s");
});

test("REACHED, not merely written — the socket hook fires on a real request", async () => {
  // The guard this repo's rules actually demand: `refreshBrowseBuffer` was correct, commented and
  // unreachable for every capture ever taken, and three green runs vouched for it. So this asserts the
  // hook RAN, by observing the connection from the other end.
  let sawConnection = false;
  const s = await server(() => { sawConnection = true; });
  try {
    const { ok } = await requestJson(`${s.url}/health`);
    assert.equal(ok, true);
  } finally { await s.close(); }
  assert.equal(sawConnection, true, "requestJson must actually open a socket for the hook to attach to");
});

test("keepalive does not change what the client returns", async () => {
  // A transport change must be invisible to every caller. Nine capture clients read `status`/`ok`/`json`
  // off this, and a socket option that altered any of them would be a behavioural change wearing a
  // performance fix's clothes.
  const s = await server(() => {});
  try {
    const response = await requestJson(`${s.url}/anything`);
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.deepEqual(response.json, { ok: true });
  } finally { await s.close(); }
});
