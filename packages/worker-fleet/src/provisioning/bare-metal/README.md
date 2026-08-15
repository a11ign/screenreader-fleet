# Zero-touch worker install (bare metal, x64)

PXE-boot a mini PC and it joins the fleet: Windows installs, `witness` logs in, sshd comes up with your
key already installed, and the worker serves `/health`. **No console visit.**

## What goes on the install media

Alongside the Windows ISO contents, at the **root** of the media Windows Setup sees:

| File | Where it comes from | Why |
|---|---|---|
| `autounattend.xml` | this directory | Setup reads it automatically from the root of removable media |
| `first-boot.cmd` | `../../local-worker/first-boot.cmd` | waits for DHCP, stages the key, runs the bootstrap elevated |
| `bootstrap-windows-worker.ps1` | `../bootstrap-windows-worker.ps1` | node, git, sshd, `DefaultShell`, the operator key, then hands off |
| `operator-key.pub` | **your** public key — see below | what makes every later run unattended |

```bash
# Stage your PUBLIC key next to the others. It is not a secret, but it is yours, so it is staged at
# build time rather than committed — a checked-in key would silently grant access to anyone in the repo.
cp ~/.ssh/id_ed25519.pub /path/to/media/operator-key.pub
```

Without `operator-key.pub` the box still installs and serves; it just needs
`ansible-playbook ssh-key.yml -l <host> -e a11y_operator_key="$(cat ~/.ssh/id_ed25519.pub)"` once,
from a control plane that can already reach it.

## Then

```bash
# The box comes up with a DHCP address. Add it to the fleet — the ONE place a machine is defined.
$EDITOR ../../../ansible/inventory.yml
cd ../../../ansible && ansible-playbook provision.yml -l a11y-worker-N
```

## Four things this file does differently from the UTM one, and why

The sibling at `../../local-worker/autounattend.xml` is the proven recipe. This is that recipe on real
hardware and a real network, and the differences are not cosmetic:

- **No plaintext password.** The arm64 file embeds `witness`/`witness` and justifies it as *"a disposable
  local VM behind QEMU user-mode networking"*. None of that is true of a mini PC on your LAN. The account
  is created **blank** instead, which `LimitBlankPasswordUse=1` confines to console logon — no SMB, no
  RDP, no password SSH. Strictly narrower than a password, and nothing secret is committed.
- **No VirtIO drivers.** Those paths point at UTM's support ISO; real hardware has inbox drivers, and
  leaving them in fails the windowsPE pass looking for a drive that is not there.
- **`ComputerName` is `*`.** Twelve machines answering to `A11Y-WORKER` is a NetBIOS conflict. Workers are
  addressed by IP from the inventory anyway.
- **The TPM/CPU bypasses are load-bearing, not a VM workaround.** The 6th- and 7th-gen boxes in this fleet
  are not on Windows 11's supported-CPU list and Setup refuses them without these.

## It installs on unsupported hardware, deliberately

The fleet is second-hand mini PCs, and several generations of them are not on Windows 11's supported-CPU
list at all. The bypasses are therefore load-bearing rather than a lab convenience, and they are applied
in **two places**, because one is not enough:

| where | what it covers |
|---|---|
| `windowsPE` → `HKLM\System\Setup\LabConfig` | the install itself: CPU, TPM, Secure Boot, RAM, storage |
| `specialize` → `HKLM\SYSTEM\Setup\LabConfig` + `MoSetup` | the INSTALLED system, so later feature updates do not refuse |

The second one is the easy thing to miss. The WinPE keys live in the installer's registry and do not
survive into the running OS, so a box installs happily and then, months later on a machine nobody is
watching, declines a feature update with "this PC doesn't meet the minimum requirements".
`AllowUpgradesWithUnsupportedTPMOrCPU` under `MoSetup` is what covers the upgrade path specifically.

Two names, deliberately both: `BypassStorageCheck` is what Setup reads; `BypassDiskCheck` was inherited
from the arm64 file and appears in no Microsoft documentation. An ignored registry value costs nothing
and a missing one costs the install, so both are written.

`BypassNRO` removes 24H2's "connect to the internet and sign in with a Microsoft account" wall at OOBE.
`HideOnlineAccountScreens` plus a local account usually carries it — but *usually* is not a property you
want on a fleet whose screens you cannot see.

## It wipes disk 0 without asking

That is what makes it hands-off, and it is why the PXE entry serving this must be aimed at machines you
have set aside — not set as a default-for-everything boot option.

## Untested end to end

The chain (`autounattend` → `first-boot.cmd` → `bootstrap` → provisioning) is proven on the arm64 UTM
guests. This x64 adaptation has **not** been PXE-booted yet. The first run is worth watching, and the
place to look when it stalls is `C:\a11y-first-boot.log` on the box, which is written before anything
else can fail.
