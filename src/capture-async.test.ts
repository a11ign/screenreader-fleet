/**
 * DISPATCH, THEN POLL — capture-protocol-plan item A, and the path that ships.
 *
 * A capture is 12–520 s of work. The synchronous form held one connection open, SILENT, for all of it: the
 * worker writes status and body together at the end, so nothing crossed the wire in between and every NAT,
 * firewall and Wi-Fi power-save in the path read it as idle. Measured 2026-08-28 — 9 of 40 responses lost,
 * while the WORKERS reported 0 failures across 242 captures. The work completed every time; only the answer
 * was lost.
 *
 * Answering 202 immediately removes the long connection rather than managing it, and makes `GET
 * /capture/<id>` — which existed for this shape all along and was reached only after a failure — the NORMAL
 * path. A route that runs only when something breaks is one nobody notices has broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { captureTolerantly } from "./capture-client.mjs";

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

/** A worker that behaves however the test says, so the client is DRIVEN rather than described. */
async function worker(handler: (url: string, res: ServerResponse, body: string) => void) {
  const s: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => handler(req.url ?? "", res, body));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => s.close(() => r())) };
}

const body = (result: { json: unknown }) => result.json as Record<string, unknown>;

test("the POST is a handshake: 202 arrives at once and the result is COLLECTED, not awaited", async () => {
  let polls = 0;
  const w = await worker((url, res, raw) => {
    if (url === "/capture") {
      assert.equal(JSON.parse(raw).async, true, "the client must ask for the async path");
      return json(res, 202, { captureId: JSON.parse(raw).captureId, state: "running" });
    }
    // Still running for the first two polls, then the answer — the shape of a real capture.
    if (++polls <= 2) return json(res, 202, { state: "running" });
    json(res, 200, { transcript: ["the completed capture"] });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" } });
    assert.deepEqual(body(result).transcript, ["the completed capture"]);
    assert.ok(polls >= 3, "the client must poll until the capture finishes");
  } finally { await w.close(); }
});

test("A DROPPED POLL IS NOT A FAILED CAPTURE — nothing is riding on that socket", async () => {
  // The whole point of the design. Under the synchronous form this drop destroyed the capture; here it
  // costs one round trip because the work is not on the connection.
  let polls = 0;
  const w = await worker((url, res) => {
    if (url === "/capture") return json(res, 202, { state: "running" });
    polls += 1;
    if (polls === 1) return res.destroy();
    json(res, 200, { transcript: ["survived a dropped poll"] });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, timeoutMs: 20_000 });
    assert.deepEqual(body(result).transcript, ["survived a dropped poll"]);
  } finally { await w.close(); }
});

test("A WORKER THAT FORGOT THE CAPTURE IS NOT ONE STILL RUNNING IT", async () => {
  // 202 and 404 are opposite instructions: wait, versus the work is gone and the case must be re-issued.
  // Waiting out a 520 s budget for a capture nobody is running is the conflation this repo has paid for.
  const w = await worker((url, res) => {
    if (url === "/capture") return json(res, 202, { state: "running" });
    json(res, 404, { error: "unknown captureId" });
  });
  try {
    await assert.rejects(
      // BOUNDED, so a mutation that stops treating 404 as lost FAILS rather than hanging for the default
      // budget. A test that hangs on a broken build reads as a broken test.
      () => captureTolerantly({ worker: w.url, body: { url: "http://x/" }, timeoutMs: 6_000 }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "CAPTURE_LOST");
        assert.match(error.message, /restarted/);
        return true;
      });
  } finally { await w.close(); }
});

test("AN OLDER WORKER THAT IGNORES `async` STILL WORKS — the additive contract", async () => {
  // Every wire change in this project ships additive (`captureId`, `fault`), so a host can be deployed
  // before the fleet. A worker that does not know the field runs the capture synchronously and answers
  // 200 with the result; that is a correct answer and must not be retried or treated as a fault.
  // FAITHFUL TO A REAL OLD WORKER, which 404s an unknown route from its router fallback. The first version
  // of this fake answered 200 to EVERY url, so a mutation that ignored the 200 and polled instead still
  // passed — the poll got the same body back. A fake that cannot express the fault is the canary rule
  // wearing a test double's clothes.
  const w = await worker((url, res) => url === "/capture"
    ? json(res, 200, { transcript: ["captured synchronously"] })
    : json(res, 404, { error: "not found" }));
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" } });
    assert.equal(result.status, 200);
    assert.deepEqual(body(result).transcript, ["captured synchronously"]);
  } finally { await w.close(); }
});

