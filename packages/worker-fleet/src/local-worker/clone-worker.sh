#!/usr/bin/env bash
# Clone the local NVDA worker VM into an additional, independent worker.
#
#   ./packages/worker-fleet/src/local-worker/clone-worker.sh [new-name]      # default: a11y-worker-2
#
# One worker serves one capture at a time by design (one desktop, one foreground window, one
# NVDA), so throughput scales by running more of them. On APFS the clone is copy-on-write, so
# it costs seconds and almost no disk until the two diverge.
#
# THE REASON THIS SCRIPT EXISTS: `utmctl clone` copies the MAC address. Two VMs with the same
# MAC on one vmnet share a single DHCP lease — the clone takes the original's IP and the
# original ends up with NO address at all. It boots perfectly and looks utterly dead from
# outside, which is a miserable thing to debug. So the clone gets a fresh MAC before it is
# ever started.
#
# Editing config.plist requires UTM to be quit: it caches configuration in memory and will
# write its cached copy back over the edit.
set -euo pipefail

# architecture-audit.md §8: clones a local UTM worker VM, which is deprecated -- "The UTM is deprecated,
# that was a testing thing." (repository owner, 2026-09-05). Capture on the bare-metal fleet instead:
# npm run fleet:status, npm run fleet:deploy.
echo "DEPRECATED: clone-worker.sh clones a local UTM worker VM. UTM was a testing path and is not the fleet." >&2
echo "Capture on the bare-metal fleet instead: npm run fleet:status, npm run fleet:deploy." >&2

SOURCE_NAME="${A11Y_VM_NAME:-a11y-worker}"
NEW_NAME="${1:-${SOURCE_NAME}-2}"
DOCS="$HOME/Library/Containers/com.utmapp.UTM/Data/Documents"
BOOT_TIMEOUT_S=300
PORT="${A11Y_PORT:-8765}"

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

command -v utmctl >/dev/null || die "utmctl not found (brew install --cask utm)"
pgrep -x UTM >/dev/null || { say "launching UTM (utmctl needs the app)"; open -a UTM; sleep 5; }

uuid_of() { utmctl list | awk -v n="$1" '$3 == n { print $1 }'; }

SOURCE_UUID="$(uuid_of "$SOURCE_NAME")"
[ -n "$SOURCE_UUID" ] || die "no VM named '$SOURCE_NAME'"
[ "$(echo "$SOURCE_UUID" | wc -l | tr -d ' ')" -eq 1 ] || die "several VMs named '$SOURCE_NAME'; see docs/local-worker-vm.md"
[ -z "$(uuid_of "$NEW_NAME")" ] || die "'$NEW_NAME' already exists. Pick another name, or remove it in UTM first."

# Clone a stopped VM. Copying a running disk gives a crash-consistent image — the clone would
# boot as though the power had been pulled, with the dirty-volume repair that implies.
if [ "$(utmctl status "$SOURCE_UUID")" != "stopped" ]; then
  say "stopping '$SOURCE_NAME' cleanly first (a clone of a running disk boots dirty)"
  utmctl stop "$SOURCE_UUID" --request >/dev/null
  for _ in $(seq 1 40); do
    [ "$(utmctl status "$SOURCE_UUID")" = "stopped" ] && break
    sleep 3
  done
  [ "$(utmctl status "$SOURCE_UUID")" = "stopped" ] || die "'$SOURCE_NAME' would not shut down; stop it by hand and re-run"
fi

say "cloning '$SOURCE_NAME' -> '$NEW_NAME'"
utmctl clone "$SOURCE_UUID" --name "$NEW_NAME" >/dev/null
NEW_UUID="$(uuid_of "$NEW_NAME")"
[ -n "$NEW_UUID" ] || die "clone reported success but '$NEW_NAME' is not registered"

CONFIG="$DOCS/$NEW_NAME.utm/config.plist"
[ -f "$CONFIG" ] || die "cloned bundle has no config.plist at $CONFIG"

