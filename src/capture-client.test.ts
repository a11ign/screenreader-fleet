/**
 * A capture survives a lost socket — for every client, not just the corpus runner.
 *
 * The worker has stored completed captures under a caller-chosen id for months. TEN lab modules POST to
 * `/capture` and exactly ONE used the recovery, which is this repo's most expensive recurring shape:
 * a remedy applied at one call site when the behaviour reaches several.
 *
 * Measured cost on 2026-08-28: three `gate:stability` canaries lost to `FAILED read ETIMEDOUT` across two
 * runs — three different pages on three different boxes, so it is the transport and not either. Every one
 * of those captures had COMPLETED and was sitting in the worker's store.
 *
 * THE TESTS BELOW DRIVE `sync: true` DELIBERATELY. That path is no longer the default — it is the escape
 * hatch — but it is still reachable, and an escape hatch nobody tests is one that fails at the moment it is
 * reached for. The async path, which is what ships, is exercised in `capture-async.test.ts`.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { captureTolerantly, recoverCapture } from "./capture-client.mjs";

/** A worker that behaves however the test says, so the client is driven rather than described. */
async function worker(handler: (url: string, res: ServerResponse, body: string) => void) {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => handler(req.url ?? "", res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The worker's parsed body. One narrow reader, rather than an `any` cast at every assertion. */
const body = (result: { json: unknown }) => result.json as Record<string, unknown>;

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

test("a clean capture posts once and carries the caller's captureId", async () => {
  const seen: string[] = [];
  const w = await worker((url, res, body) => {
    seen.push(url);
    json(res, 200, { transcript: ["ok"], captureId: JSON.parse(body).captureId });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, sync: true });
    assert.equal(result.recovered, false);
    assert.deepEqual(seen, ["/capture"], "no recovery request when nothing was lost");
    assert.ok(body(result).captureId, "the id must reach the worker, or nothing can be recovered");
  } finally { await w.close(); }
});

test("A DROPPED RESPONSE IS RECOVERED, NOT RE-CAPTURED — the whole point", async () => {
  // The worker finishes the capture and then the socket dies. Re-capturing would pay 12-520 s again for
  // work that is already done and stored.
  let posts = 0;
  const w = await worker((url, res) => {
    if (url === "/capture") { posts += 1; res.destroy(); return; }
    json(res, 200, { transcript: ["the original response"] });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, sync: true });
    assert.equal(result.recovered, true);
    assert.deepEqual(body(result).transcript, ["the original response"]);
    assert.equal(posts, 1, "recovering must not also re-capture — that would pay for it twice");
  } finally { await w.close(); }
});

test("`recovered` travels with the result, so a transport fault cannot hide as a clean attempt", async () => {
  const w = await worker((url, res) => {
    if (url === "/capture") { res.destroy(); return; }
    json(res, 200, { transcript: ["x"] });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, sync: true });
    assert.equal(result.recovered, true,
      "a caller measuring the transport needs to know this cost a round trip, not a capture");
  } finally { await w.close(); }
});

test("NOTHING KEPT means capture again — a 404 is not an error, it is 'never heard of it'", async () => {
  let posts = 0;
  const w = await worker((url, res) => {
    if (url === "/capture") {
      posts += 1;
      if (posts === 1) { res.destroy(); return; }
      json(res, 200, { transcript: ["second attempt"] });
      return;
    }
    json(res, 404, { error: "unknown captureId" });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, sync: true });
    assert.equal(result.recovered, false);
    assert.equal(posts, 2, "an older worker that kept nothing must fall back to capturing");
    assert.deepEqual(body(result).transcript, ["second attempt"]);
  } finally { await w.close(); }
});

test("A RECOVERED FAILURE KEEPS ITS FAULT CODE, rather than becoming 'no answer'", async () => {
  // 500 is the worker's own diagnosis. Losing it replaces a diagnosis with silence, which this project has
  // repeatedly misread as a dead machine.
  const w = await worker((url, res) => {
    if (url === "/capture") { res.destroy(); return; }
    json(res, 500, { error: "NVDA is running but not speaking", fault: "screen-reader-mute" });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, sync: true });
    assert.equal(result.status, 500);
    assert.equal(body(result).fault, "screen-reader-mute",
      "the caller's own classification must see the fault, exactly as on the original response");
  } finally { await w.close(); }
});

test("STILL RUNNING is not recoverable and is not 'never heard of it'", async () => {
  const w = await worker((url, res) => json(res, 202, { state: "running" }));
  try {
    assert.equal(await recoverCapture(w.url, "an-id"), null,
      "202 means wait or re-issue — it must not be returned as a completed capture");
  } finally { await w.close(); }
});

test("A NON-TRANSIENT FAILURE IS NOT RETRIED — a real defect must not become 'flaky'", async () => {
  // An HTTP 500 on the FIRST attempt resolves rather than rejects, so it reaches the caller untouched and
  // no recovery is attempted. Turning the worker's diagnosis into a retry is how a defect gets laundered.
  let posts = 0;
  const w = await worker((url, res) => {
    posts += 1;
    json(res, 500, { error: "a capture is already in progress", fault: null });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, sync: true });
    assert.equal(result.status, 500);
    assert.equal(posts, 1, "one request: an answered error is an answer");
  } finally { await w.close(); }
});

test("beforeRecovery runs BEFORE the question, so a caller may wait for the box to come back", async () => {
  const waited = mock.fn(async () => {});
  const w = await worker((url, res) => {
    if (url === "/capture") { res.destroy(); return; }
    json(res, 200, { transcript: ["x"] });
  });
  try {
    await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, beforeRecovery: waited, sync: true });
    assert.equal(waited.mock.callCount(), 1);
  } finally { await w.close(); }
});