test("a failed capture keeps its FAULT CODE across the poll, exactly as the POST would have", async () => {
  // The worker is the component that knows WHY a capture failed. Losing that replaces a diagnosis with
  // "no answer", which this project has repeatedly misread as a dead machine.
  const w = await worker((url, res) => {
    if (url === "/capture") return json(res, 202, { state: "running" });
    json(res, 500, { error: "NVDA is running but not speaking", fault: "screen-reader-mute" });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" } });
    assert.equal(result.status, 500);
    assert.equal(body(result).fault, "screen-reader-mute");
  } finally { await w.close(); }
});

test("progress is reported WHILE the capture runs, which the synchronous form could never do", async () => {
  // Item B. "The worker is dead" and "it is 400 s into a sweep" look identical when the client sees
  // nothing until the end — a distinction that cost two days once.
  const seen: string[] = [];
  let polls = 0;
  const w = await worker((url, res) => {
    if (url === "/capture") return json(res, 202, { state: "running" });
    if (url === "/progress") return json(res, 200, { busy: true, lastPhase: "sweep", elapsedMs: 4000 });
    if (++polls <= 1) return json(res, 202, { state: "running" });
    json(res, 200, { transcript: ["done"] });
  });
  try {
    await captureTolerantly({ worker: w.url, body: { url: "http://x/" },
      onProgress: (p) => seen.push(String((p as { lastPhase?: string }).lastPhase)) });
    assert.ok(seen.includes("sweep"), `the caller must see the phase; saw ${JSON.stringify(seen)}`);
  } finally { await w.close(); }
});

test("A PROGRESS READ THAT FAILS MUST NOT FAIL THE CAPTURE", async () => {
  // Progress is a convenience. Letting it break a capture that is going fine would trade a real result for
  // a diagnostic, which is the wrong way round.
  const w = await worker((url, res) => {
    if (url === "/capture") return json(res, 202, { state: "running" });
    if (url === "/progress") return res.destroy();
    json(res, 200, { transcript: ["fine"] });
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" },
      onProgress: () => {} });
    assert.deepEqual(body(result).transcript, ["fine"]);
  } finally { await w.close(); }
});

test("the budget bounds the POLLING, so a capture that never finishes is not waited on for ever", async () => {
  const w = await worker((url, res) => json(res, 202, { state: "running" }));
  try {
    await assert.rejects(
      () => captureTolerantly({ worker: w.url, body: { url: "http://x/" }, timeoutMs: 2_500 }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "ETIMEDOUT");
        assert.match(error.message, /did not finish/);
        return true;
      });
  } finally { await w.close(); }
});

/**
 * A LOST CAPTURE IS A RE-ISSUABLE CASE, and until 2026-08-29 nothing acted on that.
 *
 * `CAPTURE_LOST` is thrown when the worker 404s a captureId it had already accepted — it restarted
 * mid-capture. The error says "the work is gone and the case must be re-issued", and it is in neither
 * `TRANSIENT_FAULTS` nor `TRANSIENT_NETWORK_CODES`, so it escaped the dataset runner's attempt loop,
 * reached the worker pool as one consecutive failure, and the case was recorded failed WITHOUT being
 * requeued. Three in a row would evict the worker and hand the work back; a single restart lost exactly
 * one case, quietly.
 *
 * Pinned here, at the throw site, because that is where the contract is: the code must stay distinguishable
 * from a transport failure, which is retried, and from a 404 on an UNKNOWN id, which means re-issue too but
 * arrives by a different route.
 */
test("CAPTURE_LOST is distinguishable from a transport failure, because they need opposite handling", async () => {
  const { isTransient } = await import("./transient-fault.mjs");
  const lost = Object.assign(new Error("worker forgot capture X — it restarted mid-capture"),
    { code: "CAPTURE_LOST" });
  assert.equal(isTransient(lost), false,
    "a lost capture is NOT a flaky socket — the work is gone, and retrying the same id would 404 forever");
  const dropped = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal(isTransient(dropped), true,
    "a dropped connection IS transient — the capture may still be running and recoverable by id");
});

/**
 * LOSING THE 202 IS NOT LOSING THE CAPTURE — architecture-audit.md §14.3.
 *
 * The initial `POST {async:true}` was awaited OUTSIDE any recovery block: a lost acknowledgement threw
 * `ECONNRESET` straight at the caller, with the client-minted `captureId` — the only handle able to ask
 * the worker whether it actually started — thrown away with it. Reproduced with a loopback server that
 * accepts the POST, destroys the response socket before the client reads it, and would answer a completed
 * capture on `GET /capture/<id>`: before the fix this threw with ZERO GETs ever attempted.
 */
