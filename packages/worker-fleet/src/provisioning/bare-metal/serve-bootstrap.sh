#!/usr/bin/env bash
# Serve the three files a PXE-installing worker fetches at first logon.
#
#   ./serve-bootstrap.sh ~/.ssh/a11y-witness_ed25519.pub
#   ./serve-bootstrap.sh ~/.ssh/a11y-witness_ed25519.pub 8099
#
# Run it on the machine whose address is in autounattend.xml — normally the iVentoy host, because the
# box PXE-booted from there moments earlier and can certainly reach it.
#
# ## Why a fetch rather than files on the media
#
# iVentoy's file injection decompresses into **X:**, which is the WinPE RAM disk and is GONE by the time
# FirstLogonCommands runs. The UTM path can scan drive letters because its support ISO stays attached;
# nothing stays attached here. Rebuilding the install ISO to carry the files is the other option, and
# this project has already spent a day on El Torito boot catalogues and `0xc0000225` to earn the opinion
# that it is not worth it for three small files.
#
# ## The key is served, never committed
#
# A public key is not a secret, but it IS specific to whoever runs this fleet, and a checked-in one
# grants access to anyone with the repo. It is passed in here and served for the few minutes an install
# takes.
#
# ## Run it by hand, or as a service
#
# This serves an SSH public key and two scripts to anyone on the LAN who asks. That is a small exposure and
# a real one, so run by hand it should be Ctrl-C'd once the box is up.
#
# It used to say it was "deliberately NOT a service", and the fleet outgrew that. Started by hand it is a
# step somebody has to remember, and forgetting produces the worst failure this path has: Windows installs
# fine, the fetches retry for ~15 minutes, and the box sits at a desktop with no worker on it — which reads
# as a bad image. `a11y-bootstrap.service` beside this file runs it with Restart=always instead.
#
# If you do run it as a service, note the staging below: the payload is snapshotted at START, so a restart
# is what picks up a changed first-boot.cmd or bootstrap-windows-worker.ps1.
set -euo pipefail

KEY="${1:-}"
PORT="${2:-8099}"

if [ -z "$KEY" ] || [ ! -f "$KEY" ]; then
  echo "usage: $0 <path-to-public-key> [port]" >&2
  echo "  e.g. $0 ~/.ssh/a11y-witness_ed25519.pub" >&2
  exit 2
fi

# Refuse a PRIVATE key with the loudest message available. Handing one to every machine on the LAN is
# not a mistake anyone recovers from quietly, and the two filenames differ by four characters.
if grep -q "PRIVATE KEY" "$KEY"; then
  echo "REFUSING: $KEY is a PRIVATE key. Serve the .pub, and rotate that key now." >&2
  exit 1
fi
if ! grep -qE '^(ssh-|ecdsa-)' "$KEY"; then
  echo "REFUSING: $KEY does not look like an SSH public key (expected ssh-... or ecdsa-...)." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$HERE/../../local-worker/first-boot.cmd" "$STAGE/first-boot.cmd"
cp "$HERE/../bootstrap-windows-worker.ps1" "$STAGE/bootstrap-windows-worker.ps1"
cp "$KEY" "$STAGE/operator-key.pub"

# CRLF for the .cmd. A LF-only batch file run by cmd.exe fails in ways that name the wrong line, which is
# a debugging session nobody needs at 2am beside a mini PC.
perl -pi -e 's/\r?\n/\r\n/' "$STAGE/first-boot.cmd" 2>/dev/null || true

cat <<EOF

  Serving on port $PORT:
    first-boot.cmd
    bootstrap-windows-worker.ps1
    operator-key.pub   ($(ssh-keygen -lf "$KEY" 2>/dev/null | awk '{print $2, $3}'))

  autounattend.xml must point at THIS machine. Check the address in it matches one of:
$(command -v ip >/dev/null 2>&1 && ip -4 -o addr show scope global | awk '{print "    http://" substr($4, 1, index($4, "/")-1) ":'"$PORT"'"}' \
  || ifconfig 2>/dev/null | awk '/inet /{if ($2 != "127.0.0.1") print "    http://" $2 ":'"$PORT"'"}')

  Ctrl-C once the worker is up — this is not a service.

EOF

cd "$STAGE"
python3 -m http.server "$PORT"
