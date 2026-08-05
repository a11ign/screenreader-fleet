#!/usr/bin/env bash
# Build a local NVDA capture worker VM on Apple Silicon, unattended.
#
#   ./packages/worker-fleet/src/local-worker/build-vm.sh /path/to/Win11_ARM64.iso
#
# Produces a self-contained VM directory (default ~/a11y-worker-vm) holding the disk
# image, UEFI vars and a run script. That directory IS the portable artifact: copy it
# to another Apple Silicon Mac, run ./run.sh, done. See docs/local-worker-vm.md.
#
# Why QEMU and not UTM: `utmctl` has no `create` subcommand, so a UTM-based flow can
# only ever be "click through these GUI steps". QEMU is scriptable end to end, which is
# the difference between a reproducible artifact and a folk recipe.
set -euo pipefail

WIN_ISO="${1:-}"
VM_DIR="${A11Y_VM_DIR:-$HOME/a11y-worker-vm}"
DISK_GB="${A11Y_VM_DISK_GB:-64}"
RAM_MB="${A11Y_VM_RAM_MB:-8192}"
CPUS="${A11Y_VM_CPUS:-4}"
WORKER_PORT="${A11Y_PORT:-8765}"
SSH_PORT="${A11Y_VM_SSH_PORT:-2222}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[ -n "$WIN_ISO" ] || die "usage: $0 <windows-11-arm64.iso>   (build one with CrystalFetch, or packages/worker-fleet/src/local-worker/fetch-windows-iso.sh)"
[ -f "$WIN_ISO" ] || die "not found: $WIN_ISO"
command -v qemu-system-aarch64 >/dev/null || die "qemu missing: brew install qemu"
command -v qemu-img >/dev/null || die "qemu-img missing: brew install qemu"
command -v mkisofs >/dev/null || die "mkisofs missing: brew install cdrtools"

FW_CODE="$(ls /opt/homebrew/share/qemu/edk2-aarch64-code.fd /usr/local/share/qemu/edk2-aarch64-code.fd 2>/dev/null | head -1 || true)"
FW_VARS_SRC="$(ls /opt/homebrew/share/qemu/edk2-arm-vars.fd /usr/local/share/qemu/edk2-arm-vars.fd 2>/dev/null | head -1 || true)"
[ -n "$FW_CODE" ] || die "edk2-aarch64-code.fd not found (reinstall qemu)"
[ -n "$FW_VARS_SRC" ] || die "edk2-arm-vars.fd not found (reinstall qemu)"

mkdir -p "$VM_DIR"

