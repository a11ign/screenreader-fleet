# Fleet operations

Provision, update, restart and diagnose N bare-metal capture workers from the control plane.

```bash
pipx install ansible-core                       # 2.18+ — Debian's apt version is too old for Windows SSH
ansible-galaxy collection install -r requirements.yml   # BOTH collections; see requirements.yml

cd packages/worker-fleet/ansible
ansible-playbook deploy.yml                     # git pull + npm install + restart + PROVE it took
ansible-playbook deploy.yml -l a11y-worker-3    # one box
ansible-playbook restart.yml                    # the remedy for a wedged worker
ansible-playbook provision.yml                  # drives the PowerShell (today's path)
ansible-playbook provision-role.yml             # the ported role (see "The role" below)
ansible-playbook collect-logs.yml               # every worker's logs, into runs/worker-logs/

ansible-playbook wake.yml                       # power the fleet on (magic packet + wait for /health)
ansible-playbook sleep.yml                      # power it down, REFUSING any box mid-capture

python3 check-modules.py                        # do the module ARGUMENTS exist? syntax-check cannot tell
```

The fleet is defined once, in `inventory.yml`. Everything else derives from it:

```bash
eval "$(npm run --silent fleet:env)"            # exports A11Y_WORKERS from the inventory
npm run doctor                                  # now sees the whole fleet
```

## What this replaces

`worker:deploy` is `utmctl file push` plus a `utmctl` reboot, keyed on a VM UUID. It has no host
parameter and fails immediately off macOS. So a bare-metal worker had **no code-delivery mechanism at
all** except a human opening an elevated PowerShell on the box — fine at one machine, and the reason a
fleet drifts at twelve.

Drift is not cosmetic here. `environmentKey()` puts browser and OS versions in the **capture cache key**,
so a split fleet fragments the corpus, and `fleet-consistency.mjs` records how that presents: *"the cache
merely stopped hitting, which reads as ordinary churn rather than as a split fleet."* Three clones of one
UTM image mostly agreed. Twelve independently-purchased, independently-updating mini PCs will not.

The UTM VMs keep their own lifecycle through `worker-ctl.sh` and are **not** managed from here.

## The role

`roles/worker/` is `provision-nvda-worker.ps1` ported to modules, split by concern:

| tasks file | what it owns |
|---|---|
| `packages.yml` | Node (LTS resolved ONCE on the control plane, so a fleet cannot straddle a release), MinGit, the repo |
| `account.yml` | the worker account, and credential-free auto-logon — including the `LimitBlankPasswordUse` assertion |
| `policy.yml` | Edge, Windows Update, notifications, OneDrive, screensaver |
| `firewall.yml` | the worker port, and the allow-app alert that would block the whole desktop |
| `nvda.yml` | npm, guidepup, NVDA, and the Speech Viewer |
| `tasks.yml` | `a11ysrv`, `a11ycheck`, and removing `a11ybootstrap` |
| `bespoke.yml` | sleep/NIC power, Defender and browser profiles — via the `a11y.worker` modules |
| `verify.yml` | start it and prove it serves |

**The HKLM/HKCU split is load-bearing.** Elevated tasks are `become: true` (SYSTEM); the HKCU ones
deliberately are not, because an SSH session is already `witness`. Becoming SYSTEM for those writes
*SYSTEM's* hive — the screensaver stays on for the account that actually runs captures, and nothing
reports a thing.

**`provision.yml` and `provision-role.yml` both exist on purpose.** The script is 816 lines, 39% of them
comments recording things that have already cost days, and it cannot be tested in CI. Deleting it before
the role is proven equivalent means finding the gaps one silent capture at a time. Prove parity first:

```bash
ansible-playbook provision-role.yml -l a11y-worker-1 --check --diff   # safe now; see "Check mode"
ansible-playbook provision-role.yml -l a11y-worker-1
# then compare against a script-provisioned box:
#   /health.environment  — browser, NVDA, guidepup, OS, protocol
#   provisionRevision    — the machine-checkable equivalence test
npm run capture:check -- --worker=http://<box>:8765
npm run evidence:check http://<box>:8765
```

`provisionRevision` is a **capture cache key**, and it currently hashes the script files. Retiring the
script necessarily moves it and invalidates all 2,122 cached captures — so bundle that with any pending
`CAPTURE_PROTOCOL_VERSION` bump and recapture once. A full recapture measured 3 h 46 m across three
workers.

