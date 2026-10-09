/**
 * A cumulative-update split is visible: `windowsBuild` (`<build>.<ubr>`) is compared in `REPORTED_ONLY`, where
 * `windowsVersion` cannot see it (#4433).
 *
 * `windowsVersion` is `10.0.<build>` and does not move when a monthly update lands, so two guests one update apart
 * read as the SAME value and `fleet:status` called the fleet consistent. `windowsBuild` carries the revision. It is
 * REPORTED, not gated: it must not be in `MUST_MATCH` until the worker ships it and the fleet converges, because it
 * would read `unchecked` on every box and refuse every capture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MUST_MATCH, REPORTED_ONLY, describeReportedOnly, fleetConsistency, type Guest } from "./fleet-consistency.ts";

const WINDOWS_VERSION = "Microsoft Windows 11 Pro 10.0.26100";
const guest = (worker: string, environment: Record<string, unknown>): Guest => ({ worker, environment });
const field = (fleet: Guest[]) => fleetConsistency(fleet).reportedOnly.find((drift) => drift.field === "windowsBuild");

test("two guests with the same windowsVersion and different UBRs drift on windowsBuild, and the fleet is still consistent", () => {
  const verdict = fleetConsistency([
    guest("http://10.0.0.2:8765", { windowsVersion: WINDOWS_VERSION, windowsBuild: "26100.4652" }),
    guest("http://10.0.0.3:8765", { windowsVersion: WINDOWS_VERSION, windowsBuild: "26100.4946" }),
  ]);
  const drift = verdict.reportedOnly.find((d) => d.field === "windowsBuild");
  assert.equal(drift?.state, "drifted");
  assert.deepEqual(drift?.values, { "http://10.0.0.2:8765": "26100.4652", "http://10.0.0.3:8765": "26100.4946" });
  assert.equal(verdict.consistent, true, "windowsBuild is reported, not a gate");
  assert.deepEqual(verdict.mismatches, []);
  assert.ok(!verdict.fields.coverage.some((row) => row.field === "windowsBuild"), "a gate's coverage row would refuse captures");
  assert.match(describeReportedOnly(verdict.reportedOnly).join("\n"), /windowsBuild: \.2=26100\.4652 \.3=26100\.4946/);
});

test("control: the same windowsVersion alone cannot see that split, which is why the field exists", () => {
  const verdict = fleetConsistency([
    guest("http://10.0.0.2:8765", { windowsVersion: WINDOWS_VERSION }),
    guest("http://10.0.0.3:8765", { windowsVersion: WINDOWS_VERSION }),
  ]);
  assert.ok(MUST_MATCH.some(({ path }) => path === "windowsVersion"), "windowsVersion is still the gating field");
  assert.deepEqual(verdict.mismatches, [], "an identical windowsVersion is no mismatch");
});

test("negative control: guests on the same UBR do not drift", () => {
  const same = guest("http://10.0.0.2:8765", { windowsBuild: "26100.4652" });
  const drift = field([same, guest("http://10.0.0.3:8765", { windowsBuild: "26100.4652" })]);
  assert.equal(drift, undefined, "agreeing guests were reported as drifting");
});

test("an unreadable build (\"unknown\") is not a mismatch against a real value, and gates nothing", () => {
  const verdict = fleetConsistency([
    guest("http://10.0.0.2:8765", { windowsVersion: WINDOWS_VERSION, windowsBuild: "26100.4652" }),
    guest("http://10.0.0.3:8765", { windowsVersion: WINDOWS_VERSION, windowsBuild: "unknown" }),
  ]);
  assert.equal(verdict.consistent, true);
  assert.deepEqual(verdict.mismatches, []);
  // Named as drift so it is visible, but only in the channel that gates nothing.
  assert.equal(verdict.reportedOnly.find((d) => d.field === "windowsBuild")?.state, "drifted");
});

test("a fleet whose workers do not send windowsBuild yet reads unreported and is still consistent", () => {
  const verdict = fleetConsistency([
    guest("http://10.0.0.2:8765", { windowsVersion: WINDOWS_VERSION }),
    guest("http://10.0.0.3:8765", { windowsVersion: WINDOWS_VERSION }),
  ]);
  const drift = verdict.reportedOnly.find((d) => d.field === "windowsBuild");
  assert.equal(drift?.state, "unreported");
  assert.equal(drift?.reported, 0);
  assert.equal(verdict.consistent, true);
});

test("windowsBuild is in REPORTED_ONLY and not in MUST_MATCH, and names its exit", () => {
  const entry = REPORTED_ONLY.find(({ path }) => path === "windowsBuild");
  assert.ok(entry, "windowsBuild is not in REPORTED_ONLY");
  assert.match(entry.why, /graduates to MUST_MATCH/, "a reported-only field needs its exit named");
  assert.ok(!MUST_MATCH.some(({ path }) => path === "windowsBuild"), "gating it here would read unchecked on every box");
});
