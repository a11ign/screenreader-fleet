/**
 * #635: three loops under `local-worker/` waited for a positive condition correctly but had no terminal
 * check when the loop merely ran out of tries -- so the caller proceeded as if the wait had succeeded.
 * These scripts need a real UTM install to execute, so this pins the SHAPE of the fix (raw text, the
 * convention `busy-worker-guard.test.ts` already uses for Ansible playbooks the same suite cannot run)
 * rather than exercising the scripts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("./local-worker/", import.meta.url));
const read = (name: string) => readFileSync(`${SRC}${name}`, "utf8");

test("create-utm-vm.sh refuses rather than editing config.plist if UTM did not actually quit", () => {
  const src = read("create-utm-vm.sh");
  const quitLoop = src.split("for _ in $(seq 1 20); do pgrep -x UTM >/dev/null || break; sleep 1; done")[1];
  assert.ok(quitLoop, "the quit-wait loop's own text has changed -- update this test's anchor");
  assert.match(quitLoop.slice(0, 500), /pgrep -x UTM >\/dev\/null && die/,
    "no refusal follows the quit-wait loop -- a UTM that never quits would fall through into the "
    + "config.plist edit, which UTM's in-memory cache would silently overwrite");
});

test("create-utm-vm.sh refuses rather than starting the VM if UTM did not relaunch", () => {
  const src = read("create-utm-vm.sh");
  const startBlock = src.split("info \"Starting the VM")[1];
  assert.ok(startBlock, "the 'Starting the VM' section's own text has changed -- update this test's anchor");
  assert.match(startBlock.slice(0, 600), /pgrep -x UTM >\/dev\/null \|\| die/,
    "no refusal follows the relaunch-wait loop before `utmctl start` -- an absent UTM would report a "
    + "misleading state instead of a clear failure");
});

test("clone-worker.sh refuses rather than silently starting nothing if UTM never becomes responsive", () => {
  const src = read("clone-worker.sh");
  const relaunchBlock = src.split('for _ in $(seq 1 15); do sleep 2; utmctl list >/dev/null 2>&1 && break; done')[1];
  assert.ok(relaunchBlock, "the relaunch-wait loop's own text has changed -- update this test's anchor");
  assert.match(relaunchBlock.slice(0, 300), /utmctl list >\/dev\/null 2>&1 \|\| die/,
    "no refusal follows the relaunch-wait loop -- a UTM that never comes up would let the pool-start "
    + "loop below iterate zero names and finish having started nothing, with no error anywhere");
});

test("MUTATION TARGET: worker-ctl.sh's idle watch requires a RUN of misses, not one", () => {
  const src = read("worker-ctl.sh");
  assert.match(src, /max_misses=5/,
    "the idle-pause/idle-stop watch no longer requires several consecutive misses before giving up -- "
    + "a single transient health-check blip during an hours-long watch would silently abandon it "
    + "(this fleet has measured EHOSTUNREACH for 48 straight requests before a worker recovered)");
  assert.match(src, /misses=\$\(\(misses \+ 1\)\)/, "the miss counter must actually increment");
  assert.match(src, /misses=0/, "a successful health read must reset the counter, or one blip in five "
    + "checks would eventually trip the same false give-up over a longer watch");
});
