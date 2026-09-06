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
#   A11Y_WORKERS      comma-separated worker URLs, e.g. http://192.0.2.10:8765
#   A11Y_CORPUS_URL   optional tar.gz of runs/ to seed the baseline corpus (69 MB at time of writing)
set -euo pipefail

REPO_URL="${A11Y_REPO_URL:-https://github.com/DanBeckDev/a11y-witness.git}"
REPO_PATH="${A11Y_REPO_PATH:-$HOME/a11y-witness}"

# WHICH HALF OF THE CONTROL PLANE IS THIS?  (A11Y_ROLE=control|lab, default both)
#
# ADR 0012 splits them, and the reason is credentials rather than tidiness: the SSH key that can
# reconfigure twelve Windows machines should not sit next to 100 MB of npm transitive dependencies and a
# Python venv, which are the largest supply-chain surface in the system.
#
#   control  ansible + the fleet key. No node_modules, no venv, no corpus. Rebuildable in a minute.
#   lab      npm install + venv + the corpus. Talks to workers over HTTP only. Holds NO key.
#
# `both` remains the default so a single-box setup still works and nobody is forced into two containers
# on day one -- but it is the thing to grow out of, not the target.
ROLE="${A11Y_ROLE:-both}"
case "$ROLE" in
  control|lab|both) ;;
  *) echo "A11Y_ROLE must be control, lab or both (got '$ROLE')" >&2; exit 1 ;;
esac
is_control() { [ "$ROLE" = control ] || [ "$ROLE" = both ]; }
is_lab()     { [ "$ROLE" = lab ]     || [ "$ROLE" = both ]; }

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
# A SEPARATE variable for the environment-preserving form, not `$SUDO -E`. When SUDO is empty --
# which is the normal case, because an LXC console is root -- `$SUDO -E cmd` leaves `-E` as the
# command word, and the shell reports `-E: command not found`. That killed this script at the
# NodeSource step on both containers: `set -euo pipefail` aborted correctly, so it failed loudly
# rather than half-installing, but the cause reads as a missing binary rather than a quoting bug.
SUDO_E=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { echo "Not root and no sudo. Run as root." >&2; exit 1; }
  SUDO="sudo"
  SUDO_E="sudo -E"
fi
if [ -n "$SUDO" ]; then ok 'using sudo'; else ok 'running as root'; fi
ok "role: $ROLE"


step 2 'Node.js and git'
if command -v node >/dev/null && node -e 'process.exit(process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  ok "node already present ($(node --version))"
else
  # NodeSource rather than the distro package: Debian ships a node far older than this repo needs,
  # and a version skew here surfaces as syntax errors in the orchestrator rather than as a version
  # complaint.
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_lts.x | $SUDO_E bash - >/dev/null
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
if is_lab; then
  npm install --silent --no-audit --no-fund
  ok 'dependencies installed'

  # The LOCAL scorer is the default judge and the only one that ships (JUDGE_BACKEND defaults to
  # `local`), so a lab without Python is a lab that cannot score. This step was missing entirely, and
  # nothing here failed: `witness`, `eval` and `training:score` all name `.venv/bin/python` explicitly,
  # so the absence surfaces as a missing interpreter partway through a run rather than at setup.
  $SUDO apt-get install -y -qq python3-venv >/dev/null
  [ -d "$REPO_PATH/.venv" ] || python3 -m venv "$REPO_PATH/.venv"
  "$REPO_PATH/.venv/bin/pip" install -q --upgrade pip
  "$REPO_PATH/.venv/bin/pip" install -q -r "$REPO_PATH/packages/scorer/requirements.txt"
  ok "python venv ready ($("$REPO_PATH/.venv/bin/python" --version 2>&1))"

  # The trained heads ARE tracked (796 KB); the MiniLM encoder is 87 MB and deliberately is not. It is a
  # public model pinned by BOTH revision and sha256 in fetch-encoder.py, so fetching rather than
  # vendoring it is still reproducible -- which is why .gitignore excludes `models/encoders/`.
  if [ -f "$REPO_PATH/packages/scorer/models/encoders/all-MiniLM-L6-v2/model.safetensors" ]; then
    ok 'encoder already present'
  else
    (cd "$REPO_PATH" && .venv/bin/python packages/scorer/python/fetch-encoder.py >/dev/null 2>&1) \
      && ok 'encoder fetched (pinned revision, sha256-verified)' \
      || warn 'could not fetch the encoder -- the local judge cannot score until it is present'
  fi
else
  # The control container deliberately has NO node_modules. deploy.yml computes codeVersion by importing
  # code-version.mjs BY PATH -- it needs nothing but node stdlib, and verified identical to the workspace
  # import. 100 MB of transitive dependencies next to the fleet's SSH key is the coupling ADR 0012 removes.
  ok 'skipped (control role) -- no node_modules beside the fleet key'
fi

