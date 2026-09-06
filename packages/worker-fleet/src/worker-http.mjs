// @ts-check
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
 * How long a CLIENT should wait for a capture. One definition, because five had drifted.
 *
 * It must exceed the worker's own hard timeout (`CAPTURE_HARD_TIMEOUT_DEFAULT_MS`, 520 s) or the client
 * gives up first, and a capture the worker would have completed is reported as a client failure. Five
 * clients sat at 300 s -- `compare-workers`, `bench-capture`, `evidence-check`, `repeat-capture` and
 * `capture-real-pages` -- against that 520 s. On the generated corpus nothing noticed, because a 1,338-byte
 * page finishes in seconds. On REAL pages it silently dropped whatever used its budget, biasing the
 * real-page corpus toward small simple pages: precisely the axis that corpus exists to add.
 *
 * 560,000 -> 620,000 on architecture-audit.md §14.5: `runCapture` (server.mjs) spends up to
 * `DESKTOP_PREPARE_TIMEOUT_MS` (60 s) clearing the desktop BEFORE the hard-timeout-wrapped capture attempt
 * even starts, sequentially rather than overlapping it -- so the true worst case a worker can legitimately
 * take is 60 s + 520 s = 580 s, not 520 s alone. The old 560 s ceiling sat BELOW that, so a real page that
 * used the full prepare budget and the full capture budget was killed by the CLIENT first and reported as
 * a client failure for work the worker would have finished -- the exact shape this constant already exists
 * to prevent, one rung further out. 620,000 keeps the same 40 s margin above the new true worst case that
 * the original 560,000 kept above 520,000. `budget-ladder.test.ts` asserts the full sequence, not only the
 * capture attempt inside it.
 *
 * Deliberately NOT imported from `@a11y-witness/nvda-worker`: this package runs on macOS and Linux and must
 * not depend on a win32-only one. `budget-ladder.test.ts` enforces the relationship instead, over every
 * client it DISCOVERS rather than a list -- which is how the 300 s clients stayed invisible while a guard
 * for exactly this existed and read one hardcoded path.
 *
 * `DATASET_CAPTURE_TIMEOUT_MS` still overrides it in the dataset runner, which is the only client that
 * wants a per-run ceiling.
 */
export const CAPTURE_CLIENT_TIMEOUT_MS = 620_000;

/**
 * How long a capture's silent connection may idle before the OS proves it is still there.
 *
 * 15 s, and RAISING IT TO 60 s WAS TRIED AND REVERTED — by this file's own test, which refuses a delay
 * above ~30 s because common NAT idle timeouts start there.
 *
 * The reasoning for raising it was that the async path removed the long-lived connection, so nothing needs
 * an aggressive value. That is true of the async path and FALSE of the `A11Y_SYNC_CAPTURE` escape hatch,
 * which still holds one socket silent for a whole capture. At 60 s the first probe would fire after the
 * reap, so the hatch would be unprotected while the constant looked deliberate — a guard weakened for a
 * reason that did not cover the case it exists for.
 *
 * It stays aggressive until item D explains why THIS path reaps in seconds when the literature says
 * minutes. An unexplained number is not a solved problem.
 *
 * EXPORTED so its test can key on the exact value. Node's own HTTP SERVER calls `setKeepAlive(true, 5000)`
 * on every socket it accepts, so a test that merely looked for "keepalive with a plausible delay" matched
 * the server's call and passed with this hook DELETED — found by mutation, not by reading.
 */
export const KEEPALIVE_DELAY_MS = 15_000;

/**
 * A worker address, validated at the BOUNDARY where it enters the program.
 *
 * `requestJson` already calls `new URL(url)`, which throws `ERR_INVALID_URL` on a malformed address — so an
 * empty host dies in under a second, in principle. In practice it did not, and the way it did not is the
 * reason this function exists.
 *
 * `--worker=http://:8765` reached `capture-real-pages.mjs` because nothing there did more than check the
 * value was truthy, and `http://:8765` is truthy. The readiness loop then caught the resulting
 * `ERR_INVALID_URL` in a bare `catch` whose only content was the comment "mid-boot or mid-restart; keep
 * waiting", and so classified a permanent
 * programmer error as a transient network condition: 60 attempts, 5 s apart, per page — then recorded
 * "worker never became ready" as a failure of the PAGE. Four shards spent 29 minutes that way while every
 * worker sat idle, and the run blamed the corpus.
 *
 * So the fix is two-part and both halves are needed: refuse the value here, and stop the readiness loop
 * swallowing what it cannot recover from. Validating without fixing the catch leaves the next unrecoverable
 * error to be absorbed the same way.
 *
 * Node's URL parser does the work. There is no regex here on purpose — a hand-rolled one would accept
 * `http://:8765` again, since the only thing wrong with it is an empty host. Note `http:/x` and
 * `http:///path` DO parse, to host `x` and host `path`; that is the parser's business and not something to
 * second-guess here.
 *
 * @param {string | null | undefined} value the raw `--worker=` or `A11Y_WORKER` value
 * @param {{ source?: string }} [options] what to name in the error, e.g. "--worker"
 * @returns {string} the address, trailing slash removed
 */
