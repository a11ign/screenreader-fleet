# Zero-touch worker install (bare metal, x64)

PXE-boot a mini PC and it joins the fleet: Windows installs, `witness` logs in, sshd comes up with your
key already installed, and the worker serves `/health`. **No console visit.**

## Detach the network until first boot has pinned Edge

**Learned on a11y-worker-7, 2026-09-04, and it cost a reimage.** Nothing in first boot mentioned Edge
until then. The box installed Windows, came up with a network, and Edge updated itself to 152 while
`npm install` was still running. `roles/worker/tasks/edge-version.yml` then refused, correctly:

> a11y-worker-7 is on Edge 152.0.4191.62, NEWER than the pinned 151.0.4129.107. Chromium will not install
> over a newer build and Windows will not let it be uninstalled, so this role cannot bring it back.

`browserVersion` is FIRST in `fleet-consistency`'s MUST_MATCH list and part of the capture cache key, so a
box on a different Edge build does not merely underperform — **every capture run refuses to start, on
every box.** The only remedies are reimaging that one machine or moving the pin and recapturing the whole
corpus.

Bootstrap step 5 now stops the Edge updater and installs the pinned build, and it runs BEFORE the handoff
to provisioning. That closes the window in the normal case. It cannot close it entirely: the box needs a
network for step 3 to fetch the payload, and Edge can begin updating in the minutes before step 5 lands.

So on a slow box, or one that sat at the desktop before you got to it, **check before assuming**:

```powershell
(Get-Item 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe').VersionInfo.ProductVersion
```

Newer than the pin means reimage now, while it is cheap. Step 5 says so itself rather than trying and
reporting success.

## How a box gets installed, end to end

```
PXE  ->  iVentoy serves the Windows ISO + autounattend.xml
     ->  Windows installs unattended, creates `witness`, auto-logs on
     ->  FirstLogonCommands fetches 3 files over HTTP from the control plane
     ->  first-boot.cmd waits for DHCP, stages the key, runs bootstrap elevated
     ->  bootstrap installs node/git/sshd, sets DefaultShell, installs the operator key
     ->  the box is reachable by Ansible. No console visit after the firmware step.
```

### 1. At the machine, once — do both while you are there

Nothing can automate this: the box is off and has no OS to ask.

- **Enable Wake-on-LAN** in firmware. Usually under Power Management; may be called *Wake on LAN/WLAN*,
  *Power On By PCIe*, or *Resume by PCI-E Device*. On HP and Dell business desktops **Deep Sleep must
  also be disabled** — it cuts the NIC's standby power and silently defeats WoL.
- **Note the MAC.** It goes in `inventory.yml` and is the one fact about a box that cannot be discovered
  while it is off.
- Set it to network-boot.

### 2. On the control plane, serve the payload

```bash
./serve-bootstrap.sh ~/.ssh/<fleet key filename>.pub        # port 8099
```

It refuses a private key, and it is not a service — Ctrl-C when the box is up.

### 3. In iVentoy

The PXE server is **Proxmox CT 110 `iventoy-pxe`** (address in `inventory.yml`), web UI on `:26000`.

Point the Windows 11 x64 ISO's **Auto Install Script** at this directory's `autounattend.xml`, and set a
non-zero boot timeout so the install starts without a keypress.

**Check the PXE service is started** — the container running is not the same as the service running, and
with it stopped a machine set to network-boot finds nothing at all, which looks exactly like a firmware
boot-order mistake and is not one.

Ask iVentoy, do not probe the port:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"method":"query_status"}' http://<the pxe host>:26000/iventoy/json     # {"status": "running"}
```

**TFTP is UDP.** A TCP connect to port 69 fails whether the service is up or down, so it cannot
distinguish the two — which is this repo's recurring rule (a check that shares a failure mode with the
thing it checks verifies nothing) in its cheapest possible form. It was got wrong here first time and
reported a running server as stopped. `nc -zvu` is the port-level check if you want one; `query_status`
is better, because it asks the service rather than the socket.

The same endpoint drives the rest: `start_server`, `stop_server`, `sys_ip_list`, `get_img_tree`,
`img_add_auto_script`, `img_set_auto_id`, `img_set_auto_timeout`.

**Check the address in `autounattend.xml`.** It has `http://<fleet-control host>:8099` baked in, and that must be
the machine running `serve-bootstrap.sh`.

