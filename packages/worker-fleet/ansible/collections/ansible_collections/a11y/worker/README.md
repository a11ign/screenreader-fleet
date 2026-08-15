# `a11y.worker`

Six Ansible modules for an NVDA capture worker.

## Why these exist

Each one was checked for a first-class equivalent and has none — there is no Defender module in
`ansible.windows` or `community.windows` (the only one anywhere is a lone third-party repo),
`win_power_plan` selects a *plan* rather than individual AC timeouts, and nothing exposes NIC selective
suspend. The rest are domain-specific and always would have been.

The mistake that produced this collection was concluding *"no module exists, so this stays inline
PowerShell."* Those are different statements. Inline `win_powershell`:

- **cannot honour `--check`.** The module supports check mode by handing `$Ansible.CheckMode` to your
  script; reading it is on you. Measured on this role before the port: 12 `win_powershell` tasks, none of
  which read it, so `--check` would have really uninstalled OneDrive and really changed `powercfg`.
- **validates no arguments.** A typo is discovered on the box.
- **reports `changed` by assertion.** `powercfg /change` exits 0 whether or not anything moved, so
  `changed_when: true` was a guess dressed as a fact.
- **produces no diff.**

A module on `Ansible.Basic` gets all four by construction. That is the whole trade: it is not less of our
code, it is our code inside Ansible's guarantees.

## The modules

| module | what it reconciles | the knowledge in it |
|---|---|---|
| `a11y_speech_viewer` | `showSpeechViewerAtStartup` across every `nvda.ini` | the Speech Viewer's focus event is ANNOUNCED, so it lands in the probe's speech delta and makes an accessible page and an inaccessible one indistinguishable — and `capture-check` cannot see it, because it asserts the probe fired, not what it heard |
| `a11y_nvda` | NVDA present and INTACT | %TEMP% cleanup once left `nvda.exe` as a stub that launches and dies with no `nvda.log`; ~1700+ files is healthy, under 500 is a corpse, `library.zip` and `nvda_slave.exe` must exist |
| `a11y_power_timeouts` | AC standby/hibernate/disk timeouts | a sleeping worker presented as `EHOSTUNREACH` for 48 consecutive requests, then answered a curl 30 s later |
| `a11y_nic_power` | NIC selective suspend | the second mechanism; fixing only the timers leaves the fault intermittent. Falls back to `PnPCapabilities = 24` where the cmdlet is absent |
| `a11y_defender` | real-time monitoring | Tamper Protection SILENTLY REVERTS `Set-MpPreference`, so it is reported rather than fought — and never failed, because the box is still a usable worker |
| `a11y_onedrive` | OneDrive absent | policy stops it starting; it does not remove the Run entry or dismiss a toast already over the desktop |

Every one reads current state, compares, and changes only the difference. Several **fail rather than
report ok on nothing**: `a11y_speech_viewer` on zero `nvda.ini` files, `a11y_nic_power` on no adapter Up.
Reporting success having examined nothing is this project's most expensive recurring shape.

## What is NOT here, and cannot be

Anything needing the **interactive desktop**. Ansible's own Windows FAQ is explicit that the
scheduled-task workaround "can only be used to run commands, **not modules**", and SSH lands in session 0
the same way WinRM does. So `SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT)` can never be a module,
however well written — `run-server.cmd` re-applies it per session, which is the only mechanism that
works. Same for anything driving NVDA itself.

`community.windows.win_psexec` (`interactive:`, `session:`) is the other route to session 1 and was
considered: it needs PsExec on every box, EDR flags it, and its own docs say `wait` is "only for
non-interactive applications", which makes recovering an exit code awkward. `tasks/run-interactive.yml`
uses a scheduled task instead.

## Working on these

There is no Windows here, so the checks that exist are:

```bash
ansible-doc a11y.worker.a11y_nvda          # documentation parses AND the collection is found
python3 ../../../../check-modules.py       # every task's arguments exist in the module's own spec
```

`check-modules.py` matches **any** fully-qualified name rather than a list of namespaces — it was a
three-namespace tuple, and when this collection arrived it skipped all eight of its tasks while still
reporting "0 problems", which is the failure it exists to catch happening inside itself.

The `.ps1` is the implementation and the `.py` beside it is the documentation Ansible reads. Generate
the doc YAML with a dumper rather than by hand: `default: *` is a YAML **alias** and a description
containing `": "` is a **mapping**, and both fail as "missing documentation", which points at the wrong
thing entirely.
