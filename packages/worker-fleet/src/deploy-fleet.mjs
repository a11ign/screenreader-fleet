/**
 * Deploy worker code to the BARE-METAL fleet, from the one machine allowed to do it.
 *
 * `worker:deploy` is `utmctl file push` and reaches UTM VMs on a Mac only. The physical boxes are
 * git-cloned and deploy by pulling, which is what `ansible/deploy.yml` does — but that playbook cannot
 * run from a laptop, and the reason is structural rather than incidental. `inventory.yml` says it:
 *
 *   "This is the half of ADR 0012's split that holds the fleet SSH key, which is why worker playbooks
 *    can only be run from here and not from a developer's Mac."
 *
 * Measured 2026-08-24: every worker answers `/health` on :8765 in ~17ms from this Mac and every one
 * TIMES OUT on port 22. So a local `ansible-playbook deploy.yml` does not fail with a key error that
 * points at the cause — it reports four hosts UNREACHABLE, which reads like a sleeping fleet. `fleet:wake`
 * then says "already up", because it asks over HTTP. Two tools, two true answers, one wrong conclusion.
 *
 * So this drives Ansible where the key lives, and the npm script is the interface either way.
 *
 *   npm run fleet:deploy
 *   npm run fleet:deploy -- --ref=<commit>     # default: the commit this checkout is on
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** CT 120. Named here rather than parsed out of the inventory, which needs Ansible to read properly. */
const CONTROL_PLANE = process.env.A11Y_CONTROL_HOST || "REDACTED-INTERNAL-ADDRESS";
const CONTROL_KEY = process.env.A11Y_PVE_KEY || `${process.env.HOME}/.ssh/a11y-pve_ed25519`;
const CHECKOUT = "a11y-witness";

/**
 * A commit or a simple branch name, and nothing else.
 *
 * This value is interpolated into a command a remote shell interprets — ssh joins its arguments into one
 * string whatever you pass — so it is the one place a shell metacharacter could reach the box holding the
 * fleet key. Containment by SHAPE, the same rule `isValidCaptureId` follows: `;rm -rf /` is inexpressible
 * rather than rejected.
 */
function validRef(ref) {
  return /^[0-9a-zA-Z._/-]{1,64}$/.test(ref) && !ref.includes("..");
}

function ssh(command, { capture = false } = {}) {
  const args = ["-i", CONTROL_KEY, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
    `root@${CONTROL_PLANE}`, command];
  return execFileSync("ssh", args, {
    encoding: "utf8", stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"], timeout: 1_800_000,
  });
}

function localHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function main() {
  const flag = process.argv.find((a) => a.startsWith("--ref="));
  const ref = flag ? flag.slice("--ref=".length) : localHead();
  if (!validRef(ref)) {
    process.stderr.write(`refusing --ref=${ref}: a commit or simple branch name only.\n`);
    process.exit(2);
  }

  process.stdout.write(`\n  control plane: ${CONTROL_PLANE}   ref: ${ref}\n\n`);
  ssh(`cd ${CHECKOUT} && git fetch --quiet --all && git checkout --quiet ${ref}`);

  // READ BACK, never infer. `git checkout` of a ref the remote does not have yet fails in ways that a
  // subsequent playbook run would happily paper over by deploying the previous commit and reporting
  // success — this project's most expensive recurring shape, and the reason `deploy.yml` verifies over
  // HTTP rather than trusting the push.
  const landed = ssh(`cd ${CHECKOUT} && git rev-parse HEAD`, { capture: true }).trim();
  const SHORT_SHA = 7;
  if (!landed.startsWith(ref) && !ref.startsWith(landed.slice(0, SHORT_SHA))) {
    process.stderr.write(`the control plane is on ${landed.slice(0, 12)}, not ${ref}. Not deploying.\n`);
    process.exit(1);
  }
  process.stdout.write(`  control plane now at ${landed.slice(0, 12)}\n\n`);

  ssh(`cd ${CHECKOUT}/packages/worker-fleet/ansible && ANSIBLE_CONFIG=ansible.cfg `
    + "ansible-playbook -i inventory.yml deploy.yml");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

export { validRef };
