/**
 * A re-enabled Edge updater is readable from the fleet: `edgeUpdaterGuard.state` is compared in `REPORTED_ONLY`
 * (#5021, part of #4405).
 *
 * The worker runs unelevated and cannot read the updater's tasks, so it reports the elevated guard task's record
 * (`{state, checkedAt, reenabled}`) in `/health`'s `environment`. Only `state` is comparable: `checkedAt` differs on
 * every box by construction. The field is REPORTED, not gated: it reads `unreported` on every box until a worker that
 * carries it is released and deployed, so a gate would refuse every capture run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MUST_MATCH, REPORTED_ONLY, describeReportedOnly, fleetConsistency, type Guest } from "./fleet-consistency.ts";

const FIELD = "edgeUpdaterGuard.state";
const guard = (state: string, checkedAt = "2026-10-11T12:00:00.000Z", reenabled: string[] = []) =>
  ({ state, checkedAt, reenabled });
const guest = (worker: string, environment: Record<string, unknown>): Guest => ({ worker, environment });
const drift = (fleet: Guest[]) => fleetConsistency(fleet).reportedOnly.find((d) => d.field === FIELD);

test("a box whose updater came back drifts against its peers, and the fleet is still consistent", () => {
  const verdict = fleetConsistency([
    guest("http://10.0.0.2:8765", { edgeUpdaterGuard: guard("ok") }),
    guest("http://10.0.0.3:8765", { edgeUpdaterGuard: guard("drift", "2026-10-11T12:00:00.000Z", ["task:MicrosoftEdgeUpdateTaskMachineUA"]) }),
    guest("http://10.0.0.4:8765", { edgeUpdaterGuard: guard("stale") }),
    guest("http://10.0.0.5:8765", { edgeUpdaterGuard: guard("absent") }),
  ]);
  const found = verdict.reportedOnly.find((d) => d.field === FIELD);
  assert.equal(found?.state, "drifted");
  assert.deepEqual(found?.values, {
    "http://10.0.0.2:8765": "ok", "http://10.0.0.3:8765": "drift",
    "http://10.0.0.4:8765": "stale", "http://10.0.0.5:8765": "absent",
  });
  assert.equal(verdict.consistent, true, "edgeUpdaterGuard is reported, not a gate");
  assert.deepEqual(verdict.mismatches, []);
  assert.ok(!verdict.fields.coverage.some((row) => row.field === FIELD), "a gate's coverage row would refuse captures");
  assert.match(describeReportedOnly(verdict.reportedOnly).join("\n"),
    /edgeUpdaterGuard\.state: \.2=ok \.3=drift \.4=stale \.5=absent/);
});

test("an unreadable record (\"unknown\") beside a healthy one is named, and gates nothing", () => {
  const verdict = fleetConsistency([
    guest("http://10.0.0.2:8765", { edgeUpdaterGuard: guard("ok") }),
    guest("http://10.0.0.3:8765", { edgeUpdaterGuard: { state: "unknown", checkedAt: null, reenabled: [] } }),
  ]);
  assert.equal(verdict.reportedOnly.find((d) => d.field === FIELD)?.state, "drifted");
  assert.equal(verdict.consistent, true);
  assert.deepEqual(verdict.mismatches, []);
});

test("negative control: guards that agree on `state` do not drift, whatever their checkedAt says", () => {
  // Comparing the whole record would call every healthy fleet drifted: two guards never ran in the same second.
  const found = drift([
    guest("http://10.0.0.2:8765", { edgeUpdaterGuard: guard("ok", "2026-10-11T11:58:30.1234567Z") }),
    guest("http://10.0.0.3:8765", { edgeUpdaterGuard: guard("ok", "2026-10-11T11:51:02.9876543Z") }),
  ]);
  assert.equal(found, undefined, "agreeing guards were reported as drifting");
});

test("a fleet whose workers do not send edgeUpdaterGuard yet reads unreported and is still consistent", () => {
  const verdict = fleetConsistency([
    guest("http://10.0.0.2:8765", { windowsVersion: "Microsoft Windows 11 Pro 10.0.26100" }),
    guest("http://10.0.0.3:8765", { windowsVersion: "Microsoft Windows 11 Pro 10.0.26100" }),
  ]);
  const found = verdict.reportedOnly.find((d) => d.field === FIELD);
  assert.equal(found?.state, "unreported");
  assert.equal(found?.reported, 0);
  assert.equal(verdict.consistent, true);
  assert.deepEqual(verdict.mismatches, []);
});

test("a box that does not report it is not a mismatch against one that does", () => {
  const verdict = fleetConsistency([
    guest("http://10.0.0.2:8765", { edgeUpdaterGuard: guard("ok") }),
    guest("http://10.0.0.3:8765", { windowsVersion: "Microsoft Windows 11 Pro 10.0.26100" }),
  ]);
  const found = verdict.reportedOnly.find((d) => d.field === FIELD);
  assert.equal(found?.state, "unreported", "one of two guests reported it");
  assert.equal(found?.reported, 1);
  assert.equal(found?.asked, 2);
  assert.equal(verdict.consistent, true);
  assert.deepEqual(verdict.mismatches, []);
});

test("a value that is not a record is not reported, and does not throw", () => {
  for (const shape of ["ok", 3, null, ["ok"], {}, { state: null }]) {
    const verdict = fleetConsistency([
      guest("http://10.0.0.2:8765", { edgeUpdaterGuard: shape }),
      guest("http://10.0.0.3:8765", { edgeUpdaterGuard: guard("ok") }),
    ]);
    assert.equal(verdict.consistent, true, JSON.stringify(shape));
    const found = verdict.reportedOnly.find((d) => d.field === FIELD);
    assert.equal(found?.state, "unreported", `${JSON.stringify(shape)} was read as a state`);
    assert.equal(found?.reported, 1);
  }
});

test("edgeUpdaterGuard.state is in REPORTED_ONLY and not in MUST_MATCH, and says it is not a gate yet", () => {
  const entry = REPORTED_ONLY.find(({ path }) => path === FIELD);
  assert.ok(entry, `${FIELD} is not in REPORTED_ONLY`);
  assert.match(entry.why, /NOT a gate yet/, "a reported-only field needs its exit named");
  assert.ok(!MUST_MATCH.some(({ path }) => path.startsWith("edgeUpdaterGuard")),
    "gating it here would read unchecked on every box until the workers are deployed");
});
