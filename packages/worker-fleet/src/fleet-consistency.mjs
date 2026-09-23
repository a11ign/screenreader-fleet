// @ts-check
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
  { path: "browserProfile", why: "a COLD browser profile is not the same evidence as a warm one: a fresh " +
      "`--user-data-dir` shows Edge's first-run surface, which NVDA's quick-nav escapes into and records " +
      "as phantom page content, and a learning profile is what drove the U+FFFC artefact from 3% to 31% " +
      "of affected captures. Two guests on different profiles are not interchangeable, and it is in the " +
      "cache key for the same reason. `adopted` on both sides means both predate the stamp, which is a " +
      "match rather than an unknown" },
  { path: "screenReaderSettings", why: "a guest capturing with `reportLanguage` off is blind to 3.1.2 and " +
      "one with it on is not — the same page yields different transcripts, so the two are not " +
      "interchangeable evidence. It is in the cache key for the same reason" },
  // A CACHE KEY that was not a consistency field, which is the worst combination.
  //
  // `provisionRevision` records what the guest actually has -- NVDA's config, Edge's policies,
  // ForegroundLockTimeout -- all of which change the evidence. It is already in the cache key
  // (`capture-cache.mjs`), so a fleet where one guest has been re-provisioned and the others report
  // `"unstamped"` produces two evidence populations. Nothing warned: the cache merely stopped hitting,
  // which reads as ordinary churn rather than as a split fleet. Re-provision the pool together.
  { path: "provisionRevision", why: "a re-provisioned guest has different NVDA/Edge configuration, and " +
      "it is already a cache key -- a split fleet shows up only as unexplained cache misses" },
  // A UNIFORMITY CLAIM PRINTED OVER A PROPERTY NOTHING CHECKED, which is the worst failure this file
  // can have -- worse than missing a field, because the operator was told the opposite.
  //
  // `fleet:status` printed "fleet CONSISTENT across 10 of 10 -- these workers are interchangeable for
  // capture" at 2026-09-22T18:21Z over a fleet running 1024x768 on five guests and 640x480 on the other
  // five (#1953; measured read-only on the live fleet, #1567/#1955). The nine fields above were all
  // matched and all true; the sentence they produced was not.
  //
  // `provisionRevision` does not already cover it, and this is the point. That stamp is written by the
  // provisioning script itself, so it records WHICH PROVISIONING RAN rather than what it achieved: a
  // guest whose display-driver install failed still gets the new stamp. All ten guests can report an
  // identical revision while five of them sit at 640x480 on a fallback adapter. A stamp cannot fail
  // closed on a thing it does not read.
  { path: "displayMode", why: "a guest capturing on a 640x480 desktop and one on 1024x768 are not " +
      "interchangeable evidence: the window is what a real display holds (#1561), and a page's CSS can " +
      "hide content below a width -- metoffice hides its h1 under 1280px. NOT a cache key: adding one " +
      "invalidates every cached capture, which is a separate and far more expensive decision than making " +
      "this sentence honest" },
  // The PIN, which is not the same field as the DESKTOP above (#1561). `displayMode` is what the screen
  // holds; this is what the worker asks Edge for, and a guest still running the pre-pin code asks for
  // nothing at all and gets `--start-maximized`. Both guests report the same `captureProtocol`, so the
  // protocol cannot separate them and a rolling deploy would otherwise split the corpus in silence --
  // which is the shape `provisionRevision` two entries up is here for, one deploy later.
  //
  // UNLIKE `displayMode`, this one IS a cache key (`environmentKey`), and that is a deliberate asymmetry
  // rather than an oversight: pinning the window is what makes the width a property of the capture rather
  // than of the box it ran on, so it is the value a stored capture can honestly be keyed by.
  { path: "windowSize", why: "a capture taken in a pinned 1024x768 window and one taken maximized on " +
      "whatever the desktop gave are not interchangeable evidence -- a page's CSS can hide content below " +
      "a width, and metoffice hides its h1 under 1280px. It is in the cache key (#1561), so a split " +
      "fleet also writes two evidence populations" },
];

