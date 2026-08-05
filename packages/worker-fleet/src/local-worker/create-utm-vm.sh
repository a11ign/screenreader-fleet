#!/usr/bin/env bash
# Create the NVDA worker VM in UTM, fully from the CLI. No GUI clicking.
#
#   ./packages/worker-fleet/src/local-worker/create-utm-vm.sh <windows-arm64.iso> [support.iso]
#
# Why UTM rather than plain QEMU: homebrew QEMU + HVF cannot boot Windows 11 ARM64 on
# Apple Silicon (open upstream bug, https://gitlab.com/qemu-project/qemu/-/issues/2893,
# reproduced here across five machine configurations). UTM ships a QEMU patched for
# Windows-on-ARM, but it is a dlopen'd framework, not an executable, so it cannot be
# driven from a shell.
#
# The way in is UTM's scripting interface, which DOES support creation even though
# `utmctl` has no `create` subcommand:
#     make new virtual machine with properties {backend:qemu, configuration:{...}}
# (see /Applications/UTM.app/Contents/Resources/UTM.sdef -- the `make` command takes a
# `qemu configuration` record).
set -euo pipefail

WIN_ISO="${1:-}"
SUPPORT_ISO="${2:-$HOME/a11y-worker-vm/support.iso}"
VM_NAME="${A11Y_VM_NAME:-a11y-worker}"
# 4 GB: the documented Windows 11 minimum, and measured sufficient. Driving Edge and NVDA is
# not memory-intensive. Verified by running the same 10 cases on 4 GB and 8 GB VMs -- 165s vs
# 167s, byte-identical evidence (62 phrases, 51 role words, 22 heading-levels), and ZERO
# pagefile use on either guest, so nothing is being paged to fake the result.
#
# Do not size this from Windows' "in use" figure: that includes the file cache, which grows to
# fill whatever it is given. An 8 GB guest reported 3.5 GB "in use" and needed less than half
# of it. Committed bytes is the number that means anything.
RAM_MB="${A11Y_VM_RAM_MB:-4096}"
CPUS="${A11Y_VM_CPUS:-4}"
DISK_MB="${A11Y_VM_DISK_MB:-65536}"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[ -n "$WIN_ISO" ] || die "usage: $0 <windows-arm64.iso> [support.iso]"
[ -f "$WIN_ISO" ] || die "not found: $WIN_ISO"
[ -f "$SUPPORT_ISO" ] || die "support ISO not found: $SUPPORT_ISO (run build-vm.sh first)"
[ -d /Applications/UTM.app ] || die "UTM not installed: brew install --cask utm"

DOCS="$HOME/Library/Containers/com.utmapp.UTM/Data/Documents"
BUNDLE="$DOCS/$VM_NAME.utm"
[ -e "$BUNDLE" ] && die "$BUNDLE already exists. Remove it first: utmctl delete $VM_NAME"

# Refuse to create a SECOND registration with this name. Two registrations end up pointing
# at the same $VM_NAME.utm bundle, and then `utmctl delete` on EITHER of them removes that
# shared directory -- taking the other VM's disk and UEFI vars with it. That is not a
# name-resolution problem you can dodge by using UUIDs: it destroyed a fully provisioned
# worker here, and the only symptom afterwards is a start failing with
# 'The file "edk2-arm-vars.fd" doesn't exist'.
EXISTING_REG="$(utmctl list 2>/dev/null | awk -v n="$VM_NAME" '$3 == n { print $1 }' || true)"
if [ -n "$EXISTING_REG" ]; then
  # Note we only get here when the bundle is ALREADY gone (checked just above), so this is
  # an orphaned registration -- and `utmctl delete` on one of those fails with -2700 and
  # leaves the entry behind. Editing UTM's registry is the route that works.
  die "UTM already has a VM registered as '$VM_NAME', but its bundle is gone:
$EXISTING_REG
Clear the stale registration first -- see 'Never utmctl delete a VM whose name appears
twice' in docs/local-worker-vm.md for the PlistBuddy recipe. Do NOT use 'utmctl delete':
registrations sharing a name share one bundle, so it can destroy a working VM's disk.
Or pass A11Y_VM_NAME=<other> to build alongside the existing one."
fi

# UTM is sandboxed and will not follow a symlink out to /private/tmp, so give it real
# files in the user's home.
STAGE="$HOME/a11y-worker-vm"
mkdir -p "$STAGE"
if [ "$(cd "$(dirname "$WIN_ISO")" && pwd)/$(basename "$WIN_ISO")" != "$STAGE/windows.iso" ]; then
  info "Staging the Windows ISO into $STAGE (UTM's sandbox cannot read /private/tmp)"
  cp "$WIN_ISO" "$STAGE/windows.iso"
fi
[ -f "$STAGE/support.iso" ] || cp "$SUPPORT_ISO" "$STAGE/support.iso"

info "Launching UTM"
open -a UTM
for _ in $(seq 1 20); do pgrep -x UTM >/dev/null && break; sleep 1; done
pgrep -x UTM >/dev/null || die "UTM did not start"
sleep 3