That address is the **fleet-control container**, not the iVentoy host, and the reason is that
`serve-bootstrap.sh` needs two things that live there and nowhere else: the repo (it copies
`first-boot.cmd` and `bootstrap-windows-worker.ps1` out of the checkout) and the fleet public key. Serving
from the PXE host instead would mean cloning the repo onto it and copying a key across, which puts fleet
material on a second box to save nothing. Both are on the same bridge, so a machine that can PXE-boot from
one can certainly fetch three files over HTTP from the other.

### Why the files are fetched rather than injected

iVentoy's file injection decompresses into **`X:`** — the WinPE RAM disk, which is gone by the time
`FirstLogonCommands` runs. The UTM path can scan drive letters because its support ISO stays attached;
nothing stays attached here. Rebuilding the install ISO to carry the files is the other option, and this
project has already spent a day on El Torito boot catalogues and `0xc0000225` to earn the opinion that it
is not worth it for three small files.

### 4. Then, entirely remotely

```bash
npm run fleet:discover -- --enroll              # finds the box, reads its MAC from ARP, adds it
cd ../../../ansible
ansible a11y_workers -m ansible.windows.win_ping -l a11y-worker-N
ansible-playbook provision-role.yml -l a11y-worker-N --check --diff
ansible-playbook provision-role.yml -l a11y-worker-N
ansible-playbook sleep.yml -l a11y-worker-N && ansible-playbook wake.yml -l a11y-worker-N
```

That last line is the point of the firmware step: WoL is only really verified by powering a box down and
getting it back, and it is far better to find a wrong firmware setting while you are still next to the
machine.

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

## The media is VERSIONED — refresh `autounattend.xml` before every install

This file is copied onto the boot media (iVentoy's auto-install script, or a Ventoy USB stick), so a
stick prepared once carries whatever this file said that day. It has been fixed **three times since the
fleet was built**, and each fix came from a real install that failed:

| | |
|---|---|
| `279e161` 15 Aug | aims the payload fetch at fleet-control (`<fleet-control host>:8099`) rather than the PXE host |
| `5d4b877` 15 Aug | the install asked for a locale the media does not carry |
| `4fff4c6` 23 Aug | the product key stopped matching the edition once `install.wim` was split |

**But do NOT reflash a stick that has installed boxes successfully, and the third row is why.**

The product-key fix is conditional on the MEDIA, not on the box. The generic KMS key worked while the ISO
shipped a single `install.wim`, and only began failing once `install.wim` was SPLIT into `install.swm`
parts to fit a file-size limit — Setup then validates the key against the edition it resolved from the
split image and the two disagree. A stick whose ISO is unsplit never meets that.

Measured on this fleet: all four workers first-booted between 15 and 16 August, at commits that are
ancestors of the 23 August fix. So they were installed WITH the KMS key and they installed fine, which is
positive evidence that stick's ISO is unsplit. The two 15 August fixes (locale, payload address) are
already in it.

So the honest rule is **check what changed and why, rather than refreshing on principle**. The current
file is the more portable one — no key at all works on split and unsplit media alike — but that
combination has been proven zero times on unsplit media, and the stick's has been proven four times.
Swapping a proven combination for an untested one, in the one phase of the process with no remote
diagnosis, is the wrong trade. Refresh when a fix applies to your media, or when you change the ISO.

`serve-bootstrap.sh` must be RUNNING on the control plane while the box installs: the media fetches three
files over HTTP and is not self-contained (see *Why the files are fetched rather than injected*).

This section previously read "Untested end to end — this x64 adaptation has not been PXE-booted yet."
That is stale: the three fixes above are what a real install produces, and the fleet is four boxes. It is
not a claim of a clean unattended run start to finish, which nobody has recorded. The place to look when
it stalls is still `C:\a11y-first-boot.log` on the box, written before anything else can fail.
