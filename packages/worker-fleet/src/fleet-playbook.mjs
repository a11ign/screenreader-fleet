/**
 * Run a fleet playbook from the one machine allowed to run it.
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
 * `fleet:wake` is NOT here and should not be: it sends Wake-on-LAN magic packets, which are UDP
 * broadcasts on the LAN and need no SSH at all. Everything that has to talk TO a worker does.
 *
 *   npm run fleet:deploy                       # ship this checkout's worker code
 *   npm run fleet:deploy -- --ref=<commit>     # default: the commit this checkout is on
 *   npm run fleet:sleep                        # power the fleet down, REFUSING any box mid-capture
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** CT 120. Named here rather than parsed out of the inventory, which needs Ansible to read properly. */
const CONTROL_PLANE = process.env.A11Y_CONTROL_HOST || "REDACTED-INTERNAL-ADDRESS";
const CONTROL_KEY = process.env.A11Y_PVE_KEY || `${process.env.HOME}/.ssh/a11y-pve_ed25519`;
const CHECKOUT = "a11y-witness";

/**
 * Playbooks this may run, by NAME. Not a path, and not free text: the value is interpolated into a
 * command a remote shell interprets, on the box holding the fleet SSH key. Same containment as
 * `-e out=<name>` in `lab-job.yml`, for the same reason.
 */
const PLAYBOOKS = ["deploy.yml", "sleep.yml"];

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

/**
 * The current BRANCH, not the commit, and that distinction is load-bearing.
 *
 * `deploy.yml` fast-forwards each guest with `git merge --ff-only origin/{{ a11y_git_ref }}`, so the ref
 * has to be something `origin/<ref>` resolves to. A commit does not: this repo has already spent a run on
 * `-e ref=<sha>` becoming an unresolvable `origin/<sha>`, and two of the uses had `failed_when: false`, so
 * the empty read was taken for a zero.
 */
function localBranch() {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
}

function main() {
  const chosen = process.argv.find((a) => a.startsWith("--playbook="))?.slice("--playbook=".length)
    ?? "deploy.yml";
  if (!PLAYBOOKS.includes(chosen)) {
    process.stderr.write(`refusing --playbook=${chosen}: one of ${PLAYBOOKS.join(", ")}.\n`);
    process.exit(2);
  }
  const flag = process.argv.find((a) => a.startsWith("--ref="));
  const ref = flag ? flag.slice("--ref=".length) : localBranch();
  if (!validRef(ref)) {
    process.stderr.write(`refusing --ref=${ref}: a commit or simple branch name only.\n`);
    process.exit(2);
  }

  process.stdout.write(`\n  control plane: ${CONTROL_PLANE}   playbook: ${chosen}   ref: ${ref}\n\n`);
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

  // A failed deploy must READ like a failed deploy. `execFileSync` throws an Error whose message is the
  // whole command line and whose stack is node's internals, which buries "which box failed" under twelve
  // lines of module loader — and the wrapper around it then reported success. Ansible has already printed
  // its own PLAY RECAP by this point; the job here is to exit with its status and say so in one line.
  try {
    // `-e a11y_git_ref` is what the GUESTS fetch. Without it they default to `main` and stay exactly where
    // they were, while the control plane sits on the branch you asked for — so `expected_code` is computed
    // from your code and `served_code` from theirs, and the deploy fails with a mismatch that reads like a
    // corrupted guest checkout. Measured 2026-08-24: all four workers held 1f7cb7e88070235d against an
    // expected c6e66caa481b76c0, having faithfully fetched a branch nobody had changed.
    ssh(`cd ${CHECKOUT}/packages/worker-fleet/ansible && ANSIBLE_CONFIG=ansible.cfg `
      + `ansible-playbook -i inventory.yml ${chosen} -e a11y_git_ref=${ref}`);
  } catch (cause) {
    process.stderr.write(`\n  ${chosen} FAILED (ansible exit ${cause.status ?? "?"}). The PLAY RECAP above `
      + "names which hosts; nothing was rolled back, so re-running is safe.\n");
    process.exit(cause.status ?? 1);
  }
  process.stdout.write(`\n  ${chosen} completed; the PLAY RECAP above is the per-host result.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

export { validRef, PLAYBOOKS };
