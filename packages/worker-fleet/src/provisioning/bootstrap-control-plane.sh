#!/usr/bin/env bash
# Stand up the CONTROL PLANE on Linux, so no run depends on a particular laptop.
#
#   curl -fsSL <raw-url>/bootstrap-control-plane.sh | bash
#
# The pair to bootstrap-windows-worker.ps1: that one turns a Windows box into a capture worker,
# this one turns a Debian/Ubuntu box (an LXC on Proxmox, say) into the thing that drives them.
#
# ## Why this exists
#
# ADR 0001 says it already: "The control plane is portable; only capture workers are OS-bound."
# Portable meant *could*, not *does* — it ran on one Mac, and that Mac was in the path of every
# corpus run. Three separate ways that bit, all in one day:
#
#   - macOS 26 blocks node from the local network by default, so every worker call failed with
#     EHOSTUNREACH while curl and python worked fine. A privacy toggle stopped the fleet.
#   - the dataset page server ran there, so the pages a capture reads lived on a laptop.
#   - a four-hour corpus run needed that laptop awake, on the same network, unslept.
#
# ## What it does NOT need
#
# No utmctl, no VM management, none of the macOS-bound half of worker-fleet. Verified rather than
# hoped: `leaseWorker` returns at its first line when a worker is named explicitly, and
# `capture-screenreader-dataset.mjs` returns the explicit pool before `leaseWorkerPool` is called.
# So with A11Y_WORKERS set, the managed-VM path is never entered and nothing macOS-only runs.
#
# That is why this is a deployment rather than a port: `packages/lab` — the orchestrator — contains
# no macOS-only command at all.
#
#   A11Y_REPO_URL     default the public GitHub repo
#   A11Y_REPO_PATH    default ~/a11y-witness
#   A11Y_WORKERS      comma-separated worker URLs, e.g. http://REDACTED-INTERNAL-ADDRESS:8765
#   A11Y_CORPUS_URL   optional tar.gz of runs/ to seed the baseline corpus (69 MB at time of writing)
set -euo pipefail

REPO_URL="${A11Y_REPO_URL:-https://github.com/DanBeckDev/a11y-witness.git}"
REPO_PATH="${A11Y_REPO_PATH:-$HOME/a11y-witness}"

step() { printf '\n\033[36m[%s] %s\033[0m\n' "$1" "$2"; }
ok()   { printf '    \033[32mOK    %s\033[0m\n' "$1"; }
warn() { printf '    \033[33mWARN  %s\033[0m\n' "$1"; }

step 1 'Preconditions'
[ "$(uname -s)" = "Linux" ] || { echo "This is the Linux control plane; run it on the host that will drive the workers." >&2; exit 1; }
# shellcheck disable=SC1091  # /etc/os-release is a runtime file, not an input to lint
if . /etc/os-release 2>/dev/null && [ -n "${PRETTY_NAME:-}" ]; then ok "$PRETTY_NAME"; else ok "$(uname -sr)"; fi

# Root or sudo, but do not assume either: an LXC console is usually already root, and demanding
# sudo there fails on a box that does not have it installed.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { echo "Not root and no sudo. Run as root." >&2; exit 1; }
  SUDO="sudo"
fi
if [ -n "$SUDO" ]; then ok 'using sudo'; else ok 'running as root'; fi

step 2 'Node.js and git'
if command -v node >/dev/null && node -e 'process.exit(process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  ok "node already present ($(node --version))"
else
  # NodeSource rather than the distro package: Debian ships a node far older than this repo needs,
  # and a version skew here surfaces as syntax errors in the orchestrator rather than as a version
  # complaint.
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_lts.x | $SUDO -E bash - >/dev/null
  $SUDO apt-get install -y -qq nodejs >/dev/null
  ok "node installed ($(node --version))"
fi
command -v git >/dev/null || { $SUDO apt-get install -y -qq git >/dev/null; }
ok "git $(git --version | awk '{print $3}')"

step 3 'Repository'
if [ -d "$REPO_PATH/.git" ]; then
  git -C "$REPO_PATH" pull --ff-only
  ok "pulled $REPO_PATH ($(git -C "$REPO_PATH" rev-parse --short HEAD))"
else
  git clone --quiet "$REPO_URL" "$REPO_PATH"
  ok "cloned to $REPO_PATH ($(git -C "$REPO_PATH" rev-parse --short HEAD))"
fi
cd "$REPO_PATH"
npm install --silent --no-audit --no-fund
ok 'dependencies installed'

step 4 'Ansible, and the fleet key'
# The control plane MANAGES the workers as well as capturing with them, and this script predates that
# half entirely -- it installed node and a checkout and left you without the thing that provisions,
# deploys, wakes and sleeps a box.
#
# pipx rather than apt: Windows-over-SSH support is ansible-core 2.18+, and Debian ships older. That
# version gap is not cosmetic -- on an older core every Windows task fails at connection time.
if command -v ansible-playbook >/dev/null; then
  ok "ansible already present ($(ansible --version | head -1))"
else
  $SUDO apt-get install -y -qq pipx >/dev/null 2>&1 || $SUDO apt-get install -y -qq python3-pip >/dev/null
  if command -v pipx >/dev/null; then
    pipx install ansible-core >/dev/null
    pipx ensurepath >/dev/null 2>&1 || true
  else
    $SUDO pip3 install --break-system-packages -q ansible-core
  fi
  export PATH="$HOME/.local/bin:$PATH"
  ok "ansible installed ($(ansible --version 2>/dev/null | head -1))"