step 4 'Ansible, and the fleet key'
if ! is_control; then
  ok 'skipped (lab role) -- the lab holds NO fleet key and runs no Ansible, by design (ADR 0012)'
else
# The control plane MANAGES the workers as well as capturing with them, and this script predates that
# half entirely -- it installed node and a checkout and left you without the thing that provisions,
# deploys, wakes and sleeps a box.
#
# pipx rather than apt: Windows-over-SSH support is ansible-core 2.18+, and Debian ships older. That
# version gap is not cosmetic -- on an older core every Windows task fails at connection time.
#
# The REQUIREMENT is enforced here rather than documented here. It used to be neither: this block installed
# `ansible-core` with no version constraint, and the "already present" branch accepted whatever was on the
# box -- so the one case the comment above warns about, an older core, passed the check silently and failed
# later at connection time, which reads like a broken worker rather than a stale controller.
#
# `collections/ansible_collections/a11y/worker/meta/runtime.yml` states the same floor as
# `requires_ansible`, so Ansible itself refuses the collection on an older core. This makes the bootstrap
# agree with it instead of leaving the two to drift.
ANSIBLE_MIN="2.18"

ansible_core_version() { ansible --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1; }
# Sort-based compare, so 2.9 does not read as newer than 2.18 the way a string compare would. That is the
# specific wrong answer this guard has to avoid, because 2.9 is exactly what Debian ships.
version_at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

if command -v ansible-playbook >/dev/null; then
  found="$(ansible_core_version)"
  if [ -n "$found" ] && version_at_least "$found" "$ANSIBLE_MIN"; then
    ok "ansible already present (core $found, >= $ANSIBLE_MIN)"
  else
    warn "ansible core ${found:-unknown} is older than $ANSIBLE_MIN — every Windows task will fail at"
    warn "connection time, which looks like a broken worker rather than a stale controller. Upgrade with:"
    warn "  pipx upgrade ansible-core   ||   pipx install --force 'ansible-core>=$ANSIBLE_MIN'"
  fi
else
  $SUDO apt-get install -y -qq pipx >/dev/null 2>&1 || $SUDO apt-get install -y -qq python3-pip >/dev/null
  if command -v pipx >/dev/null; then
    pipx install "ansible-core>=$ANSIBLE_MIN" >/dev/null
    pipx ensurepath >/dev/null 2>&1 || true
  else
    $SUDO pip3 install --break-system-packages -q "ansible-core>=$ANSIBLE_MIN"
  fi
  export PATH="$HOME/.local/bin:$PATH"
  ok "ansible installed ($(ansible --version 2>/dev/null | head -1))"
fi

# -p is load-bearing: ansible.cfg puts the repo's own collections path FIRST, so a bare install vendors
# third-party collections into the git tree. Only a11y.worker belongs there.
export PATH="$HOME/.local/bin:$PATH"
if [ -f "$REPO_PATH/packages/control/ansible/requirements.yml" ]; then
  ansible-galaxy collection install -r "$REPO_PATH/packages/control/ansible/requirements.yml" \
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
fi

step 5 'Baseline corpus'
if ! is_lab; then
  ok 'skipped (control role) -- the corpus belongs to the lab'
else
# The corpus is a GIT REPO of its own -- private, because these are our internal test pages and the
# main repo is public, so committing them there would publish the benchmark the tool is validated
# against. It is versioned rather than regenerated because a capture is NOT reproducible: browserVersion
# is in the capture cache key precisely so that evidence taken under one Edge release is not confused
# with another's, and recapturing after an update gives a DIFFERENT corpus rather than the same one.
#
# Without it the lab can capture but cannot COMPARE, and evidence:check refuses rather than silently
# reporting that nothing changed.
#
# A11Y_CORPUS_URL accepts either a git remote (preferred -- versioned, and every clone is a verified
# copy) or a tar.gz URL, because a box without access to the private repo should still be able to be
# handed a bundle.
# A DEPLOY KEY for the corpus, separate from the fleet key on purpose. Two different things are being
# authorised -- reading one private repo, and reconfiguring twelve Windows machines -- and one key for
# both means revoking either revokes the other. GitHub also refuses the same deploy key on two repos.
#
# A Host alias rather than a bare IdentityFile, so this key is used for THIS clone and nothing else. On a
# box with any other GitHub credential, ssh would otherwise offer keys in whatever order it likes and the
# failure ("Permission denied (publickey)") says nothing about which one it tried.
CORPUS_KEY="$HOME/.ssh/a11y-corpus_ed25519"
if is_lab && [ ! -f "$CORPUS_KEY" ]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  ssh-keygen -t ed25519 -N '' -C 'a11y-corpus deploy key (read-only)' -f "$CORPUS_KEY" >/dev/null
  if ! grep -q 'Host a11y-corpus.github.com' "$HOME/.ssh/config" 2>/dev/null; then
    printf 'Host a11y-corpus.github.com\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' \
      "$CORPUS_KEY" >> "$HOME/.ssh/config"
    chmod 600 "$HOME/.ssh/config"
  fi
  echo
  echo "    The corpus repo is PRIVATE. Add this as a READ-ONLY deploy key at"
  echo "    https://github.com/DanBeckDev/a11y-corpus/settings/keys  (do NOT tick write access):"
  echo
  echo "      $(cat "$CORPUS_KEY.pub")"
  echo
  echo "    Then re-run this script; the clone below will pick it up."
  echo
