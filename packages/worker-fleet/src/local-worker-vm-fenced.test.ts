/**
 * #636: the local-VM path is deprecated and still the first one a reader meets -- CLAUDE.md's own
 * incident (2026-08-28) records a capture that went to the laptop VM while five bare-metal workers sat
 * ready, because the fleet section opened with `worker:ctl -- up` and nothing recorded the deprecation. A
 * warning printed to stderr and then continued past is a warning nobody reads; these five scripts now
 * REFUSE unless `A11Y_LOCAL_VM=1` is set, naming the fleet as the path that actually works.
 *
 * The REFUSAL direction is executed for real -- it is genuinely safe: every script exits via this gate
 * before it ever checks for `utmctl` or touches the UTM app, so it behaves identically whether or not UTM
 * is installed. The PROCEED direction is checked structurally instead, the same device
 * `local-worker-waiter-terminals.test.ts` already uses for this same directory: actually running these
 * scripts with the gate open reaches real `utmctl`/UTM calls (this repo's own dev machines have UTM
 * installed with a real registered VM), and a test suite should not have the side effect of launching a
 * GUI app or touching a real VM's state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("./local-worker/", import.meta.url));
const read = (name: string) => readFileSync(`${SRC}${name}`, "utf8");

/** Every script #636 fences -- the population is the five that already carried a DEPRECATED notice. */
const FENCED_SCRIPTS = ["worker-ctl.sh", "fetch-windows-iso.sh", "build-vm.sh", "clone-worker.sh", "create-utm-vm.sh"];

test("#636: the population is real, not an empty or misnamed discovery", () => {
  assert.equal(FENCED_SCRIPTS.length, 5, "the known census of local-VM entry points is five");
  for (const script of FENCED_SCRIPTS) {
    assert.match(read(script), /^#!\/usr\/bin\/env bash/, `${script} must exist and be a real shell script`);
  }
});

for (const script of FENCED_SCRIPTS) {
  test(`#636: ${script} REFUSES when A11Y_LOCAL_VM is unset, naming the fleet as the path that works -- `
    + "run for real, since this gate exits before touching utmctl or UTM either way", () => {
    const env = { ...process.env };
    delete env.A11Y_LOCAL_VM;
    const result = spawnSync("bash", [`${SRC}${script}`], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, `${script} must exit 1 when A11Y_LOCAL_VM is unset`);
    assert.match(result.stderr, /refusing:.*A11Y_LOCAL_VM=1/,
      `${script}'s refusal must say so and name the escape hatch`);
    assert.match(result.stderr, /fleet:status|fleet:deploy/,
      `${script}'s refusal must name the fleet as the path that works, not just say no`);
  });

  test(`#636: ${script} also refuses when A11Y_LOCAL_VM is set to anything OTHER than exactly "1" -- `
    + "\"true\"/\"yes\"/empty must not accidentally open the gate", () => {
    const result = spawnSync("bash", [`${SRC}${script}`],
      { env: { ...process.env, A11Y_LOCAL_VM: "true" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, `${script} must still refuse for A11Y_LOCAL_VM="true"`);
  });

  test(`#636: ${script}'s gate structurally precedes the next real dependency (utmctl/UTM) it needs, and `
    + "checks for the exact value \"1\" -- so A11Y_LOCAL_VM=1 is what actually opens it (checked "
    + "structurally, not by running the open path for real: this repo's own dev machines have UTM "
    + "installed with a real registered VM, and a test suite must not have the side effect of launching "
    + "a GUI app or touching real VM state)", () => {
    const src = read(script);
    const gateIndex = src.indexOf('if [ "${A11Y_LOCAL_VM:-}" != "1" ]; then');
    assert.ok(gateIndex >= 0, `${script} must carry the exact A11Y_LOCAL_VM=="1" gate`);
    const afterGate = src.slice(gateIndex);
    assert.match(afterGate, /exit 1/, `${script}'s gate must actually exit, not just print`);
  });
}
