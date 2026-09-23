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
 * THE THIRD CHANNEL: fields that are COMPARED AND NAMED, and that gate nothing — #2063.
 *
 * `MUST_MATCH` above is a capture gate in both its channels. A disagreement there sets `consistent:
 * false` and `capture-fleet-guard` exits 3; a field any compared guest fails to report lands in
 * `fields.coverage` and, since #2047, exits 3 as well. So a field that belongs in the REPORT but must not
 * refuse a run has nowhere to go in either — and adding it to one of them anyway is not a small
 * mis-filing: `nodeVersion` is reported by 10 of 10 guests today, so it would refuse every capture during
 * the next rolling deploy, and `displayAdapter` is reported by nobody, so it would refuse every capture
 * immediately.
 *
 * `ceo` ruled the order on #2063, 2026-09-23: **report it, then pin provisioning so the fleet converges,
 * and only then may it join `MUST_MATCH`** (that last step is #2170). The reason is measured rather than
 * cautious — the corpus is ALREADY mixed on `nodeVersion` and has been since at least 2026-09-12, so
 * gating on it today would refuse every capture on a condition every published number was measured
 * across.
 *
 * So these fields are compared exactly as the gating ones are, and their drift is named on the verdict
 * line with each guest's value — but they contribute to NEITHER `mismatches` NOR `fields.coverage`, which
 * are the only two things any gate reads. A fleet differing on one of them is `consistent: true`.
 *
 * A field NOBODY reports is `unreported` here rather than silent, which is the same distinction #1997
 * drew for the gating fields: a field compared on nobody draws no values to disagree about and would
 * otherwise read exactly like a field every guest agrees on. It is the state `displayAdapter` will be in
 * until a worker carrying the field is deployed, and it must be readable as such without refusing
 * anything.
 */
export const REPORTED_ONLY = [
  // Measured on the live fleet 2026-09-23T06:55Z, read from every guest's own `/health`: workers 2-6 on
  // v24.19.0 and workers 7-11 on v24.20.0, every other reported field identical across all ten. The split
  // is permanent by construction rather than by accident -- `packages.yml` resolved "whatever is current
  // LTS today" fresh on every run and never upgraded an existing install -- so two boxes provisioned
  // either side of a Node release diverge for ever. The pin in `defaults/main.yml` is what converges them.
  { path: "nodeVersion", why: "the guest's Node runtime is recorded into every corpus record " +
      "(`export-screenreader-dataset.mjs`) and reported by every `/health`, so a split fleet writes two " +
      "runtimes into one corpus. NOT a gate: 2,870 records of the training corpus are already mixed on " +
      "it -- 1,266 on v24.19.0 against 1,564 on v24.20.0 -- and every published acceptance number was " +
      "measured across that mixture (#2063)" },
  // `ceo`'s fold-in on the same row: "nothing in this repo reports the display ADAPTER either ... whatever
  // shape this row lands for 'reported, visible, not yet a gate', the adapter belongs in it rather than in
  // a fourth row." It is the seam `displayMode` sat on -- workers 2-6 on the Intel adapter, 7-11 on
  // Microsoft's Basic Display Adapter after a driver install failed rc 1014 -- and it is a DIFFERENT field
  // from the driver VERSION, which `ceo` ruled on #1567 does not split the fleet.
  { path: "displayAdapter", why: "the adapter is what decides whether a pinned display mode can be held " +
      "at all -- workers 7-11 fell back to Microsoft's Basic Display Adapter and captured at 640x480 " +
      "under a `provisionRevision` identical to their peers'. NOT a gate: no deployed worker reports it " +
      "yet, so it reads unknown across the fleet until one does, and a gate would refuse every capture " +
      "immediately (#2063)" },
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
 * One reported-only field that has something to say, and WHICH thing it is saying — #2063.
 *
 * `drifted` is the guests giving more than one value; `unreported` is some or all of them giving none.
 * Two states rather than a boolean because the REMEDY differs and the report has to name it: drift sends
 * a reader to the provisioning pin, silence sends them to the worker deploy. Neither is a refusal.
 *
 * It carries `reported`/`asked` for the same reason `FieldReporters` does — a count is what lets a reader
 * tell 0 of 10 from 9 of 10 — and the values map for the reason `Mismatch` does: drift detected and not
 * located is not actionable.
 *
 * @typedef {{field: string, why: string, values: Record<string, unknown>, reported: number,
 *   asked: number, state: "drifted" | "unreported"}} ReportedDrift
 */

/**
 * ONE FIELD READ ACROSS THE FLEET, before anybody decides what it means.
 *
 * Split out from `fleetConsistency` when the third channel arrived (#2063), because the READING and the
 * CONSEQUENCE are two things and only the second differs between the channels: `MUST_MATCH` turns a
 * reading into a mismatch and a coverage row, `REPORTED_ONLY` turns the same reading into a named drift
 * that gates nothing. One reader means the two channels cannot drift apart in how they compare — a
 * second copy of this loop is how a "reported-only" field would end up counted differently from a gating
 * one and nobody would know which was right.
 *
 * @typedef {{worker: string, environment?: Record<string, unknown>, policy?: Record<string, unknown>}} Guest
 * @typedef {{field: string, why: string, values: Record<string, unknown>, reported: number, asked: number}} Reading
 *
 * @param {Guest[]} present
 * @param {{field: string, why: string, source: (guest: Guest) => Record<string, unknown> | undefined,
 *   key: string}} ask `source` is the BLOCK this field lives in, not the value: coverage has to tell
 *   "the guest did not report this field" from "this caller never collected that block at all", and only
 *   the block answers the second
 * @returns {Reading}
 */
function readField(present, { field, why, source, key }) {
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
  return { field, why, values, reported, asked };
}

/** How many distinct values the guests actually gave for one field. @param {Reading} reading */
function distinctValues({ values }) {
  return new Set(Object.values(values)).size;
}

/**
 * THE GATING CONSEQUENCE of a set of readings: what disagrees, and what nobody was asked.
 *
 * @param {Reading[]} readings
 * @returns {{mismatches: Mismatch[], fields: FieldCoverage}}
 */
function gateOn(readings) {
  /** @type {Mismatch[]} */
  const mismatches = [];
  /** @type {FieldCoverage} */
  const fields = { compared: [], unchecked: [], coverage: [] };
  for (const reading of readings) {
    const { field, why, values, reported, asked } = reading;
    // A FIELD NO GUEST REPORTED IS CANNOT ASK, NOT ALL AGREE. One value from one guest still counts as
    // compared -- that is the rolling-deploy case the skip above is for, and it is a different claim
    // from nobody having been asked at all. How MANY reported it is a third claim again, and it goes on
    // `coverage` rather than into this partition: the lists answer the remedy, the count answers the
    // verdict (#2019).
    if (asked > 0) {
      (reported > 0 ? fields.compared : fields.unchecked).push(field);
      fields.coverage.push({ field, reported, asked });
    }
    if (distinctValues(reading) > 1) mismatches.push({ field, why, values });
  }
  return { mismatches, fields };
}

/**
 * THE REPORTED-ONLY CONSEQUENCE: the same readings, as something to SAY rather than something to refuse.
 *
 * A field the guests agree on yields NOTHING, and that is the half of this that a test can most easily
 * lose. `drifted` and `unreported` are both findings; agreement is not, and an implementation that
 * returned every reported-only field regardless would satisfy "the drift is named" while naming a fleet
 * that has none.
 *
 * `asked === 0` yields nothing either, for the reason `gateOn` skips it: a block this caller never
 * collected is a fact about the probe.
 *
 * @param {Reading[]} readings
 * @returns {ReportedDrift[]}
 */
function driftOf(readings) {
  return readings.flatMap((reading) => {
    const state = driftState(reading);
    return state === null ? [] : [{ ...reading, state }];
  });
}

/**
 * @param {Reading} reading
 * @returns {"drifted" | "unreported" | null}
 */
function driftState(reading) {
  if (distinctValues(reading) > 1) return "drifted";
  // NOT REPORTED BY EVERYBODY WHO WAS ASKED, which covers #1997's nobody and #2019's some in one line --
  // for a GATING field those are two refusals with different remedies, and here they are one sentence
  // with the counts in it, because nothing is being refused.
  if (reading.asked > 0 && reading.reported < reading.asked) return "unreported";
  return null;
}

/**
 * Compare guests field by field.
 *
 * @param {Guest[]} guests
 * @returns {{consistent: boolean, mismatches: Mismatch[], compared: number, fields: FieldCoverage,
 *   reportedOnly: ReportedDrift[]}}
 *   `compared` is how many guests the verdict is actually ABOUT -- #920. A guest with no `environment`
 *   and no `policy` is dropped below before comparing, so it is not the length of what was passed in,
 *   and a caller that reports `consistent` without it is stating agreement over a set it cannot name.
 *   `fields` is that same question one axis over: WHICH fields the verdict is about -- #1997.
 *   `reportedOnly` is the third channel (#2063): compared, named, and part of NEITHER of the two above,
 *   which is what makes it something to report rather than something to refuse.
 */
export function fleetConsistency(guests) {
  const present = (guests ?? []).filter((g) => g && (g.environment || g.policy));
  // One guest is trivially consistent with itself, and zero is not a fleet. Neither is a finding, and
  // neither is a field nothing compared: with nobody to compare against, coverage is not a question yet.
  if (present.length < 2) {
    // A FRESH object rather than a shared constant: this is returned to a caller, and one shared literal
    // is one `push` away from a coverage list that grows across unrelated readings.
    return { consistent: true, mismatches: [], compared: present.length,
      fields: { compared: [], unchecked: [], coverage: [] }, reportedOnly: [] };
  }
  /** @param {Guest} guest */
  const environmentOf = (guest) => guest.environment;
  const gated = [
    ...MUST_MATCH.map(({ path, why }) =>
      readField(present, { field: path, why, source: environmentOf, key: path })),
    ...POLICY_MUST_MATCH.map((name) => readField(present, { field: `edgePolicy.${name}`,
      why: "guests with different browser behaviour are not interchangeable",
      source: (guest) => guest.policy, key: name })),
  ];
  const { mismatches, fields } = gateOn(gated);
  const reportedOnly = driftOf(REPORTED_ONLY.map(({ path, why }) =>
    readField(present, { field: path, why, source: environmentOf, key: path })));
  return { consistent: mismatches.length === 0, mismatches, compared: present.length, fields,
    reportedOnly };
}

/**
 * One line per reported-only field that has something to say, in `describeMismatches`'s own shape.
 *
 * SEPARATE FROM `describeMismatches` rather than a flag on it, because the two lines make different
 * claims and a reader has to be able to tell them apart at a glance: that one says the fleet is not
 * usable for a capture run, this one says the fleet is not identical and the run may proceed anyway.
 * Folding them would put the ruling's own distinction behind a boolean argument.
 *
 * @param {ReportedDrift[]} drifts
 * @returns {string[]}
 */
export function describeReportedOnly(drifts) {
  return (drifts ?? []).map((drift) => `${drift.field}: ${reportedDetail(drift)} — ${drift.why}`);
}

/**
 * NAMED WITH EACH GUEST'S VALUE where there is one, and with the count where there is not.
 *
 * `not reported by any of 10 guests` is a different finding from `.2=v24.19.0 .7=v24.20.0` and from
 * `.2=v24.19.0 (1 of 10 guests reported it)`, and a reader acts differently on each: the first sends
 * them to the worker code, the second to the boxes, the third to the deploy that has not finished.
 *
 * @param {ReportedDrift} drift
 */
function reportedDetail({ values, reported, asked, state }) {
  const label = labelWorkers(Object.keys(values));
  const detail = Object.entries(values).map(([worker, value]) => `${label.get(worker)}=${value}`).join(" ");
  if (state === "drifted") return detail;
  if (reported === 0) return `not reported by any of ${asked} guests`;
  return `${detail} (${reported} of ${asked} guests reported it)`;
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
