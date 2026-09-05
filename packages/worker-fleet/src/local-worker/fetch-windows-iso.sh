#!/usr/bin/env bash
# Build an official Windows 11 ARM64 ISO on macOS, from the CLI.
#
#   ./packages/worker-fleet/src/local-worker/fetch-windows-iso.sh [outdir]
#
# Microsoft's ARM64 ISO download is a session-token web flow that does not script
# cleanly, so this uses UUP dump: it fetches the same Unified Update Platform packages
# from Microsoft's update servers and assembles them locally. The bits are official;
# the assembly is local.
#
# The conversion needs five tools. Four are in homebrew-core. `chntpw` is NOT, and the
# only convenient macOS build is the universal one inside CrystalFetch.app -- which is
# signed against that bundle, so invoking it directly dies with SIGTRAP (exit 133)
# unless the bundle's OpenSSL.framework is on the framework path. Hence the shim below.
set -euo pipefail

# architecture-audit.md §8: builds an ISO for a local UTM worker VM, which is deprecated -- "The UTM is
# deprecated, that was a testing thing." (repository owner, 2026-09-05). Bare-metal boxes install via
# PXE/autounattend.xml instead — see packages/worker-fleet/src/provisioning/bare-metal/.
echo "DEPRECATED: fetch-windows-iso.sh feeds a local UTM worker VM build. UTM was a testing path and is not the fleet." >&2
echo "Capture on the bare-metal fleet instead: npm run fleet:status, npm run fleet:deploy." >&2

OUT_DIR="${1:-$HOME/a11y-worker-vm/iso-build}"
EDITION="${A11Y_WIN_EDITION:-professional}"
LANG_CODE="${A11Y_WIN_LANG:-en-us}"

# Default to 23H2, NOT the newest build. Windows 11 24H2 replaced Setup with one that
# calls SetupPrep.exe, is far stricter about autounattend.xml, and frequently ignores it
# outright -- we saw the install boot fine and then stop dead on the language/region
# prompt, which is the symptom widely reported by others. 23H2 uses the classic Setup and
# honours the unattend file. Override with A11Y_WIN_VERSION if you want to retest 24H2.
WIN_VERSION="${A11Y_WIN_VERSION:-23H2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

command -v brew >/dev/null || die "homebrew required"

info "Installing conversion tools"
for f in aria2 cabextract wimlib cdrtools; do
  brew list --formula "$f" >/dev/null 2>&1 || brew install "$f"
done

CF_BIN="/Applications/CrystalFetch.app/Contents/MacOS/chntpw"
CF_FW="/Applications/CrystalFetch.app/Contents/Frameworks"
if [ ! -x "$CF_BIN" ]; then
  info "chntpw not found; installing CrystalFetch (it bundles a universal build)"
  brew install --cask crystalfetch
fi
[ -x "$CF_BIN" ] || die "chntpw unavailable and CrystalFetch install failed"

SHIM_DIR="$OUT_DIR/.tools"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/chntpw" <<SHIM
#!/bin/bash
exec env DYLD_FRAMEWORK_PATH="$CF_FW" "$CF_BIN" "\$@"
SHIM
chmod +x "$SHIM_DIR/chntpw"
export PATH="$SHIM_DIR:$PATH"

for t in aria2c cabextract wimlib-imagex chntpw mkisofs; do
  command -v "$t" >/dev/null || die "missing tool: $t"
done
info "toolchain ready"

info "Finding the newest RETAIL Windows 11 ARM64 build for $WIN_VERSION"
# The listing includes Insider Preview builds; filter to released versions so the worker
# is not sitting on a preview OS. Titles look like "Windows 11, version 23H2".
UUID="$(curl -sL --fail "https://api.uupdump.net/listid.php?search=windows%2011&sortByDate=1" \
  | WANT="$WIN_VERSION" node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const want = (process.env.WANT || "").toLowerCase();
      const builds = JSON.parse(s)?.response?.builds || {};
      const rows = Object.values(builds).filter(b =>
        /arm64/i.test(b.arch || "") &&
        /^Windows 11, version/i.test(b.title || "") &&
        (b.title || "").toLowerCase().includes("version " + want));
      if (!rows.length) { process.exit(1); }
      console.log(rows[0].uuid);
    });')"
[ -n "$UUID" ] || die "could not find a retail Windows 11 ARM64 $WIN_VERSION build"
info "build uuid: $UUID"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

# Idempotence: if a finished ISO with a UEFI boot record is already here, stop. And if the
# converter's output is present, skip straight to the rebuild rather than re-downloading
# ~10 GB. Re-running this script should cost minutes, not an hour.
EXISTING="$(ls -t "$OUT_DIR"/*.ISO "$OUT_DIR"/*.iso 2>/dev/null | grep -vi support | head -1 || true)"
if [ -n "$EXISTING" ] && xorriso -indev "$EXISTING" -report_el_torito plain 2>/dev/null | grep -q UEFI; then
  echo "ISO ready (already built): $EXISTING"
  echo "Next:  ./packages/worker-fleet/src/local-worker/create-utm-vm.sh \"$EXISTING\""
  exit 0