info "Creating the VM via UTM's scripting interface"
# Three things here are load-bearing and were each found the hard way:
#
# 1. `displays` is NOT optional. Omit it and UTM builds the VM with no graphics adapter
#    at all (`-vga none -nographic` in the launch line); Windows Setup cannot run
#    without a framebuffer and the guest just sits there. virtio-ramfb is a plain UEFI
#    framebuffer, which is what you want: Windows 11 ARM64 has no inbox virtio-gpu
#    driver, and UTM disables the viogpu guest driver anyway (it causes a black screen).
#
# 2. DRIVE ORDER IS BOOT ORDER, and the SYSTEM DISK MUST COME FIRST. UTM assigns
#    `bootindex` by position. Firmware skips the empty disk (no bootloader on it yet),
#    boots the ISO, installs -- and then, crucially, Setup REBOOTS. If the ISO were
#    first, that reboot starts the installer again from scratch, forever. With the disk
#    first, the reboot finds the freshly written bootloader and Setup continues into its
#    specialize/oobeSystem phases.
#
#    Do not "fix" a boot failure by moving the ISO first: if firmware drops to the EDK2
#    UEFI Shell with the disk first, the real cause is that the ISO has no valid UEFI
#    El Torito record (see fetch-windows-iso.sh), not the ordering.
#
# 3. Do not try to drive that shell with `input keystroke`: it routes through the SPICE
#    guest agent, which does not exist in UEFI, so the text silently never arrives
#    (`input scan code` does reach the hardware, and is the only way to send keys before
#    an OS is installed).
VM_ID="$(osascript <<APPLESCRIPT
tell application "UTM"
  set vm to make new virtual machine with properties {backend:qemu, configuration:{name:"$VM_NAME", architecture:"aarch64", machine:"virt", memory:$RAM_MB, cpu cores:$CPUS, hypervisor:true, uefi:true, displays:{{hardware:"virtio-ramfb"}}, network interfaces:{{mode:shared}}, drives:{{guest size:$DISK_MB, interface:NVMe}, {source:POSIX file "$STAGE/windows.iso", interface:USB}, {source:POSIX file "$STAGE/support.iso", interface:USB}}}}
  return id of vm
end tell
APPLESCRIPT
)"
[ -n "$VM_ID" ] || die "VM creation returned no id"
info "created $VM_NAME ($VM_ID)"

# UTM's scripting layer imports an ISO given as `source` by CONVERTING it to a qcow2
# and attaching it as a fixed Disk -- and `removable` is read-only in the sdef, so this
# cannot be expressed at creation time. Windows Setup will not read autounattend.xml off
# a fixed disk, and the windowsPE driver injection depends on that medium, so rewrite
# the two entries as real read-only CDs. UTM caches configs in memory, hence the quit.
#
# Keep such edits to values of keys UTM already wrote. UTM decodes config.plist with
# strict Swift Codable: one unexpected value and the VM silently DISAPPEARS from
# `utmctl list` with no error anywhere. (Learned by writing lowercase "linear" where UTM
# writes "Linear" for a display filter.) Anything structural should go through the
# scripting interface instead, which validates and fills defaults.
info "Rewriting the ISO drives as CD-ROMs (not expressible via scripting)"
osascript -e 'tell application "UTM" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 20); do pgrep -x UTM >/dev/null || break; sleep 1; done
sleep 2

cp "$STAGE/windows.iso" "$BUNDLE/Data/windows.iso"
cp "$STAGE/support.iso" "$BUNDLE/Data/support.iso"
python3 - "$BUNDLE/config.plist" <<'PY'
import plistlib, sys
p = sys.argv[1]
d = plistlib.load(open(p, 'rb'))
for drive in d['Drive']:
    name = drive.get('ImageName', '')
    if name.startswith('windows'):
        drive.update(ImageName='windows.iso', ImageType='CD', ReadOnly=True)
    elif name.startswith('support'):
        drive.update(ImageName='support.iso', ImageType='CD', ReadOnly=True)
plistlib.dump(d, open(p, 'wb'))
for drive in d['Drive']:
    print("    %-12s %-6s %s" % (drive['ImageType'], drive['Interface'], drive['ImageName']))
PY
# Reclaim the qcow2 copies UTM made of both ISOs (~4.5 GB).
rm -f "$BUNDLE/Data/windows.qcow2" "$BUNDLE/Data/support.qcow2"

info "Starting the VM (Windows installs unattended from support.iso)"
open -a UTM
for _ in $(seq 1 20); do pgrep -x UTM >/dev/null && break; sleep 1; done
sleep 3
# Operate by UUID, never by name. If two registrations ever share a name, `utmctl start
# <name>` silently picks the wrong one -- and `utmctl delete <name>` will remove the
# SHARED bundle directory, destroying the other VM's disk with it.
utmctl start "$VM_ID"
utmctl status "$VM_ID"

DISK="$(ls "$BUNDLE/Data"/*.qcow2 | head -1)"
cat <<EOF

--- $VM_NAME started ---

The install is unattended. There is no console screenshot from the CLI, so track it by
side effect -- Windows only writes to the system disk once Setup is really running:

    watch: du -h "$DISK"
    (WinPE decompresses boot.wim into RAM first, so expect a few minutes at 0 growth)

When it is up:
    utmctl query ip $VM_ID            # needs qemu-ga, installed at first logon
    curl http://<guest-ip>:8765/health
    A11Y_WORKER=http://<guest-ip>:8765 npm run witness -- https://example.com --task "..."

Guest commands without SSH (qemu-ga, via UTM):
    utmctl exec $VM_ID --cmd "powershell -Command Get-Process node"

Troubleshooting the worker itself: docs/nvda-worker-runbook.md
EOF