# ---------------------------------------------------------------------------
info "Fetching UTM guest tools (ARM64 virtio drivers + qemu-ga)"
# These drivers are the reason this works at all: Windows 11 ARM64 has no inbox
# virtio-net driver, so without injecting NetKVM the installed OS has no network and
# cannot fetch Node/Git/NVDA. The ISO also carries qemu-ga, which gives the host a
# command channel into the guest over QMP before SSH exists.
GT_ISO="$VM_DIR/utm-guest-tools.iso"
if [ ! -f "$GT_ISO" ]; then
  GT_URL="$(curl -sL https://api.github.com/repos/utmapp/qemu/releases/latest \
    | grep -o 'https://[^"]*guest-tools[^"]*\.iso' | head -1 || true)"
  [ -n "$GT_URL" ] || die "could not resolve the guest-tools ISO URL"
  curl -L --fail -o "$GT_ISO" "$GT_URL"
fi
info "guest tools: $(du -h "$GT_ISO" | cut -f1)"

# ---------------------------------------------------------------------------
info "Building the support ISO (autounattend + drivers + bootstrap)"
# One removable medium carrying everything Setup and first logon need. Windows Setup
# picks autounattend.xml up automatically from the root of removable media.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
MNT="$(mktemp -d)"
hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$GT_ISO" >/dev/null
cp -R "$MNT/Drivers" "$STAGE/"
cp "$MNT"/utm-guest-tools-*.exe "$STAGE/utm-guest-tools.exe"
hdiutil detach "$MNT" >/dev/null
rmdir "$MNT" 2>/dev/null || true

cp "$SCRIPT_DIR/autounattend.xml" "$STAGE/autounattend.xml"
cp "$SCRIPT_DIR/first-boot.cmd" "$STAGE/first-boot.cmd"
cp "$REPO_ROOT/scripts/bootstrap-windows-worker.ps1" "$STAGE/bootstrap-windows-worker.ps1"

SUPPORT_ISO="$VM_DIR/support.iso"
# -J (Joliet) so Windows sees real filenames rather than mangled 8.3 names.
mkisofs -quiet -J -R -V A11YSUPPORT -o "$SUPPORT_ISO" "$STAGE"
info "support ISO: $(du -h "$SUPPORT_ISO" | cut -f1)"

# ---------------------------------------------------------------------------
info "Creating disk and UEFI vars"
[ -f "$VM_DIR/disk.qcow2" ] || qemu-img create -f qcow2 "$VM_DIR/disk.qcow2" "${DISK_GB}G" >/dev/null
[ -f "$VM_DIR/efi-vars.fd" ] || cp "$FW_VARS_SRC" "$VM_DIR/efi-vars.fd"
# Symlink rather than copy: the Windows ISO is ~4 GB and only needed for --install.
# (When exporting the VM to another machine, the symlink is simply absent, which is
# fine -- normal boots do not use it.)
#
# Guard against the source ALREADY being $VM_DIR/windows.iso: `ln -sf x x` creates a
# symlink to itself and destroys the file. Passing the staged ISO back in is the obvious
# thing to do on a second run, so this must not eat it.
WIN_ISO_ABS="$(cd "$(dirname "$WIN_ISO")" && pwd)/$(basename "$WIN_ISO")"
if [ "$WIN_ISO_ABS" != "$VM_DIR/windows.iso" ]; then
  ln -sf "$WIN_ISO_ABS" "$VM_DIR/windows.iso"
else
  info "ISO is already staged at $VM_DIR/windows.iso; leaving it alone"
fi

# ---------------------------------------------------------------------------
info "Writing run.sh"
cat > "$VM_DIR/run.sh" <<RUNSH
#!/usr/bin/env bash
# Launch the a11y-witness NVDA worker VM. Generated by build-vm.sh.
#   ./run.sh            headless; worker on 127.0.0.1:${WORKER_PORT}, ssh on 2222
#   ./run.sh --install  first run: boot from the Windows ISO to install unattended
set -euo pipefail
VM_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
INSTALL=0
[ "\${1:-}" = "--install" ] && INSTALL=1

ARGS=(
  -M virt,highmem=on
  -accel hvf
  -cpu host
  -smp ${CPUS}
  -m ${RAM_MB}
  -drive if=pflash,format=raw,unit=0,readonly=on,file=${FW_CODE}
  -drive if=pflash,format=raw,unit=1,file="\$VM_DIR/efi-vars.fd"
  # NVMe rather than virtio-blk for the system disk: Windows 11 ARM64 has an inbox
  # NVMe driver, so the disk is visible to Setup with no driver injection at all.
  -drive file="\$VM_DIR/disk.qcow2",if=none,id=hd0,format=qcow2,cache=writeback,discard=unmap
  -device nvme,drive=hd0,serial=a11yworker
  # User-mode networking: the guest is NAT'd and unreachable except through these
  # forwards, bound to loopback. That is what makes the plaintext password in
  # autounattend.xml tolerable -- keep it that way, do not bridge this VM.
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:${WORKER_PORT}-:${WORKER_PORT},hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22
  -device virtio-net-pci,netdev=net0
  -device virtio-gpu-pci
  -device qemu-xhci
  -device usb-kbd
  -device usb-tablet
  -device virtio-rng-pci
  # The monitor socket is how you get EYES on a headless install:
  #   echo "screendump /tmp/vm.ppm" | socat - unix:\$VM_DIR/monitor.sock
  -monitor unix:"\$VM_DIR/monitor.sock",server,nowait
  -qmp unix:"\$VM_DIR/qmp.sock",server,nowait
  -display none
  -vnc 127.0.0.1:1
  -rtc base=localtime
)

# CD-ROMs attach as USB storage, NOT with a bare "-drive media=cdrom". The aarch64
# "virt" machine has no IDE bus, so the bare form fails to start at all ("No 'ide' bus
# found"). virtio-blk would work for QEMU but Windows Setup cannot see a virtio disk
# without the driver it is trying to read FROM that disk; USB mass storage is inbox on
# Windows, so it sidesteps the chicken-and-egg entirely.
if [ \$INSTALL -eq 1 ]; then
  ARGS+=(
    -drive file="\$VM_DIR/windows.iso",if=none,id=cdwin,media=cdrom,readonly=on
    -device usb-storage,drive=cdwin,removable=on,bootindex=0
    -drive file="\$VM_DIR/support.iso",if=none,id=cdsup,media=cdrom,readonly=on
    -device usb-storage,drive=cdsup,removable=on
  )
else
  # Keep the support ISO attached: provisioning may want the guest-tools installer,
  # and an absent drive letter is a confusing failure mode.
  ARGS+=(
    -drive file="\$VM_DIR/support.iso",if=none,id=cdsup,media=cdrom,readonly=on
    -device usb-storage,drive=cdsup,removable=on
  )
fi

exec qemu-system-aarch64 "\${ARGS[@]}"
RUNSH
chmod +x "$VM_DIR/run.sh"

# Screenshot helper. The VM runs headless, so this is the only way to see what an
# unattended install is actually doing -- and "it is silently sitting on a prompt" and
# "it is working fine" look identical without it.
cat > "$VM_DIR/shot.sh" <<'SHOTSH'
#!/usr/bin/env bash
# Screenshot the headless guest. Usage: ./shot.sh [outfile.png]
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$D/shot.png}"
command -v socat >/dev/null || { echo "needs socat: brew install socat" >&2; exit 1; }
[ -S "$D/monitor.sock" ] || { echo "no monitor.sock -- is the VM running?" >&2; exit 1; }
echo "screendump $D/.shot.ppm" | socat - unix-connect:"$D/monitor.sock" >/dev/null 2>&1
sips -s format png "$D/.shot.ppm" --out "$OUT" >/dev/null 2>&1
echo "$OUT  (disk now $(du -h "$D/disk.qcow2" | cut -f1))"
SHOTSH
chmod +x "$VM_DIR/shot.sh"

cat <<EOF

--- VM prepared in $VM_DIR ---

  1. Start the unattended install (takes ~20-40 min, no interaction):
         $VM_DIR/run.sh --install

  2. Watch it without a display (screendump needs socat: brew install socat):
         echo "screendump $VM_DIR/shot.ppm" | socat - unix:$VM_DIR/monitor.sock
         # then convert/view: sips -s format png $VM_DIR/shot.ppm --out $VM_DIR/shot.png

  3. When it settles, the worker should answer on the host:
         curl http://127.0.0.1:${WORKER_PORT}/health
         ssh -p ${SSH_PORT} witness@127.0.0.1

  4. Point the control plane at it:
         A11Y_WORKER=http://127.0.0.1:${WORKER_PORT} npm run witness -- https://example.com --task "..."

  Subsequent boots: $VM_DIR/run.sh   (no --install)

  To hand this to someone else, copy the whole $VM_DIR directory. Shut the guest down
  cleanly first, and see docs/local-worker-vm.md for shrinking it.
EOF