fi
if [ -n "$EXISTING" ]; then
  info "found an existing converter ISO; skipping download and going straight to the rebuild"
  SKIP_DOWNLOAD=1
fi

info "Fetching the UUP download+convert pack"
# autodl=2 is "download using aria2 and convert". autodl=3 is the virtual-editions
# flow and errors out unless you request extra editions.
curl -sL --fail -o pack.zip \
  "https://uupdump.net/get.php?id=${UUID}&pack=${LANG_CODE}&edition=${EDITION}&autodl=2"
unzip -o -q pack.zip
chmod +x uup_download_macos.sh

# Soften aria2's fan-out before running it. The stock script uses -x16 -s16 across many
# hosts, which overwhelmed a resolver mid-download here: 42 x errorCode=19 ("Name
# resolution ... failed") and the run aborted twice with ~7 GB still to fetch. Fewer
# connections plus explicit resolvers and unlimited retries turns a DNS blip into a pause
# instead of a failure. Costs nothing on a healthy link; rescues a flaky one.
GENTLE='-x4 -s4 -j2 --async-dns-server=1.1.1.1,8.8.8.8,9.9.9.9 --max-tries=0 --retry-wait=5 --connect-timeout=30 --timeout=60'
sed -i '' "s/-x16 -s16 -j5/$GENTLE/; s/-x16 -s16 -j2/$GENTLE/" uup_download_macos.sh
grep -q 'async-dns-server' uup_download_macos.sh && info "aria2 settings softened for flaky links"

if [ "${SKIP_DOWNLOAD:-0}" = "1" ]; then
  info "skipping download/convert (existing ISO found)"
else
  info "Downloading (~10 GB) and converting. This is the slow part."
  # aria2 resumes, so re-running after an interruption picks up where it left off.
  ./uup_download_macos.sh
fi

ISO="$(ls -t "$OUT_DIR"/*.ISO "$OUT_DIR"/*.iso 2>/dev/null | grep -vi 'support\|fixed' | head -1 || true)"
[ -n "$ISO" ] || die "conversion finished but no ISO was produced (see the log in $OUT_DIR)"
info "converter produced: $ISO"

# ---------------------------------------------------------------------------
# The converter's ISO is NOT UEFI-bootable. Its arm64 branch runs
#     mkisofs -b efi/microsoft/boot/efisys.bin --no-emul-boot ...
# and `-b` registers a BIOS boot image (platform 0x00). A UEFI entry needs platform
# 0xEF, so firmware finds no bootable UEFI record, silently declines the disc, and drops
# to the EDK2 UEFI Shell -- which looks exactly like a hung VM. Confirm with:
#     xorriso -indev <iso> -report_el_torito plain     # want "Pltf: UEFI", not BIOS
#
# While rebuilding we also swap efisys.bin for efisys_noprompt.bin. The default image
# stops at "Press any key to boot from CD or DVD" and gives up if nobody presses one,
# which is fatal for an unattended install.
#
# NOTE: xorriso cannot do this job -- `xorriso -as mkisofs` rejects `-udf`, and UDF is
# required because install.wim exceeds 4 GB. cdrtools mkisofs supports both --udf and
# -eltorito-platform, so it is the builder here.
if xorriso -indev "$ISO" -report_el_torito plain 2>/dev/null | grep -q "UEFI"; then
  info "ISO already has a UEFI El Torito record; leaving it alone"