# Every VM must be stopped before UTM is quit, not just the one being cloned.
#
# Quitting UTM tries to SUSPEND anything still running, and suspend fails outright with an
# emulated NVMe disk — which ours is. The result is a modal dialog ("Failed to save suspend
# state ... Quitting UTM will kill all running VMs") that blocks the script and, if dismissed
# with OK, takes down every running worker. Found by running this script while a second worker
# was serving.
say "stopping every running VM before quitting UTM (suspend fails on NVMe, and quitting kills running VMs)"
for uuid in $(utmctl list | awk 'NR > 1 && $2 != "stopped" { print $1 }'); do
  utmctl stop "$uuid" --request >/dev/null 2>&1 || true
done
for _ in $(seq 1 40); do pgrep -f QEMULauncher >/dev/null || break; sleep 3; done
for uuid in $(utmctl list | awk 'NR > 1 && $2 != "stopped" { print $1 }'); do
  utmctl stop "$uuid" >/dev/null 2>&1 || true
done
for _ in $(seq 1 10); do pgrep -f QEMULauncher >/dev/null || break; sleep 2; done
pgrep -f QEMULauncher >/dev/null && die "a VM is still running; stop it by hand before re-running"

say "quitting UTM so the config edit is not overwritten from its cache"
osascript -e 'tell application "UTM" to quit' 2>/dev/null || true
for _ in $(seq 1 10); do pgrep -x UTM >/dev/null || break; sleep 2; done

# Locally administered, unicast: first octet 0x52 has bit 1 set (local) and bit 0 clear
# (unicast), so it cannot collide with a real vendor's allocation.
NEW_MAC="$(python3 -c "
import random
print(':'.join(['52'] + ['%02X' % random.randint(0, 255) for _ in range(5)]))")"
cp "$CONFIG" "$CONFIG.bak"
plutil -replace Network.0.MacAddress -string "$NEW_MAC" "$CONFIG" \
  || die "could not set the MAC; the original config is at $CONFIG.bak"
READBACK="$(plutil -extract Network.0.MacAddress raw "$CONFIG")"
[ "$READBACK" = "$NEW_MAC" ] || die "MAC did not take (read back '$READBACK'); config backed up at $CONFIG.bak"
say "new MAC $NEW_MAC (source keeps its own)"

open -a UTM
for _ in $(seq 1 15); do sleep 2; utmctl list >/dev/null 2>&1 && break; done

# Start the source first. Both guests carry the same Windows machine identity, and letting one
# settle before the other avoids two identical hostnames racing for the same DHCP server.
for name in $(utmctl list | awk -v n="$SOURCE_NAME" 'NR > 1 && $3 ~ "^"n { print $3 }' | sort -u); do
  uuid="$(uuid_of "$name")"
  say "starting '$name'"
  utmctl start "$uuid" >/dev/null
  waited=0
  ip=""
  while [ "$waited" -lt "$BOOT_TIMEOUT_S" ]; do
    sleep 10; waited=$((waited + 10))
    # Ignore link-local: a guest reports 169.254.x.x while DHCP is still pending, and that
    # reads as a failure when it is just "not yet".
    ip="$(utmctl ip-address "$uuid" 2>/dev/null | grep -oE '^[0-9.]+' | grep -v '^127' | grep -v '^169\.254' | head -1 || true)"
    [ -n "$ip" ] && break
  done
  [ -n "$ip" ] || die "'$name' never got a DHCP lease in ${BOOT_TIMEOUT_S}s. Check its MAC is unique: plutil -extract Network.0.MacAddress raw '$DOCS/$name.utm/config.plist'"
  health=""
  while [ "$waited" -lt "$BOOT_TIMEOUT_S" ]; do
    health="$(curl -s -m 5 "http://$ip:$PORT/health" 2>/dev/null || true)"
    [ -n "$health" ] && break
    sleep 10; waited=$((waited + 10))
  done
  say "  $name  $ip  ${health:-NOT ANSWERING /health yet}"
done

echo
say "pool:"
./"$(dirname "$0")/worker-ctl.sh" pool 2>/dev/null || echo "  (run npm run worker:ctl -- pool)"
