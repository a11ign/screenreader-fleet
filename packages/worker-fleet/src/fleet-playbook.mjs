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
 *   npm run fleet:provision                    # the ROLE: NVDA, Edge pin, policies, and the stamp
 *   npm run fleet:provision -- --serial=0      # all boxes at once; 1 (default) is fail-fast on a role change
 *
 * `provision-role.yml` is here because adding a box makes it necessary, and it was reachable only by
 * typing `ansible-playbook` on the control plane — the hand-crank this file exists to remove. It runs
 * `serial: 1`, so the fleet is never all-unavailable at once.
 *
 * **Run it across the WHOLE fleet, never `--limit` to the new box.** `provisionRevision` is
 * `<git-sha>-<hash of four environment files>` and it is a CAPTURE CACHE KEY that `fleet-consistency`
 * also treats as MUST_MATCH. A box stamped at a different commit from its peers makes the fleet read
 * INCONSISTENT and capture runs refuse to start — `stamp-provision-revision.ps1` records exactly that
 * happening, four boxes reporting four revisions "purely because each first-booted at a different commit
 * during one afternoon".
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./cli-flags.mjs";

/**
 * `--serial=` and `--limit=` decide how many of twelve machines an operation touches at once, and
 * `--ref=` decides what code they end up running. `--abbrev-ref`, `--all`, `--ff-only` and `--quiet`
 * appear in this file because it passes them to GIT; they are not its own.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags(["--playbook=", "--ref=", "--limit=", "--serial="], { command: "npm run fleet:deploy" });

/** CT 120. Named here rather than parsed out of the inventory, which needs Ansible to read properly. */
const CONTROL_PLANE = process.env.A11Y_CONTROL_HOST || "REDACTED-INTERNAL-ADDRESS";
const CONTROL_KEY = process.env.A11Y_PVE_KEY || `${process.env.HOME}/.ssh/a11y-pve_ed25519`;
const CHECKOUT = "a11y-witness";

/**
 * Playbooks this may run, by NAME. Not a path, and not free text: the value is interpolated into a
 * command a remote shell interprets, on the box holding the fleet SSH key. Same containment as
 * `-e out=<name>` in `lab-job.yml`, for the same reason.
 */
const PLAYBOOKS = ["deploy.yml", "sleep.yml", "provision-role.yml"];

/**
 * Ansible host patterns this may target, by SHAPE. Same containment as the playbook list, and needed for
 * the same reason: `--limit` reaches a shell on the box holding the fleet key. Worker names and the group
 * name, nothing else — `all` is not special-cased because omitting the flag already means all.
 */
const LIMIT_PATTERN = /^(a11y-worker-[0-9]{1,3})(,a11y-worker-[0-9]{1,3})*$|^a11y_workers$/;

/**
 * How many boxes a provisioning run touches at once. `0` means all of them.
 *
 * A plain small integer, contained by SHAPE like everything else that reaches a shell on the box holding
 * the fleet key. `serial: 1` is the default and its only remaining justification is fail-fast on a role
 * you have just changed — the availability argument died when `provision-role.yml` gained a refusal for a
 * worker mid-capture, which is the thing serialising was standing in for.
 */
const SERIAL_PATTERN = /^(0|[1-9][0-9]?)$/;

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

/**
 * How long each playbook may take, because 30 minutes is not one number that fits all of them.
 *
 * `deploy.yml` is a pull and a restart per box. `provision-role.yml` INSTALLS NVDA and an Edge MSI, one
 * box at a time (`serial: 1`), so five boxes is five sequential installs — comfortably past 30 minutes, and
 * a killed SSH mid-provision leaves a box half-configured with a stamp that may or may not have been
 * written. That is the worst state to be in, because `fleet:status` would then report INCONSISTENT and
 * the cause would look like a provisioning bug rather than a timeout.
 *
 * The budget is a CEILING, not a cost: a deadline that expires early turns "still working" into "failed",
 * which is the rule `run-interactive.yml` and `run-job.yml` already state.
 */
const PLAYBOOK_TIMEOUT_MS = { "provision-role.yml": 4 * 60 * 60 * 1000 };
const DEFAULT_PLAYBOOK_TIMEOUT_MS = 30 * 60 * 1000;