/**
 * One field the guests disagree about, and the guests' values for it.
 *
 * Named once because it is produced by `fleetConsistency` and consumed by `describeMismatches`, and the
 * two had already drifted apart the moment either was annotated — `object` on one side against
 * `Record<string, unknown>` on the other, which typecheck caught in the test that calls them in sequence.
 * Two spellings of one shape is the duplication this repo names as its most expensive recurring defect,
 * and a typedef is the cheapest form of "delete a copy".
 *
 * @typedef {{field: string, why: string, values: Record<string, unknown>}} Mismatch
 */

/** Edge policy values every guest must agree on, checked separately because they come from /diagnostics. */
export const POLICY_MUST_MATCH = ["StartupBoostEnabled", "BackgroundModeEnabled"];

/**
 * Which fields the verdict is actually ABOUT -- #1997.
 *
 * `compared` NAMES the fields at least one guest reported a value for; `unchecked` names the ones that
 * drew a value from NOBODY. The second list exists because `check()` below skips an absent value, which
 * is right (a rolling deploy must not flag the guest it has not reached yet) and has a cost: a field no
 * guest reports contributes no values, `new Set([]).size > 1` is false, and it reads as agreement.
 * A field compared on nobody and a field equal on everybody produced the IDENTICAL verdict.
 *
 * Measured 2026-09-22T20:09Z on the live fleet, at the merge of #1953: nine fields at 10/10 guests and
 * `displayMode` at 0/10, and `fleet:status` printed `fleet CONSISTENT across 10 of 10 -- these workers
 * are interchangeable for capture`. The display was still not compared. Naming the two lists is what
 * lets a reader tell "they agree" from "nobody was asked".
 *
 * `coverage` IS THE SAME QUESTION WITHOUT THE THRESHOLD -- #2019. The two lists above are a PARTITION on
 * "did anybody report it", which answers 0-of-10 and says nothing about 1-of-10; `fleet:status` read the
 * second as agreement about ten guests on the strength of one. So every asked field also carries how many
 * of the asked guests actually reported it, and the verdict draws its own line. `compared`/`unchecked`
 * stay because they are what a caller greps for the REMEDY -- a field at 0 sends a reader to the field,
 * a field at k sends them to the boxes -- and `coverage` is the measurement both are derived from.
 *
 * @typedef {{field: string, reported: number, asked: number}} FieldReporters
 * @typedef {{compared: string[], unchecked: string[], coverage: FieldReporters[]}} FieldCoverage
 */

/**
 * Compare guests field by field.
 *
 * @param {Array<{worker: string, environment?: Record<string, unknown>, policy?: Record<string, unknown>}>} guests
 * @returns {{consistent: boolean, mismatches: Mismatch[], compared: number, fields: FieldCoverage}}
 *   `compared` is how many guests the verdict is actually ABOUT -- #920. A guest with no `environment`
 *   and no `policy` is dropped below before comparing, so it is not the length of what was passed in,
 *   and a caller that reports `consistent` without it is stating agreement over a set it cannot name.
 *   `fields` is that same question one axis over: WHICH fields the verdict is about -- #1997.
 */