fi

# -p is load-bearing: ansible.cfg puts the repo's own collections path FIRST, so a bare install vendors
# third-party collections into the git tree. Only a11y.worker belongs there.
export PATH="$HOME/.local/bin:$PATH"
if [ -f "$REPO_PATH/packages/worker-fleet/ansible/requirements.yml" ]; then
  ansible-galaxy collection install -r "$REPO_PATH/packages/worker-fleet/ansible/requirements.yml" \
    -p "$HOME/.ansible/collections" >/dev/null
  ok 'collections installed (ansible.windows, community.windows, community.general)'
else
  warn 'requirements.yml not found -- is the checkout complete?'
fi

# The fleet's SSH key lives HERE, not on somebody's laptop. That is the whole point of moving the
# control plane: a key on a Mac makes that Mac load-bearing again by a different route.
#
# Generated rather than copied, so this box is self-contained. The PUBLIC half is printed, because it
# has to reach the workers -- serve-bootstrap.sh hands it to a PXE install, and ssh-key.yml installs it
# on a box that is already up.
FLEET_KEY="$HOME/.ssh/a11y-witness_ed25519"
if [ -f "$FLEET_KEY" ]; then
  ok "fleet key present ($(ssh-keygen -lf "$FLEET_KEY.pub" 2>/dev/null | awk '{print $2}'))"
else
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  ssh-keygen -t ed25519 -N '' -C 'a11y-witness-capture-worker' -f "$FLEET_KEY" >/dev/null
  ok "fleet key generated at $FLEET_KEY"
fi
echo
echo "    The workers must trust this public key. Stage it into a PXE install with"
echo "    serve-bootstrap.sh, or install it on a running box with ssh-key.yml:"
echo
echo "      $(cat "$FLEET_KEY.pub")"
echo

step 5 'Baseline corpus'
# runs/ is gitignored — 2,122 captures worth hours of worker time, and the thing evidence:check
# diffs against. Without it the control plane can capture but cannot COMPARE, and evidence:check
# refuses rather than silently reporting that nothing changed.
if [ -d "$REPO_PATH/runs/screenreader-dataset/captures" ]; then
  ok "corpus present ($(find "$REPO_PATH/runs/screenreader-dataset/captures" -name '*.json' | wc -l | tr -d ' ') captures)"
elif [ -n "${A11Y_CORPUS_URL:-}" ]; then
  mkdir -p "$REPO_PATH/runs"
  curl -fsSL "$A11Y_CORPUS_URL" | tar -xz -C "$REPO_PATH/runs"
  ok "corpus fetched from A11Y_CORPUS_URL"
else
  warn 'no corpus. Capture works; evidence:check has nothing to diff against.'
  warn "Copy it once:  rsync -az <mac>:<repo>/runs/ $REPO_PATH/runs/"
fi

step 6 'Workers'
if [ -z "${A11Y_WORKERS:-}" ]; then
  warn 'A11Y_WORKERS is not set. Without it the orchestrator looks for LOCAL VMs, which do not'
  warn 'exist here — that path is macOS/UTM only. Set it to your bare-metal workers:'
  warn '  export A11Y_WORKERS=http://REDACTED-INTERNAL-ADDRESS:8765'
else
  # Reachability is checked, not assumed: this whole exercise began with an orchestrator that
  # could not reach its workers and reported it as something else entirely.
  reachable=0
  IFS=',' read -ra WS <<< "$A11Y_WORKERS"
  for w in "${WS[@]}"; do
    if curl -fsS --max-time 10 "${w%/}/health" >/dev/null 2>&1; then
      ok "worker reachable: $w"; reachable=$((reachable + 1))
    else
      warn "worker NOT reachable: $w"
    fi
  done
  [ "$reachable" -gt 0 ] || warn 'no worker answered /health — a run would fail immediately'
fi

step 7 'This host as the workers see it'
# The page server must be addressed by LAN IP, never localhost: a worker cannot reach our
# loopback, and a capture that fetches the wrong URL reads an error page and records it as
# evidence rather than failing.
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
if [ -n "$LAN_IP" ]; then
  ok "workers should reach this host at $LAN_IP"
else
  warn 'could not determine this host LAN address; set DATASET_BASE_URL explicitly'
fi

cat <<EOF

--- Control plane ready ---

  Find and adopt workers:
    npm run fleet:discover                 # scan, and reconcile against inventory.yml
    \$EDITOR packages/worker-fleet/ansible/inventory.yml     # ansible_host + mac per box
    eval "\$(npm run --silent fleet:env)"   # A11Y_WORKERS, derived from that inventory

  Build one:
    packages/worker-fleet/src/provisioning/bare-metal/serve-bootstrap.sh ~/.ssh/a11y-witness_ed25519.pub

  Manage them (from packages/worker-fleet/ansible):
    ansible-playbook provision-role.yml -l <host> --check --diff
    ansible-playbook deploy.yml
    ansible-playbook wake.yml / sleep.yml

  Capture:
    npm run doctor
    npm run fleet:status
    npm run training:capture

Nothing here depends on a Mac. Re-run this script any time; every step skips itself
when it is already done, and the corpus and repo are updated in place.

NOTE: this box must be on the SAME LAYER-2 SEGMENT as the workers. Wake-on-LAN magic
packets are broadcast and do not route, so a NAT'd or separately-VLAN'd control plane
can provision a worker over SSH and then be unable to wake it. On Proxmox that means a
bridged veth on vmbr0, not the default NAT.
EOF