function ssh(command, { capture = false, timeoutMs = DEFAULT_PLAYBOOK_TIMEOUT_MS } = {}) {
  const args = ["-i", CONTROL_KEY, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
    // The connection must survive a long silent stretch: an NVDA install prints nothing for minutes and a
    // dropped SSH would read as a failed provision. Keepalives are cheap and the alternative is a
    // diagnosis of the wrong thing.
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=20",
    `root@${CONTROL_PLANE}`, command];
  return execFileSync("ssh", args, {
    encoding: "utf8", stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"], timeout: timeoutMs,
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

const argOf = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/**
 * Every argument, validated, or a refusal that names which one and what shape it wanted.
 *
 * Extracted from `main` because it grew past the complexity gate as flags were added — and the gate was
 * right: dispatching a playbook and deciding whether the arguments are safe are two things, and each of
 * these refusals exists because the value reaches a shell on the box holding the fleet SSH key.
 *
 * @returns {{chosen: string, limitFlag: string|undefined, serialFlag: string|undefined, ref: string}}
 */
function parseArgs() {
  const refuse = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(2);
  };

  const chosen = argOf("playbook") ?? "deploy.yml";
  if (!PLAYBOOKS.includes(chosen)) refuse(`refusing --playbook=${chosen}: one of ${PLAYBOOKS.join(", ")}.`);

  const limitFlag = argOf("limit");
  if (limitFlag !== undefined && !LIMIT_PATTERN.test(limitFlag)) {
    refuse(`refusing --limit=${limitFlag}: worker names only, e.g. a11y-worker-3,a11y-worker-4.`);
  }

  const serialFlag = argOf("serial");
  if (serialFlag !== undefined && !SERIAL_PATTERN.test(serialFlag)) {
    refuse(`refusing --serial=${serialFlag}: 0 (all at once) or 1-99.`);
  }
  // Silently ignoring it would be worse than refusing: the operator asked for a batch size, watched
  // something else happen, and nothing said so.
  if (serialFlag !== undefined && chosen !== "provision-role.yml") {
    refuse(`refusing --serial with --playbook=${chosen}: only provision-role.yml batches.`);
  }

  const ref = argOf("ref") ?? localBranch();
  if (!validRef(ref)) refuse(`refusing --ref=${ref}: a commit or simple branch name only.`);

  return { chosen, limitFlag, serialFlag, ref };
}

function main() {
  const { chosen, limitFlag, serialFlag, ref } = parseArgs();

  // What that ref means HERE, resolved before anything is asked of the control plane. Comparing a commit
  // to a commit is the only comparison that settles "is it running my code?" — the first version compared
  // the remote's resolved SHA against the branch NAME, which can never match, and refused a control plane
  // that was already correct.
  const expected = execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();

  process.stdout.write(`\n  control plane: ${CONTROL_PLANE}   playbook: ${chosen}\n`
    + `  ref: ${ref} (${expected.slice(0, 12)})\n\n`);
  // `--ff-only` against origin, exactly as `deploy.yml` does to each guest: a checkout of an existing
  // local branch sits at whatever that branch already pointed at, so fetching alone moves nothing.
  ssh(`cd ${CHECKOUT} && git fetch --quiet --all && git checkout --quiet ${ref} `
    + `&& git merge --ff-only --quiet origin/${ref}`);

  // READ BACK, never infer. A control plane left on an older commit would deploy that commit and report
  // success — this project's most expensive recurring shape, and the reason `deploy.yml` verifies each
  // worker over HTTP rather than trusting the push.
  const landed = ssh(`cd ${CHECKOUT} && git rev-parse HEAD`, { capture: true }).trim();
  if (landed !== expected) {
    process.stderr.write(`the control plane is on ${landed.slice(0, 12)}, not ${expected.slice(0, 12)}. `
      + "Not deploying.\n");
    process.exit(1);
  }

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
      + `ansible-playbook -i inventory.yml ${chosen} -e a11y_git_ref=${ref}`
      // The COMMIT that ref resolves to here, so each guest can assert it landed on it rather than the
      // deploy inferring success from a shell that exited 0. The 2026-08-24 note above fixed WHICH ref
      // the guests fetch; this catches the fetch silently not taking.
      + ` -e a11y_expected_commit=${expected}`
      + (limitFlag ? ` -l ${limitFlag}` : "")
      + (serialFlag !== undefined ? ` -e worker_provision_serial=${serialFlag}` : ""),
    { timeoutMs: PLAYBOOK_TIMEOUT_MS[chosen] ?? DEFAULT_PLAYBOOK_TIMEOUT_MS });
  } catch (cause) {
    process.stderr.write(`\n  ${chosen} FAILED (ansible exit ${cause.status ?? "?"}). The PLAY RECAP above `
      + "names which hosts; nothing was rolled back, so re-running is safe.\n");
    process.exit(cause.status ?? 1);
  }
  process.stdout.write(`\n  ${chosen} completed; the PLAY RECAP above is the per-host result.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

export { validRef, PLAYBOOKS, LIMIT_PATTERN, SERIAL_PATTERN, PLAYBOOK_TIMEOUT_MS,
  DEFAULT_PLAYBOOK_TIMEOUT_MS };
