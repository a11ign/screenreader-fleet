/**
 * Are the guests actually interchangeable?
 *
 * The pool assumes they are. `captureAcrossPool` dispatches a case to whichever worker is free, the
 * cache lets any guest reuse another's evidence, and a good/bad pair is only comparable because both
 * halves came from equivalent machines. Every one of those assumptions is silently false the moment
 * two guests differ.
 *
 * They did differ, twice in one day, and neither was caught by tooling:
 *
 *   - Edge auto-updated to 151 on one guest while the others stayed on 150, despite the updater being
 *     policy-disabled. The cache key covers `browserVersion`, so evidence was not corrupted — but hit
 *     rates halved and the corpus became heterogeneous.
 *   - `StartupBoostEnabled` read 1 on two guests and 0 on a third. Nothing keys on that at all.
 *
 * The first was noticed by reading a boot log by eye; the second by a human looking at a screenshot of
 * a guest console. Neither is a detection mechanism. This is.
 *
 * Deliberately NOT fatal. A run on slightly mismatched guests is worse than one on matched guests and
 * far better than no run, and this project's rule is that a diagnostic must never be the thing that
 * takes the pool offline. It reports; the operator decides.
 */

/**
 * Fields that must match across the fleet, and why each one matters.
 *
 * `workerCode` is absent on purpose: it changes when a comment changes, and the deploy tooling already
 * verifies it against the checkout. Flagging it here would cry wolf on every reworded line.
 */
export const MUST_MATCH = [
  { path: "browserVersion", why: "Edge renders and announces differently across releases; it is in the cache key" },
  { path: "screenReaderVersion", why: "NVDA's wording changes between releases; it is in the cache key" },
  { path: "guidepupVersion", why: "guidepup parses NVDA's speech before we see it — 0.29.2 emitted an " +
      "intermittent U+FFFC where 0.31.0 emits a consistent empty segment, for the same page" },
  { path: "windowsVersion", why: "a second OS image would blend two corpora into one" },
  { path: "architecture", why: "ARM64 and x64 guests are not interchangeable evidence" },
  { path: "captureProtocol", why: "a guest on an older protocol produces evidence that means something else" },
  // A CACHE KEY that was not a consistency field, which is the worst combination.
  //
  // `provisionRevision` records what the guest actually has -- NVDA's config, Edge's policies,
  // ForegroundLockTimeout -- all of which change the evidence. It is already in the cache key
  // (`capture-cache.mjs`), so a fleet where one guest has been re-provisioned and the others report
  // `"unstamped"` produces two evidence populations. Nothing warned: the cache merely stopped hitting,
  // which reads as ordinary churn rather than as a split fleet. Re-provision the pool together.
  { path: "provisionRevision", why: "a re-provisioned guest has different NVDA/Edge configuration, and " +
      "it is already a cache key -- a split fleet shows up only as unexplained cache misses" },
];

/** Edge policy values every guest must agree on, checked separately because they come from /diagnostics. */
export const POLICY_MUST_MATCH = ["StartupBoostEnabled", "BackgroundModeEnabled"];

const get = (object, key) => (object ?? {})[key];

/**
 * Compare guests field by field.
 *
 * @param {Array<{worker: string, environment?: object, policy?: object}>} guests
 * @returns {{consistent: boolean, mismatches: Array<{field: string, why: string, values: object}>}}
 */
export function fleetConsistency(guests) {
  const present = (guests ?? []).filter((g) => g && (g.environment || g.policy));
  // One guest is trivially consistent with itself, and zero is not a fleet. Neither is a finding.
  if (present.length < 2) return { consistent: true, mismatches: [] };

  const mismatches = [];
  const check = (field, why, read) => {
    const values = {};
    for (const guest of present) {
      const value = read(guest);
      // Absent is not a mismatch: an older worker that does not report a field must not be flagged
      // against newer ones. Only DIFFERING known values are evidence of drift.
      if (value !== undefined && value !== null) values[guest.worker] = value;
    }
    if (new Set(Object.values(values)).size > 1) mismatches.push({ field, why, values });
  };

  for (const { path, why } of MUST_MATCH) check(path, why, (g) => get(g.environment, path));
  for (const name of POLICY_MUST_MATCH) {
    check(`edgePolicy.${name}`, "guests with different browser behaviour are not interchangeable",
      (g) => get(g.policy, name));
  }
  return { consistent: mismatches.length === 0, mismatches };
}

/** One line per mismatch, naming the guests, so the report is actionable rather than just alarming. */
export function describeMismatches(mismatches) {
  return (mismatches ?? []).map(({ field, values, why }) => {
    const label = labelWorkers(Object.keys(values));
    const detail = Object.entries(values).map(([worker, value]) => `${label.get(worker)}=${value}`).join(" ");
    return `${field}: ${detail} — ${why}`;
  });
}

/**
 * A short, UNAMBIGUOUS name per worker.
 *
 * `.4` is the right label for `http://REDACTED-INTERNAL-ADDRESS:8765` in a table, and it is the wrong one the moment
 * two workers share a last octet — two boxes on one host with different ports, or two subnets that
 * happen to meet. The report then says which FIELD drifted and gives two identically-named values, which
 * is drift detected and not located: `browserVersion: .1=151.0.1 .1=150.0.9`.
 *
 * So the short form is used only while it distinguishes, and the full host:port otherwise. Shortening is
 * a readability optimisation, and it must never cost the thing the line exists to convey.
 */
function labelWorkers(workers) {
  const short = new Map(workers.map((w) => [w, shortWorker(w)]));
  const counts = new Map();
  for (const name of short.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(workers.map((w) =>
    [w, counts.get(short.get(w)) > 1 ? hostAndPort(w) : short.get(w)]));
}

/** `http://REDACTED-INTERNAL-ADDRESS:8765` is noise in a table; `.4` is not. */
function shortWorker(worker) {
  const host = /\/\/([^:/]+)/.exec(worker)?.[1] ?? worker;
  return host.includes(".") ? `.${host.split(".").pop()}` : host;
}

function hostAndPort(worker) {
  return /\/\/(.+?)\/?$/.exec(worker)?.[1] ?? worker;
}