else
  info "Rebuilding the ISO with a UEFI El Torito record (the converter's is BIOS-only)"
  STAGE_DIR="$OUT_DIR/isodir"
  MNT="$OUT_DIR/mnt"
  # ditto preserves the ISO's read-only bits, so a previous staging tree cannot be
  # removed (or modified) without restoring write permission first -- otherwise a re-run
  # dies on "rm: ...: Permission denied" and leaves a half-deleted tree behind.
  [ -d "$STAGE_DIR" ] && chmod -R u+w "$STAGE_DIR" 2>/dev/null || true
  rm -rf "$STAGE_DIR" "$MNT"; mkdir -p "$STAGE_DIR" "$MNT"
  # Must copy via a macOS UDF mount: the converter passes `--hide "*"`, so every file
  # lives ONLY in the UDF tree and an ISO9660 reader (including xorriso) sees an empty
  # disc. boot.catalog is unreadable and is regenerated by mkisofs anyway.
  hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$ISO" >/dev/null
  ditto --norsrc --noextattr "$MNT" "$STAGE_DIR" 2>/dev/null || true
  hdiutil detach "$MNT" >/dev/null
  rmdir "$MNT" 2>/dev/null || true
  # Same reason: the staged copy is read-only, and we need to write autounattend.xml into
  # it and update boot.wim.
  chmod -R u+w "$STAGE_DIR"
  [ -f "$STAGE_DIR/sources/boot.wim" ] || die "extraction failed (no sources/boot.wim)"

  UNATTEND="$SCRIPT_DIR/autounattend.xml"

  # GUARD 1: language must match the media. The answer file's SetupUILanguage/UILanguage
  # must name a language pack that actually exists in sources/. Ask for en-GB on an EN-US
  # disc and Setup cannot load its UI language, silently abandons the whole answer file,
  # and shows the interactive language prompt -- indistinguishable from "file not found".
  # This one cost hours; it is two lines to check.
  MEDIA_LANG="$(ls "$STAGE_DIR/sources" | grep -oiE '^[a-z]{2}-[a-z]{2}$' | head -1)"
  [ -n "$MEDIA_LANG" ] || die "could not determine the media language from sources/"
  WANTED_LANGS="$(grep -oE '<(SetupUILanguage>)?[[:space:]]*<?UILanguage>[a-zA-Z-]+' "$UNATTEND" \
    | grep -oE '[a-z]{2}-[A-Z]{2}' | sort -u | tr '\n' ' ')"
  for l in $WANTED_LANGS; do
    if [ "$(echo "$l" | tr 'A-Z' 'a-z')" != "$(echo "$MEDIA_LANG" | tr 'A-Z' 'a-z')" ]; then
      die "autounattend.xml asks for UI language '$l' but the media only has '$MEDIA_LANG'. Setup will ignore the answer file. Fix the locales in $UNATTEND."
    fi
  done
  info "language check: unattend wants [$WANTED_LANGS], media has [$MEDIA_LANG]"

  # GUARD 2: the image name must match the WIM's NAME (not its DESCRIPTION). Getting this
  # wrong does not break the answer file -- Setup just stops on the edition picker.
  if command -v wimlib-imagex >/dev/null; then
    WIM_NAME="$(wimlib-imagex info "$STAGE_DIR/sources/install.wim" 2>/dev/null \
      | awk -F': *' '/^Name:/{print $2; exit}')"
    WANT_NAME="$(grep -A2 'IMAGE/NAME' "$UNATTEND" | grep -oE '<Value>[^<]+' | sed 's/<Value>//' | head -1)"
    if [ -n "$WIM_NAME" ] && [ -n "$WANT_NAME" ] && [ "$WIM_NAME" != "$WANT_NAME" ]; then
      die "autounattend.xml installs image '$WANT_NAME' but the WIM's Name is '$WIM_NAME' (its Description may differ). Fix /IMAGE/NAME in $UNATTEND."
    fi
    info "image check: unattend wants '$WANT_NAME', WIM Name is '$WIM_NAME'"
  fi

  # autounattend.xml belongs on the ROOT OF THE INSTALL MEDIA, which is where Setup
  # looks first. It is also on the support ISO; both is harmless and more robust.
  cp "$UNATTEND" "$STAGE_DIR/autounattend.xml"

  # Belt and braces: also inject it into boot.wim's Setup image at \Windows\Panther,
  # which Setup reads explicitly. Removable-media discovery is not guaranteed when the
  # disc is presented as USB mass storage rather than a real DVD, as it is here.
  if command -v wimlib-imagex >/dev/null; then
    chmod u+w "$STAGE_DIR/sources/boot.wim"
    printf 'delete --force /Windows/Panther/unattend.xml\nadd "%s" /Windows/Panther/unattend.xml\n' \
      "$UNATTEND" | wimlib-imagex update "$STAGE_DIR/sources/boot.wim" 2 >/dev/null 2>&1 \
      && info "injected unattend into boot.wim (index 2, Windows Setup)"
  fi

  FIXED="$OUT_DIR/windows-arm64-uefi.iso"
  LABEL="$(basename "$ISO" | sed 's/\.[Ii][Ss][Oo]$//' | cut -c1-32)"
  rm -f "$FIXED"
  mkisofs -eltorito-platform efi -b "efi/microsoft/boot/efisys_noprompt.bin" \
    --no-emul-boot --udf -iso-level 3 --hide "*" -V "$LABEL" -o "$FIXED" "$STAGE_DIR"
  xorriso -indev "$FIXED" -report_el_torito plain 2>/dev/null | grep -q "UEFI" \
    || die "rebuild still has no UEFI El Torito record"
  chmod -R u+w "$STAGE_DIR" 2>/dev/null || true
  rm -rf "$STAGE_DIR"
  ISO="$FIXED"
  info "rebuilt: $ISO"
fi

echo
echo "ISO ready: $ISO"
echo "Next:  ./packages/worker-fleet/src/local-worker/build-vm.sh \"$ISO\""
echo "       ./packages/worker-fleet/src/local-worker/create-utm-vm.sh \"$ISO\""