export function fleetConsistency(guests) {
  const present = (guests ?? []).filter((g) => g && (g.environment || g.policy));
  // One guest is trivially consistent with itself, and zero is not a fleet. Neither is a finding, and
  // neither is a field nothing compared: with nobody to compare against, coverage is not a question yet.
  if (present.length < 2) {
    // A FRESH object rather than a shared constant: this is returned to a caller, and one shared literal
    // is one `push` away from a coverage list that grows across unrelated readings.
    return { consistent: true, mismatches: [], compared: present.length,
      fields: { compared: [], unchecked: [], coverage: [] } };
  }

  /** @type {Mismatch[]} */
  const mismatches = [];
  /** @type {FieldCoverage} */
  const fields = { compared: [], unchecked: [], coverage: [] };
  /**
   * @param {string} field
   * @param {string} why
   * @param {(guest: {worker: string, environment?: Record<string, unknown>, policy?: Record<string, unknown>}) => Record<string, unknown> | undefined} source
   *   the BLOCK this field lives in, not the value: coverage has to tell "the guest did not report this
   *   field" from "this caller never collected that block at all", and only the block answers the second
   * @param {string} key
   */
  const check = (field, why, source, key) => {
    /** @type {Record<string, unknown>} */
    const values = {};
    // THE REPORTER COUNT IS COUNTED, NEVER READ OFF `values` -- #2019, and #2018 is why. The map is keyed
    // by worker name, and a caller that supplies guests without one collapses every guest onto a single
    // `undefined` key -- which `capture-real-pages.mjs` does -- so `Object.keys(values).length` reads 1
    // for any number of reporting guests, understating coverage in exactly the cases a coverage number
    // exists for. `asked` counts the guests that carried the BLOCK; `reported` counts the ones that
    // carried a VALUE in it; both are incremented on the guest, so neither can be collapsed by a key.
    let asked = 0;
    let reported = 0;
    for (const guest of present) {
      const block = source(guest);
      // A BLOCK THIS CALLER DID NOT COLLECT IS A FACT ABOUT THE PROBE, NOT THE FLEET. `/health` carries
      // no policy, so every production caller passes `policy: undefined`; calling those fields
      // "compared on nobody" would report a permanent gap on an axis nobody asked about, and drown the
      // one this list exists to surface.
      if (block === undefined || block === null) continue;
      asked += 1;
      const value = block[key];
      // Absent is not a mismatch: an older worker that does not report a field must not be flagged
      // against newer ones. Only DIFFERING known values are evidence of drift.
      if (value !== undefined && value !== null) {
        reported += 1;
        values[guest.worker] = value;
      }
    }
    // A FIELD NO GUEST REPORTED IS CANNOT ASK, NOT ALL AGREE. One value from one guest still counts as
    // compared -- that is the rolling-deploy case the skip above is for, and it is a different claim
    // from nobody having been asked at all. How MANY reported it is a third claim again, and it goes on
    // `coverage` rather than into this partition: the lists answer the remedy, the count answers the
    // verdict (#2019).
    if (asked > 0) {
      (reported > 0 ? fields.compared : fields.unchecked).push(field);
      fields.coverage.push({ field, reported, asked });
    }
    if (new Set(Object.values(values)).size > 1) mismatches.push({ field, why, values });
  };

  for (const { path, why } of MUST_MATCH) check(path, why, (g) => g.environment, path);
  for (const name of POLICY_MUST_MATCH) {
    check(`edgePolicy.${name}`, "guests with different browser behaviour are not interchangeable",
      (g) => g.policy, name);
  }
  return { consistent: mismatches.length === 0, mismatches, compared: present.length, fields };
}

/**
 * One line per mismatch, naming the guests, so the report is actionable rather than just alarming.
 *
 * @param {Mismatch[]} mismatches
 * @returns {string[]}
 */
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
 * `.4` is the right label for a guest's full `http://<address>:8765` in a table, and it is the wrong one the moment
 * two workers share a last octet — two boxes on one host with different ports, or two subnets that
 * happen to meet. The report then says which FIELD drifted and gives two identically-named values, which
 * is drift detected and not located: `browserVersion: .1=151.0.1 .1=150.0.9`.
 *
 * So the short form is used only while it distinguishes, and the full host:port otherwise. Shortening is
 * a readability optimisation, and it must never cost the thing the line exists to convey.
 */
/**
 * @param {string[]} workers
 * @returns {Map<string, string>}
 */
function labelWorkers(workers) {
  const short = new Map(workers.map((w) => [w, shortWorker(w)]));
  const counts = new Map();
  for (const name of short.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(workers.map((w) => {
    // `short.get(w)` cannot miss — every worker was put in the map on the line above — but TypeScript
    // cannot know that, and `?? w` is the honest fallback rather than a non-null assertion: an unlabelled
    // worker printed as its own URL is still a located mismatch, which is what this function is for.
    const name = short.get(w) ?? w;
    return [w, (counts.get(name) ?? 0) > 1 ? hostAndPort(w) : name];
  }));
}

/** a guest's full `http://<address>:8765` is noise in a table; `.4` is not. @param {string} worker */
function shortWorker(worker) {
  const host = /\/\/([^:/]+)/.exec(worker)?.[1] ?? worker;
  return host.includes(".") ? `.${host.split(".").pop()}` : host;
}

/** @param {string} worker */
function hostAndPort(worker) {
  return /\/\/(.+?)\/?$/.exec(worker)?.[1] ?? worker;
}
