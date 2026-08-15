/**
 * HTTP to a capture worker, on a connection that may stay silent for ten minutes.
 *
 * ## Why this is not `fetch`
 *
 * Node's global `fetch` is undici, and undici caps the wait for RESPONSE HEADERS at 300 s
 * (`headersTimeout`). `AbortSignal.timeout()` does not govern it — it is a separate mechanism, settable
 * only through a dispatcher. Measured on Node v24.7.0 against a server that withheld headers for 310 s:
 *
 *     global fetch  + AbortSignal.timeout(560s) : THREW — TypeError: fetch failed :: UND_ERR_HEADERS_TIMEOUT
 *     node:http request                         : SURVIVED — got 200
 *
 * That cap lands squarely inside this project's own budget ladder. `capture-pure.mjs` sets a 420 s sweep
 * budget inside a 520 s hard timeout, deliberately raised so that "a real page was sampled not validated",
 * and the three clients then declared 560 s, 560 s and 320 s. Every one of those numbers is above 300 s, so
 * the effective ceiling was undici's — not any constant in this repo.
 *
 * The failure is silent and it destroys evidence. The worker writes its status and body together at the END
 * of a capture (`send(res, 200, {...})`), so headers arrive last; a capture that takes 301 s therefore has
 * its socket torn down by the CLIENT at the moment it finishes, and the worker writes a completed capture
 * into a dead socket. The host sees `fetch failed`, classifies it transient, and retries — paying another
 * full capture to reach the same cliff. Three such pages in a row on one worker trips `shouldEvictWorker`
 * and removes a machine that was never faulty.
 *
 * `cli.ts` had the diagnosis exactly right in a comment — it names `UND_ERR_HEADERS_TIMEOUT` and the ~300 s
 * cap — and then raised an `AbortSignal`, which governs a different mechanism. This repo's own "a comment
 * that names an ambiguity, above code that resolves it by assumption", one step worse: the comment named
 * the mechanism and the code still addressed another one.
 *
 * ## Why not an undici dispatcher
 *
 * `undici` is not a dependency here, and installing it would not help by itself: the standalone package
 * keeps its own global dispatcher, so `setGlobalDispatcher` does not reach Node's built-in `fetch`. Using
 * it would mean importing undici's `fetch` too. `node:http` is in core, has no client-side headers cap at
 * all, and gives us one explicit deadline over the whole exchange instead of three interacting ones.
 *
 * ## Errors carry a CODE
 *
 * `node:http` reports `error.code` (`ECONNREFUSED`, `EHOSTUNREACH`, `ECONNRESET`) where `fetch` collapsed
 * everything into `TypeError: fetch failed`. That is strictly better — `capture-faults.mjs` records what
 * matching on prose costs — but it is a behaviour change the retry logic has to know about, so
 * `isTransient` now keys on those codes. `EHOSTUNREACH` matters most: it is how a bare-metal worker's NIC
 * waking from selective suspend presents, and under `fetch` it was transient only by accident, because the
 * wrapper said "fetch failed".
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * One request, with a single deadline covering connect, headers and body.
 *
 * @param {string} url
 * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, ok: boolean, text: string, json: unknown }>}
 */
export function requestJson(url, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = send(target, { method, headers: requestHeaders(payload) }, (res) => {
      collect(res).then((text) => {
        clearTimeout(deadline);
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, json: parse(text) });
      }, failWith);
    });

    // Our own deadline, because node:http has no equivalent of a total-request timeout: its `timeout`
    // option measures socket INACTIVITY, which a worker holding a connection open while NVDA reads a page
    // never trips. The message says "timed out" so the prose fallback in isTransient still classifies it,
    // and the code says so too for anything that prefers codes.
    const deadline = setTimeout(() => {
      const error = new Error(`Request to ${url} timed out after ${timeoutMs} ms`);
      error.code = "ETIMEDOUT";
      req.destroy(error);
    }, timeoutMs);

    function failWith(error) {
      clearTimeout(deadline);
      reject(error);
    }

    req.on("error", failWith);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function requestHeaders(payload) {
  if (payload === null) return { accept: "application/json" };
  return {
    accept: "application/json",
    "content-type": "application/json",
    // Explicit, so the worker never has to read a chunked body. Byte length, not character count:
    // a non-ASCII task string would otherwise under-declare and the worker would wait for bytes
    // that never arrive.
    "content-length": Buffer.byteLength(payload),
  };
}

function collect(res) {
  return new Promise((resolve, reject) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => resolve(text));
    res.on("error", reject);
  });
}

/** Parsed JSON, or undefined — a worker error page is not a parse failure worth throwing over. */
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