**The steps with no first-class module became OUR modules**, in `collections/ansible_collections/a11y/worker/`
— `a11y_nvda`, `a11y_speech_viewer`, `a11y_power_timeouts`, `a11y_nic_power`, `a11y_defender`,
`a11y_onedrive`. "No module exists" is not the same as "this must be inline script": a module on
`Ansible.Basic` honours `--check`, validates its arguments, reports a real diff, and computes `changed`
from state rather than asserting it. See that collection's README.

**Three things are deliberately NOT ported, and one of them never can be.**
`apply-foreground-lock-timeout.ps1` is the permanent one: `SystemParametersInfo` needs a thread that can
change the foreground window, and Ansible's own FAQ says the scheduled-task route "can only be used to
run commands, **not modules**" — SSH lands in session 0 exactly as WinRM does, so no module however well
written can do it. `run-server.cmd` re-applies it per session, which works. The other two are judgement:
`diagnose-nvda-worker.ps1`, because its product is ordered verdicts with fixes and `assert` fails fast,
which is the opposite behaviour; and `build-lean-worker-image.ps1`, because offline DISM servicing has no
module and it builds an ISO rather than configuring a host.

## Check mode

`--check` is safe on this role. It was not, and the fix is worth recording because the trap is easy to
walk back into: `win_powershell` *supports* check mode by handing `$Ansible.CheckMode` to your script —
**acting on it is the script's job**. Twelve tasks did not, so a dry run really uninstalled OneDrive and
really changed `powercfg`.

| tasks | under `--check` |
|---|---|
| the six `a11y.worker` modules | correct — written for it |
| `win_regedit`, `win_user`, `win_group_membership`, `win_scheduled_task`, `win_firewall_rule`, `win_acl`, `win_lineinfile`, `win_file`, `win_path`, `win_get_url`, `win_unzip` | correct |
| 4 read-only `win_powershell` | run, and only read — architecture, node path, guidepup version, task read-back |
| 2 mutating `win_powershell` | **guarded** — `NotifyOnListen` and the node move check `$Ansible.CheckMode` |
| `win_shell` | **skipped** (`supports_check_mode = $false`) |

The `win_shell` skips are honest rather than a gap: `npm install`, `git clone` and `guidepup setup` are
commands, not reconcilable state, so there is nothing for a dry run to predict.

```bash
ansible-playbook provision-role.yml -l a11y-worker-1 --check --diff
```

## Powering the fleet, because it is not meant to run 24/7

Twelve mini PCs idling is real power for no evidence, so **off is the resting state** — the same
position `doctor` already takes for stopped UTM guests.

```bash
ansible-playbook wake.yml -l a11y-worker-3     # magic packet, then wait until it serves /health
ansible-playbook sleep.yml                     # graceful shutdown, skipping anything that is capturing
```

`sleep.yml` **refuses a busy worker and says so.** A capture is 12–520 s of screen-reader work with no
way to resume it, and from the host a killed box looks like a flaky worker rather than like us —
`local-vm.ts` learned the same rule for the VM pool. `-e a11y_force_sleep=true` overrides it.

`wake.yml` runs entirely on the control plane (`connection: local`): a sleeping box has no sshd and no
Python, so every task addresses it by MAC and by HTTP. It uses **`community.general.wakeonlan`**, not
`community.windows.win_wakeonlan` — the latter sends the packet *from* a Windows host, and this control
plane is Linux. One word apart, and only one of them can work here.

Three prerequisites, and only two are automated:

1. **WoL enabled in each box's firmware.** A console visit, once per machine. Nothing can automate it —
   the box is off and has no OS to ask.
2. The adapter must stay armed to wake. `a11y_nic_power` handles it, and this is where the danger was:
   its registry fallback originally wrote `PnPCapabilities = 24`, which Microsoft documents as *also*
   preventing the adapter from waking the computer. On any box without the cmdlet that would have made
   Wake-on-LAN impossible while reporting success. It writes `8` now, and sets `WakeOnMagicPacket`
   explicitly via the cmdlet where it exists.
3. **Fast Startup must be off**, or many boards never truly reach S5 and never wake.
   `a11y_power_timeouts` turns hibernation off, which disables Fast Startup as a side effect. That is a
   real dependency between two modules, not a coincidence — do not "tidy" the hibernation setting.

## Driving the LAB, not just the workers