fi

# Seed GitHub's host key, VERIFIED rather than trusted on first use. A fresh container has no
# known_hosts at all, so the clone below fails with "Host key verification failed" -- and the warning it
# prints blames the deploy key, which is the wrong diagnosis and cost real time chasing a key that was
# already correctly installed. `ssh-keyscan >> known_hosts` on its own is trust-on-first-use over the
# network, so the scanned key is compared against GitHub's published ed25519 fingerprint and REFUSED on
# a mismatch. Verified against two independent channels (a keyscan from a known-good host and
# api.github.com/meta over HTTPS), which agree.
GITHUB_ED25519_FP='SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'
if is_lab && ! ssh-keygen -F github.com >/dev/null 2>&1; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  SCANNED="$(ssh-keyscan -t ed25519 github.com 2>/dev/null)"
  SCANNED_FP="$(printf '%s\n' "$SCANNED" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')"
  if [ -n "$SCANNED" ] && [ "$SCANNED_FP" = "$GITHUB_ED25519_FP" ]; then
    printf '%s\n' "$SCANNED" >> "$HOME/.ssh/known_hosts"
    ok 'github.com host key seeded (fingerprint verified against the published key)'
  else
    warn "github.com host key did not match the published fingerprint (got ${SCANNED_FP:-nothing}) --"
    warn 'NOT recorded. The corpus clone will fail; investigate before working around this.'
  fi
fi

CORPUS_DIR="$REPO_PATH/runs/screenreader-dataset"
CORPUS_URL="${A11Y_CORPUS_URL:-git@a11y-corpus.github.com:DanBeckDev/a11y-corpus.git}"
if [ -d "$CORPUS_DIR/captures" ]; then
  ok "corpus present ($(find "$CORPUS_DIR/captures" -name '*.json' | wc -l | tr -d ' ') captures)"
  # A checkout can be updated; an unpacked tarball cannot, and saying which is which beats guessing.
  if [ -d "$CORPUS_DIR/.git" ]; then
    git -C "$CORPUS_DIR" pull --ff-only --quiet 2>/dev/null && ok 'corpus updated from its remote' \
      || warn 'corpus is a checkout but could not be updated -- check the remote and your key'
  fi
elif printf '%s' "$CORPUS_URL" | grep -qE '\.git$|^git@|^ssh://'; then
  mkdir -p "$REPO_PATH/runs"
  # Keep git's OWN error. `2>/dev/null` here replaced "Host key verification failed" with a guess about
  # the deploy key, and the guess was wrong -- the key was installed and correct, and the container
  # simply had no known_hosts. A diagnostic that states a cause it did not observe is worse than none,
  # because it is believed.
  if CLONE_ERR="$(git clone --quiet "$CORPUS_URL" "$CORPUS_DIR" 2>&1)"; then
    ok "corpus cloned ($(find "$CORPUS_DIR/captures" -name '*.json' | wc -l | tr -d ' ') captures)"
  else
    warn "could not clone $CORPUS_URL"
    warn "git said: ${CLONE_ERR:-(no output)}"
    warn 'The repo is PRIVATE, so this box needs a deploy key with access -- but read the line above'
    warn 'before assuming that is the cause.'
    warn 'Capture will work; evidence:check has nothing to diff against until it is present.'
  fi
else
  mkdir -p "$REPO_PATH/runs"
  curl -fsSL "$CORPUS_URL" | tar -xz -C "$REPO_PATH/runs" \
    && ok 'corpus fetched from a tarball' \
    || warn "could not fetch $CORPUS_URL"
fi
fi

step 6 'Workers'
if [ -z "${A11Y_WORKERS:-}" ]; then
  warn 'A11Y_WORKERS is not set. Without it the orchestrator looks for LOCAL VMs, which do not'
  warn 'exist here — that path is macOS/UTM only. Set it to your bare-metal workers:'
  warn '  export A11Y_WORKERS=http://192.0.2.10:8765'
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
    \$EDITOR packages/control/ansible/inventory.yml     # ansible_host + mac per box
    eval "\$(npm run --silent fleet:env)"   # A11Y_WORKERS, derived from that inventory

  Build one:
    packages/worker-fleet/src/provisioning/bare-metal/serve-bootstrap.sh ~/.ssh/a11y-witness_ed25519.pub

  Manage them (from packages/control/ansible):
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