test("A LOST 202 IS RECONCILED BY THE SAME ID, not thrown away", async () => {
  const recorded = new Map<string, { state: "running" } | { state: "done"; status: number; body: unknown }>();
  let posts = 0;
  let gets = 0;
  const w = await worker((url, res, raw) => {
    if (url === "/capture") {
      posts += 1;
      const id = JSON.parse(raw).captureId as string;
      recorded.set(id, { state: "running" });
      // The worker DID accept it and will finish shortly -- only the ACKNOWLEDGEMENT dies here.
      setTimeout(() => recorded.set(id, { state: "done", status: 200, body: { transcript: ["recovered"] } }), 20);
      return res.destroy();
    }
    gets += 1;
    const id = url.split("/").pop() ?? "";
    const entry = recorded.get(id);
    if (!entry) return json(res, 404, { error: "no such capture" });
    if (entry.state === "running") return json(res, 202, { state: "running", captureId: id });
    json(res, entry.status, entry.body);
  });
  try {
    const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, timeoutMs: 5_000 });
    assert.deepEqual(body(result).transcript, ["recovered"]);
    assert.equal(posts, 1, "reconciling a lost acknowledgement must not pay for a second capture");
    assert.ok(gets >= 1, "recovering must ask the worker, or this test cannot tell recovery from luck");
  } finally { await w.close(); }
});

/**
 * THE DEADLINE IS NOT A SUGGESTION — architecture-audit.md §14.5. Every wait inside the poll loop used a
 * fixed constant (a 2 s sleep, a 10 s progress read, a 30 s result read) regardless of how little of
 * `timeoutMs` was left, so a caller asking for `timeoutMs: 20` against a worker that answers IMMEDIATELY
 * still measured ~2,012 ms before getting a result back — the audit's own loopback probe, reproduced here
 * verbatim. This is a deadline-CONTRACT test: the claim is not that captures finish in 20 ms, it is that
 * the client must not silently pad a tiny requested budget by two orders of magnitude when nothing forced
 * it to.
 */
test("a tiny timeoutMs is not padded by a full unconditional POLL_MS sleep", async () => {
  const w = await worker((url, res) => {
    if (url === "/capture") return json(res, 202, { state: "running" });
    json(res, 200, { transcript: ["done immediately"] }); // answers on the very FIRST poll
  });
  try {
    const start = Date.now();
    // Either outcome is a compliant answer to a 20 ms budget -- succeeding because the deadline still had
    // room for one fast local poll, or honestly timing out because it did not. What the OLD code could
    // never do is take ~2,012 ms to arrive at either one, which is the only thing asserted below.
    await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, timeoutMs: 20 }).catch(() => {});
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `expected well under the old ~2,012 ms for a 20 ms budget; took ${elapsed} ms`);
  } finally { await w.close(); }
});

/**
 * A POST THAT NEVER ARRIVES IS DIFFERENT FROM ONE WHOSE ANSWER WAS LOST, and only the first is safe to
 * retry with a fresh id immediately. This is the audit's "never-accepted test", the sibling the
 * accepted-but-lost test above needs.
 */
test("a POST THAT NEVER REACHED THE WORKER is retried with a fresh id, confirmed via the SAME one first",
  async () => {
    let posts = 0;
    let gets = 0;
    const w = await worker((url, res, raw) => {
      if (url === "/capture") {
        posts += 1;
        // The first POST never reaches the handler's own bookkeeping at all -- nothing is ever `begin()`.
        if (posts === 1) return res.destroy();
        return json(res, 200, { transcript: ["second attempt"], captureId: JSON.parse(raw).captureId });
      }
      gets += 1;
      json(res, 404, { error: "no such capture" }); // never heard of it: nothing was ever accepted
    });
    try {
      const result = await captureTolerantly({ worker: w.url, body: { url: "http://x/" }, timeoutMs: 5_000 });
      assert.deepEqual(body(result).transcript, ["second attempt"]);
      assert.equal(posts, 2, "a confirmed-absent id must fall back to a fresh POST, exactly like the sync path");
      assert.ok(gets >= 1, "the fallback must ask FIRST — minting a new id immediately is what the audit forbids");
    } finally { await w.close(); }
  });