export function assertWorkerUrl(value, { source = "--worker" } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${source} is required and was empty. Give a worker address, e.g. ${source}=http://192.0.2.10:8765`);
  }
  const raw = value.trim().replace(/\/$/, "");
  let target;
  try {
    target = new URL(raw);
  } catch (cause) {
    // A missing HOST lands here rather than in a hostname check below, and there is no such check on
    // purpose: verified against Node's parser, no `http:`/`https:` URL can parse with an empty hostname —
    // `http://`, `http://:8765` and `http://:/x` all throw. A `!target.hostname` branch would therefore be
    // unreachable, which is this repo's own most-repeated defect, so the message that belongs to that case
    // is folded in here where it can actually be read.
    throw new Error(
      `${source}=${raw} is not a URL. Expected something like http://192.0.2.10:8765\n`
      + "If the host is missing, that is what a shell variable expanding to nothing looks like: a bash "
      + "array does not survive `nohup bash -c`, and zsh does not word-split a scalar. Both produce "
      + "exactly this.", { cause });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`${source}=${raw} must be http: or https:, not ${target.protocol}`);
  }
  return raw;
}

/**
 * One request, with a single deadline covering connect, headers and body.
 *
 * @param {string} url
 * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, ok: boolean, text: string, json: any }>}
 *   `json: any`, not `unknown`. This is a JSON body off the wire, and every caller reads named fields
 *   from it -- `body.error`, `body.fault`, `health.busy`, `body.transcript`. `unknown` makes each of
 *   those a cast, and a cast written to satisfy a checker asserts a shape nobody verified, which is
 *   strictly worse than saying the value is untyped. The SHAPE that matters is checked where it is
 *   defined: `capture-core`'s `Capture` typedef, and the worker's own `/health` contract.
 */
export function requestJson(url, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = send(target, { method, headers: requestHeaders(payload) }, (res) => {
      collect(res).then((text) => {
        clearTimeout(deadline);
        // `?? 0` because node types `statusCode` optional -- it is set on every client response, and a 0
        // would fall out of the 2xx range exactly as an absent one should, so the fallback cannot change
        // an answer. Named once rather than read three times.
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, text, json: parse(text) });
      }, failWith);
    });

    // Our own deadline, because node:http has no equivalent of a total-request timeout: its `timeout`
    // option measures socket INACTIVITY, which a worker holding a connection open while NVDA reads a page
    // never trips. The message says "timed out" so the prose fallback in isTransient still classifies it,
    // and the code says so too for anything that prefers codes.
    const deadline = setTimeout(() => {
      // Typed as an ErrnoException so the `code` this deliberately attaches is describable. Recovery in
      // this repo is keyed on CODES and never on message text (`capture-faults.mjs`), so the field is
      // load-bearing rather than decorative.
      const error = /** @type {NodeJS.ErrnoException} */ (
        new Error(`Request to ${url} timed out after ${timeoutMs} ms`));
      error.code = "ETIMEDOUT";
      req.destroy(error);
    }, timeoutMs);

    /** @param {unknown} error */
    function failWith(error) {
      clearTimeout(deadline);
      reject(error);
    }

    // KEEPALIVE, KEPT ON PRECAUTIONARY GROUNDS ONLY. ITS DIAGNOSIS WAS WRONG, AND THE REASON IS TOPOLOGY.
    //
    // The story attached to this was: a capture holds a connection SILENT for minutes, so NAT and Wi-Fi
    // power-save reap it as idle. It was argued from *High Performance Browser Networking* -- "Most mobile
    // carriers set a 5-30 minute NAT connection timeout" -- and that passage is about MOBILE CARRIERS AND
    // THE PUBLIC INTERNET.
    //
    // THIS IS A LAN. The control plane and every worker sit on the same /24; the route between them is
    // `link#14`, direct on the link layer with no gateway hop. NAT happens at the router on the
    // way OUT. There is no translation table between these hosts, so there is nothing here that a NAT
    // timeout could expire. The theory was inapplicable from the first line, and the mismatch went
    // unnoticed because the quotation fitted the SYMPTOM.
    //
    // The measurements agree, which is how it was caught rather than believed. Keepalive explicitly OFF,
    // ~26 s silent captures:
    //
    //     8 sequential on one box        0 lost
    //     15 across five boxes at once   0 lost    <- the exact condition the 9/40 was measured under
    //
    // 0 of 23. At the old 22% rate P(0 in 23) = 0.78^23 = 0.4%, so the rate really did change -- and these
    // trials ran WITHOUT the keepalive, so it is not shown to be why. Losses went 9/40 -> 0 when it landed
    // and nobody tested removing it: "a green result vouches for the mechanism", committed inside the work
    // that kept finding that trap elsewhere.
    //
    // So: the losses were REAL and their cause is UNKNOWN. NAT is excluded by topology; the worker's own
    // `keepAliveTimeout` and `requestTimeout` were excluded by measurement; the boxes' NIC power settings
    // were already correct. What is left is the Wi-Fi association itself or something transient, and this
    // comment will not guess again.
    //
    // Item A is unaffected and that is the useful part: the async path holds no long connection at all, so
    // it is immune whatever the mechanism was. A STRUCTURAL FIX DOES NOT DEPEND ON THE DIAGNOSIS BEING
    // RIGHT, which is the strongest argument there is for preferring one.

    req.on("socket", (socket) => {
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      // Nagle would batch the request itself; a capture POST is one small write followed by a wait, so
      // there is nothing to batch and delaying it only adds latency to the request that starts the work.
      socket.setNoDelay(true);
    });

    req.on("error", failWith);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** @param {string | null} payload */
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

/**
 * @param {import("node:http").IncomingMessage} res
 * @returns {Promise<string>}
 */
function collect(res) {
  return new Promise((resolve, reject) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (/** @type {string} */ chunk) => { text += chunk; });
    res.on("end", () => resolve(text));
    res.on("error", reject);
  });
}

/**
 * Parsed JSON, or undefined — a worker error page is not a parse failure worth throwing over.
 * @param {string} text
 */
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
