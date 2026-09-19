# Provisioning a capture machine — who each path is for

This directory has provisioning for the **fleet** (machines this project already owns, with
infrastructure this project already runs) and provisioning for a **bare Windows machine someone else
owns**. They look similar — both end with a box answering `/health` — and are easy to mistake for the
same problem. They are not: only one of the paths below is something an outside contributor can follow
start to finish.

| here | who it is for | what it assumes |
|---|---|---|
| `bare-metal/` (PXE, zero-touch) | this project's own fleet operator | Proxmox CT 110 `iventoy-pxe`, the fleet-control container serving the bootstrap payload, and `inventory.yml`/`ansible.cfg` wiring — infrastructure that lives outside this checkout and that only this project runs |
| `provision-nvda-worker.ps1` | this project's own fleet operator, repairing or re-provisioning a machine that is *already reachable* (an enrolled fleet worker, or a box `bootstrap-windows-worker.ps1` below has already prepared) | an existing checkout on the target **and** SSH access already set up — its usual invocation is `scp` + `ssh` from a machine that already has both |
| `bootstrap-windows-worker.ps1` | **an outside contributor with a spare Windows machine** | nothing but that machine. Self-contained: one elevated PowerShell line (`irm ... \| iex`), no prior checkout, no existing SSH access. It installs prerequisites, makes the box reachable, then hands off to `provision-nvda-worker.ps1` above for the NVDA/OS steps. Documented as **Route B** ("you already have a Windows machine") in [`docs/getting-started.md`](../../../../docs/getting-started.md). Its own header says it has not yet been run end-to-end on a fresh install — expect to babysit the first run. |
| the GitHub Action (`.github/workflows/capture-regression.yml`) | **an outside contributor with no machine to spare at all** | nothing — real NVDA runs on a GitHub-hosted Windows runner. Documented as **Route C** in `docs/getting-started.md`. |

The Ansible role (`packages/control/ansible/provision-role.yml`) is a second, in-progress way to do what
`provision-nvda-worker.ps1` does — same audience, same assumptions, coexisting with the script pending a
parity check its own header spells out. That is a fleet-internal question about which of two tools this
project uses on its own boxes; it does not change any row in the table above.

## Can an outside stranger provision a capture machine?

Not through `bare-metal/` or through running `provision-nvda-worker.ps1` on its own — both assume
infrastructure or access a stranger does not have, and naming that plainly is this file's job. The
supported starting points for someone with nothing already set up are `bootstrap-windows-worker.ps1`
(their own Windows machine) and the GitHub Action (no machine at all), both linked above. Self-hosting a
*fleet-joined* worker the zero-touch way is not something this project supports for an outside
contributor yet.
