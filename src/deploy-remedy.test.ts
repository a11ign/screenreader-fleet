/**
 * `worker:code` must name a deploy route that can actually reach the worker it is talking about.
 *
 * Only bare-metal workers have a route: they are git-cloned and deploy by PULLING, via `npm run fleet:deploy`.
 * The UTM route (`a11ign-worker-deploy`, `utmctl file push` plus a `utmctl` reboot, keyed on a VM UUID) was
 * removed in #3765, so a worker outside `inventory.yml` is told there is none rather than sent to a command
 * that no longer exists.
 *
 * The remedy names the NPM SCRIPT, not `ansible-playbook deploy.yml`, and that is a second wrong-machine
 * bug rather than a style preference: the fleet's SSH is filtered from a laptop, so the raw playbook fails
 * there — and it takes no `a11y_git_ref`, so even where it connects it deploys `main` rather than the ref
 * you asked for. `fleet:deploy` goes through the control plane and passes the ref.
 *
 * This printed the utmctl advice unconditionally. Following it against a fleet of four mini PCs produced
 * `UNREACHABLE!` on all four and sent a real diagnosis down the wrong path — the tool was describing a
 * different kind of machine with complete confidence. CLAUDE.md already said `worker:deploy` "cannot reach
 * a bare-metal worker"; the knowledge was written down and the tool did not have it.
 *
 * Asserted on the returned lines rather than by running a deploy, because a remedy only prints when
 * something is already stale — and this repo has shipped an inert remedy before and confirmed it by results
 * it had no part in producing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { remedyLines } from "./worker-code-check.mjs";

const BARE_METAL = ["http://203.0.113.107:8765", "http://203.0.113.59:8765"];
const LOCAL_VM = "http://REDACTED-INTERNAL-ADDRESS:8765";

const joined = (stale: string[], fleet = BARE_METAL) => remedyLines(stale, fleet).join("\n");

test("a bare-metal worker is told to PULL, and never sent to the removed UTM push", () => {
  const out = joined([BARE_METAL[0]]);
  assert.match(out, /npm run fleet:deploy/);
  assert.match(out, /never reached these/);
  assert.doesNotMatch(out, /^\s*npm run worker:deploy$/m,
    "a bare-metal-only fleet must not be told to run the utmctl deploy as its remedy");
});

test("a local VM is told no command deploys to it, and is not sent to the removed utmctl route", () => {
  const out = joined([LOCAL_VM]);
  assert.match(out, /No command deploys to them any more/);
  assert.doesNotMatch(out, /^\s*npm run worker:deploy$/m,
    "worker:deploy does not exist: a remedy naming it sends the reader to a command that fails");
  assert.doesNotMatch(out, /ansible-playbook/,
    "a VM absent from inventory.yml cannot be deployed to by pulling — it has no checkout to pull into");
});

test("a mixed fleet is told which half has a route, and says which applies to how many", () => {
  // The case that makes a single unconditional message wrong rather than merely imprecise: half the fleet
  // would follow advice that cannot work, and the failure looks like an unreachable machine.
  const out = joined([BARE_METAL[0], LOCAL_VM, BARE_METAL[1]]);
  assert.match(out, /3 stale worker\(s\)/);
  assert.match(out, /2 in inventory\.yml/);
  assert.match(out, /1 not in inventory\.yml/);
  assert.match(out, /npm run fleet:deploy/);
  assert.match(out, /No command deploys to them any more/);
});

test("with no bare-metal fleet declared, every worker is treated as a VM", () => {
  // A checkout with no inventory.yml is supported — `inventoryWorkerUrls` returns [] rather than throwing,
  // because a hint must not fail the command it is only advising.
  const out = joined([LOCAL_VM, BARE_METAL[0]], []);
  assert.match(out, /2 not in inventory\.yml/);
  assert.doesNotMatch(out, /ansible-playbook/);
});
