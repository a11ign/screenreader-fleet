/**
 * ADR 0012 said the fleet key must not sit beside npm's transitive dependencies. It did anyway, for as
 * long as nobody looked — 56 MB and 121 packages next to the key that reconfigures twelve Windows boxes.
 *
 * An ADR whose guarantee is void in practice is worse than no ADR, because it is read as one. This is the
 * guarantee, checkable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { controlPlaneIsolation } from "./control-plane-isolation.mjs";

test("THE MEASURED VIOLATION is reported, and the message says what it costs", () => {
  const v = controlPlaneIsolation({ hasNodeModules: true, hasFleetKey: true, packages: 121 });
  assert.equal(v.violated, true);
  assert.match(v.why, /121 packages/);
  assert.match(v.why, /reconfigures every Windows worker/,
    "a guard that reports a rule without its consequence gets read as pedantry and switched off");
  assert.match(v.why, /rm -rf/, "it must name the remedy — this repo's rule for every check it added");
});

test("A WORKSPACE IS TOLD TO MOVE THE KEY, not to delete its dependencies", () => {
  // Measured on the laptop that drives this project: both keys AND 103 MB of node_modules — a worse
  // adjacency than the control plane's. But "delete your node_modules" is advice a developer cannot take,
  // and a guard whose remedy is impossible is one that gets muted. The thing that must leave is the key.
  const v = controlPlaneIsolation({ hasNodeModules: true, hasFleetKey: true, isWorkspace: true });
  assert.equal(v.violated, true);
  assert.match(v.why, /the KEY does not/);
  assert.doesNotMatch(v.why, /rm -rf/,
    "never tell a developer to delete the dependencies their machine exists to run");
});

test("the ADJACENCY is the defect, so neither half alone fires", () => {
  // A guard that cries wolf is one people switch off. node_modules with no fleet key is a LAB, which is
  // where they belong; a fleet key with nothing beside it is the intended configuration.
  assert.equal(controlPlaneIsolation({ hasNodeModules: true, hasFleetKey: false }).violated, false);
  assert.equal(controlPlaneIsolation({ hasNodeModules: false, hasFleetKey: true }).violated, false);
});

test("a correct control plane says WHY it is correct, not merely nothing", () => {
  // "No output" and "checked and clean" are the same silence otherwise — the defect this session found
  // five times in its own instrumentation.
  const ok = controlPlaneIsolation({ hasNodeModules: false, hasFleetKey: true });
  assert.equal(ok.violated, false);
  assert.match(ok.why, /ADR 0012 holds/);
});

test("a box with neither is not silently called compliant", () => {
  const none = controlPlaneIsolation({ hasNodeModules: false, hasFleetKey: false });
  assert.equal(none.violated, false);
  assert.match(none.why, /nothing to isolate/,
    "a machine with no fleet key passes for a different reason, and conflating the two would let a "
    + "control plane that had LOST its key read as hardened");
});