The inventory has a second group. `a11y_lab` is CT 121 on the Proxmox host — the container holding the
capture corpus, the venv, the trained scorer and the `a11y-corpus` deploy key. It is here because it
EXISTS, not because it captures: `wake.yml`, `sleep.yml`, `deploy.yml` and `provision*.yml` all target
`a11y_workers` and are unaffected.

```bash
npm run lab:job -- -e job=train                 # named jobs only; see lab-job.yml for the catalogue
npm run lab:job -- -e job=capture-real-pages -e worker=a11y-worker-2 -e role=training -e shard=0/4
npm run lab:status                              # every a11y-job-* unit and its state
npm run lab:status -- -e job=train              # one job, systemd's view + its journal + its own progress file
```

**What this replaces, and why it was worth replacing.** Long lab work was started by typing
`ssh root@REDACTED-INTERNAL-ADDRESS 'pct exec 121 -- bash -lc "..."'`, which appears NOWHERE in the source tree — so the
way this project's most expensive operations were launched was untested, unversioned and unreviewable. Two
days of it cost: a heredoc mangled through two hops of shell quoting; a bash array that evaporated crossing
`nohup bash -c`, sending four capture shards at `--worker=http://:8765` for 29 minutes while every worker
sat idle; four `pgrep -f X` waiters that matched their own command lines and waited forever; and a job
reported "still running" 28 minutes after it had finished.

`ansible.builtin.command` with `argv:` never invokes a shell, so the quoting class is gone by construction.
`systemd-run` supplies the rest — a durable handle, a real exit code, `journalctl` with rotation, a
`RuntimeMaxSec` ceiling, and mutual exclusion by unit name that holds against the ssh path too, which an
in-process flag could not.

**Why not an HTTP job API on the lab.** It was designed and rejected, for the reason the section below
rejects `/admin/update` on a worker — and with more force, because a route that starts training runs
executes code by design. The conclusion there generalises: *"Ansible subsumes the HTTP route; the reverse is
not true."* Ansible is agentless, so nothing listens on the box that holds the corpus. ADR 0012's "there is
no service between them, deliberately" is satisfied rather than argued around.

**Named jobs, not commands.** `lab-job.yml` holds the catalogue and there is deliberately no `command`
parameter. Callers pass CHOICES: a job name, and for a capture, a worker NAME resolved through the
inventory — which makes a malformed address inexpressible rather than merely rejected, the same shape as
`isValidCaptureId` on the worker. The environment is fixed by `run-job.yml`; nothing from the caller reaches
it, because `A11Y_PYTHON` is read at four sites in this repo and becomes the executed interpreter.

**`tasks/run-job.yml` is `tasks/run-interactive.yml` for Linux**, and deliberately the same shape: fire it,
poll for it to stop, read the result BACK, print what it said, release the handle whether it passed or
failed, assert on the code. Three details were measured on the container and each would otherwise be a bug,
so `lab-job.test.ts` pins them:

- **Poll `SubState`, never `systemctl is-active`.** Under `--remain-after-exit` an exited unit stays
  `active (exited)` for good, so `is-active` returns true forever — a waiter written that way hangs
  indefinitely reporting "still running" for a finished job. That is the original incident reproduced
  inside its own fix, and it happened here before the test existed.
- **`Result` and `ExecMainStatus` are populated WHILE the job runs.** Observed `Result=success
  ExecMainStatus=0` on a job seven minutes from finishing, so they mean nothing until `SubState` leaves
  `running`.
- **`--remain-after-exit`, not `--collect`.** A collected unit is unloaded on exit and takes its exit code
  with it. Verified both ways: `exit 42` leaves `Result=exit-code ExecMainStatus=42`, rather than vanishing.

**The lab must never become a capture worker.** `fleet-env.mjs` read every `ansible_host:` in this file as a
worker at :8765 until 2026-08-21, so adding the lab would have put `http://REDACTED-INTERNAL-ADDRESS:8765` into
`A11Y_WORKERS` and a run would have dispatched cases to a box with no NVDA. The reader is group-aware now,
`inventoryHosts` shares that one implementation rather than carrying a second, and `enrol` splices new
workers into the `a11y_workers` block rather than appending at the end of the file — which would otherwise
land a freshly discovered worker inside `a11y_lab`, where it would be correctly ignored. Provisioned,
updated, never dispatched to. `fleet-discover.test.ts` reads an enrolment back through the reader a run
actually uses, because being in the file is not the same as being a worker.

## Why SSH and not WinRM

