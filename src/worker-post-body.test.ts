/**
 * #3283: `requestJson`'S POST BODY IS CHECKED BY A SERVER THAT RECEIVES IT.
 *
 * The mutation reading on #3213 found that `if (payload !== null) req.write(payload)` could become `if (false)`, and
 * the `content-type` and `content-length` headers could be deleted, with all eight test files that import this
 * module still green: every one of them answers the request without reading what was sent. Every capture the fleet
 * starts is a POST through this function, so a body that never left the client would be a fleet that captures nothing.
 *
 * A REAL LOOPBACK SERVER, because the thing under test is what crosses the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { AddressInfo } from "node:net";

import { requestJson } from "./worker-http.mjs";

interface Received { method: string | undefined; headers: IncomingHttpHeaders; body: string }

/** A server that records the request it was sent and answers with the status the test names. */
async function worker(status = 200) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ method: req.method, headers: req.headers, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/capture`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a POST delivers its JSON body to the server, declared as JSON with the BYTE length it has", async () => {
  const w = await worker();
  try {
    // Non-ASCII on purpose: the character count (8) and the byte count (12) differ, so a `content-length` taken
    // from `payload.length` would under-declare and the worker would wait for bytes that never arrive.
    const body = { task: "héllo ✓" };
    const sent = JSON.stringify(body);
    assert.notEqual(Buffer.byteLength(sent), sent.length, "the control: this body must tell bytes from characters");
    await requestJson(w.url, { method: "POST", body });
    assert.equal(w.received.length, 1);
    const [request] = w.received;
    assert.equal(request.method, "POST");
    assert.equal(request.body, sent, "the server must RECEIVE the body, not merely be asked");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["content-length"], String(Buffer.byteLength(sent)));
    assert.equal(request.headers["transfer-encoding"], undefined, "the length is declared, so the worker never reads a chunked body");
    assert.equal(request.headers.accept, "application/json");
  } finally {
    await w.close();
  }
});

test("a GET sends no body and declares none", async () => {
  const w = await worker();
  try {
    await requestJson(w.url);
    const [request] = w.received;
    assert.equal(request.method, "GET");
    assert.equal(request.body, "");
    assert.equal(request.headers["content-type"], undefined);
    assert.equal(request.headers["content-length"], undefined);
    assert.equal(request.headers.accept, "application/json");
  } finally {
    await w.close();
  }
});

test("`ok` is a 2xx: 200 and 299 are, 300 and the errors are not", async () => {
  const answers: Array<[number, boolean]> = [[200, true], [204, true], [299, true], [300, false], [304, false], [404, false], [500, false]];
  for (const [status, ok] of answers) {
    const w = await worker(status);
    try {
      const res = await requestJson(w.url);
      assert.equal(res.status, status);
      assert.equal(res.ok, ok, `${status} is ${ok ? "" : "not "}a success`);
    } finally {
      await w.close();
    }
  }
});
