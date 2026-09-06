/**
 * REFUSE A DEPLOY THAT WOULD SILENTLY INVALIDATE THE CORPUS.
 *
 * `CAPTURE_PROTOCOL_VERSION` is a capture-cache key. Shipping a change to it invalidates every cached
 * capture — 2,122 of them, about four hours of fleet time — and that is sometimes exactly what you want.
 * What must never happen is it going out without somebody deciding.
 *
 * **The guard existed and reached only the DEPRECATED path.** `deploy-worker.mjs` refuses without
 * `--allow-protocol-change`, and that script is `utmctl file push` against a VM UUID: it cannot reach a
 * bare-metal worker and fails immediately off macOS. Every box in `inventory.yml` is bare metal and
 * deploys through `fleet:deploy`, which had no such check. So the only live deploy path was the unguarded
 * one — this repo's signature defect (a remedy that reaches one call site when the behaviour reaches
 * several) with the remedy on the path nobody uses.
 *
 * **This asks the FLEET, not git, and that is the stronger question.** The UTM guard compares the working
 * tree against HEAD, which answers "did I commit the bump". Useful, and not the thing at risk: what
 * decides whether the cache survives is whether the version about to ship differs from the one the boxes
 * are *already serving*, because that is the version every cached capture was stamped under. Reading it
 * from `/health` also means the check shares no failure mode with the action — the deploy goes over SSH,
 * the verification over HTTP — which is this repo's rule after a hash-check that returned EMPTY whenever
 * the channel it used was broken, and read as a flaky tool rather than a failed deploy.
 */

/** How long a worker gets to answer `/health` before it counts as unreachable. */
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Decide whether a deploy may proceed.
 *
 * @param {{ local: number|string|null, served: {worker: string, protocol: number|string|null}[],
 *           allowed: boolean, source?: string }} input
 * @returns {{ refuse: boolean, message: string }}
 */
export function protocolVerdict({ local, served, allowed, source }) {
  if (local === null || local === undefined) {
    // NAMES THE FILE IT WAS GIVEN, never a hardcoded one. This message said "from capture-core.mjs" while
    // the caller had long since been pointed elsewhere, so the one sentence a broken guard prints sent the
    // reader to a file that was not the problem.
    return { refuse: true, message: `cannot read CAPTURE_PROTOCOL_VERSION from ${source ?? "the worker "
      + "source"}, so this deploy cannot say whether it would invalidate the corpus. That is a broken `
      + "guard, not a clean one." };
  }
  const reachable = served.filter((s) => s.protocol !== null && s.protocol !== undefined);
  // EXAMINED NOTHING IS NOT AGREEMENT. If no worker answered, the guard has no opinion — and a guard with
  // no opinion that reports success is the `evidence:check` defect: it exited 0 saying "evidence unchanged"
  // having compared 2 of 48, because its own guard covered only `compared === 0` and called that "the
  // extreme case rather than a different one". Nothing here is the extreme case of that; it IS that.
  if (reachable.length === 0) {
    return { refuse: !allowed, message: "no worker answered /health, so nothing could say which "
      + `CAPTURE_PROTOCOL_VERSION the fleet is serving. Local is ${local}. Deploying blind could invalidate `
      + "every cached capture. Check `npm run fleet:status`, or pass --allow-protocol-change if you mean it." };
  }
  const differing = reachable.filter((s) => String(s.protocol) !== String(local));
  if (differing.length === 0) return { refuse: false, message: "" };
  const detail = differing.map((s) => `    ${s.worker} serves ${s.protocol}`).join("\n");
  if (allowed) {
    return { refuse: false, message: `\n  Deploying CAPTURE_PROTOCOL_VERSION ${local} as requested.\n${detail}\n`
      + "  Every cached capture becomes invalid and the next run recaptures all of them.\n" };
  }
  return { refuse: true, message:
    `\nREFUSING TO DEPLOY: this checkout has CAPTURE_PROTOCOL_VERSION = ${local}, and the fleet does not.\n\n`
    + `${detail}\n\n`
    + "That value is a capture-cache key, so deploying it invalidates every cached capture and forces a\n"
    + "full recapture (~2,122 captures, about four hours of fleet time).\n\n"
    + "  If that is what you want:   npm run fleet:deploy -- --allow-protocol-change\n"
    + "  If it is not:               check what changed in packages/nvda-worker/src/capture-core.mjs\n" };
}

/**
 * Ask each worker which protocol it serves.
 *
 * A worker that cannot be reached reports `null` rather than being dropped, so the caller can tell "the
 * fleet agrees" from "we could not ask" — the distinction the verdict above turns on.
 *
 * @param {string[]} urls
 * @returns {Promise<{worker: string, protocol: number|string|null}[]>}
 */
export async function servedProtocols(urls) {
  return Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`,
        { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const health = await response.json();
      // `?? null` and never `?? 0`: a worker predating the field has no opinion, and reading absence as a
      // number is the defect this project pays for most often.
      return { worker: url, protocol: health?.environment?.captureProtocol ?? null };
    } catch {
      // Deliberately not rethrown: unreachable is a VERDICT here, handled by `protocolVerdict`, not an
      // error. Swallowing it would be wrong only if nothing downstream distinguished it, and something does.
      return { worker: url, protocol: null };
    }
  }));
}