WinRM against the `witness` account needs `LimitBlankPasswordUse=0`, and that setting is exactly what
makes the credential-free design safe: it confines a blank-password account to console logon, so the
account that auto-logs-in to the capture desktop cannot be reached over SMB, RDP or password SSH. Turning
it off to gain a management channel trades away the guard it was protecting.

Public-key SSH is unaffected by that policy, and elevation uses `become_method: runas` with
`become_user: SYSTEM`, which needs no password because SYSTEM is a service account. **No password is
stored anywhere in this project**, which was a constraint before it was a feature.

## Why not an `/admin/update` route on the worker instead

It is the option ADR 0001 most naturally suggests, and it was rejected on evidence:

- The worker has **no authentication of any kind** — no tokens, no CORS, `req.url` compared with `===`
  against a handful of literals — it binds all interfaces, and provisioning opens 8765 inbound on
  `-Profile Any`. A mutating route there is unauthenticated remote code execution on twelve boxes.
- An updater must kill the process it lives in, on a box whose scheduled task has **demonstrably** failed
  to resurrect it: `server.mjs` records a worker that exited and was still dead three minutes later with
  `RestartCount 5` configured. That is a remote brick button.
- It could not provision a bare machine, collect logs, or manage power state anyway, so the SSH path would
  still be needed. Ansible subsumes the HTTP route; the reverse is not true.

## The bootstrapping problem, stated rather than discovered later

Ansible needs sshd **and** the operator key on a box before it can do anything — and both are installed
*by* provisioning. Two ways in:

- **Set `A11Y_OPERATOR_KEY` before running `bootstrap-windows-worker.ps1`** and the key is installed at
  bootstrap. Every later operation is unattended.
- **`autounattend.xml` at Windows install time**, which now EXISTS for x64 —
  `../src/provisioning/bare-metal/`. PXE-boot a box and it installs Windows, creates the account, brings
  sshd up and plants your key, with no console visit at all. That is the right answer for a fleet being
  installed from scratch, and it is what the PXE/iVentoy work was heading towards.

Without either, the first touch on each machine is manual (`irm … | iex` at the console) and only runs
2..n are unattended — 6–12 console visits.

## Verification never shares a failure mode with the action

Ansible acts over **SSH**; every playbook verifies over **HTTP**. This is not symmetry for its own sake.
The old advice in this repo was "hash-check both sides", but reading the guest's hash went through
`utmctl exec` too — so when `exec` was broken the check returned *empty* rather than *mismatched*, and
empty reads as a flaky tool rather than a failed deploy. `/health.code` is served on the channel the
worker is actually used on, so it is reachable exactly when it is useful.

`deploy.yml` goes further: a restart that does not move `/health.code` is **escalated to a reboot**, and
only then failed. `Stop-ScheduledTask` + `Start-ScheduledTask` once silently did nothing on two guests,
which served the previous code for another hour. A reboot always picks up pushed files.

## Gotchas that will otherwise cost you an afternoon

- **`administrators_authorized_keys`, not `~/.ssh/authorized_keys`.** `witness` is an Administrator, and
  Windows OpenSSH ignores the per-user file for admin accounts. sshd then reads no key, offers password
  auth, and the blank-password account cannot use it — so it presents as a permission denial that looks
  like a wrong key. The ACL matters too: sshd silently refuses a key file any non-admin can write.
- **`DefaultShell` must be PowerShell.** Windows OpenSSH ships with `cmd.exe`, and `ansible_shell_type:
  powershell` against a cmd shell fails every task with a parse error that points at the YAML. Bootstrap
  sets it now; for a box provisioned before that:

  ```powershell
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
    -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
  ```

- **SSH lands in session 0, which cannot drive NVDA.** guidepup reports that as `nvda.start failed: NVDA
  is not supported`, which reads like a broken install and is not one. Anything touching the screen reader
  goes through the `a11ysrv` scheduled task, whose principal is `Interactive`.
- **`win_shell` is a free-form module**, so Ansible parses your PowerShell as module arguments before it
  reaches the box. A here-string (`@' … '@`) reads as unbalanced quotes and fails with "failed at
  splitting arguments". Use `ansible.windows.win_powershell` with a `script:` parameter — `ssh-key.yml`
  does, and says why.
- **A box that is off stays in the inventory.** `any_errors_fatal = false` means the rest of the fleet
  still gets the play and the recap names the one that did not answer. Deleting a machine to make a run go
  green is how it stops being maintained.
