#!/usr/bin/env bash
# Start, pause, stop and check the local NVDA worker VM, so it is not burning resources
# while you are not capturing.
#
#   npm run worker:ctl -- up                           # make it ready (start or resume), wait for /health
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh pause         # freeze it: ~0.6% CPU, instant resume, RAM not guaranteed
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh stop          # shut it down: nothing held, ~15 s to come back
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh status        # state, resource use, health
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh json          # the same, machine-readable (used by the CLI)
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh pool          # every a11y-worker* VM, as JSON
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh pool-up       # start them all, wait for health
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh pool-stop     # shut the whole pool down
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh pool-pause    # freeze the whole pool
#
# One VM serves one capture at a time, so throughput comes from more VMs. `pool` reports the
# lot; add one with clone-worker.sh (which handles the duplicate-MAC trap).
# Operate on a single named VM with A11Y_VM_NAME=a11y-worker-2.
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh idle-pause 15 # watch, then pause after 15 idle minutes
#   ./packages/worker-fleet/src/local-worker/worker-ctl.sh idle-stop 30  # same but shut down instead
#
# Measured on an M4 Max, 4 vCPU / 8 GB guest. Every number here was observed on this
# machine; none is an estimate:
#
#   | state        | host CPU          | host RSS              | back to /health |
#   |--------------|-------------------|-----------------------|-----------------|
#   | running idle | 2-86%, spiky      | ~5 GB                 | -               |
#   | paused       | ~0.6%             | 0.8 GB *or* 4.5 GB    | under 1 s       |
#   | stopped      | none (no process) | none                  | 12-15 s, once 81 s |
#
# Read the caveats before trusting the table:
#   - "running idle" is not idle. Windows keeps working in the background (Defender,
#     Update, the search indexer), so a single sample means nothing: consecutive readings
#     20 s apart gave 1.8%, 25% and 86%. That is why `pause` is worth having at all.
#   - `pause` reliably buys back CPU. It does NOT reliably give back memory. One paused run
#     settled to ~0.8 GB within 40 s; the next held ~4.5 GB for three minutes straight with
#     66% of host memory free. Whether the host reclaims a suspended guest's pages is not
#     ours to decide, so do not count on it.
#
# So: `pause` for a short gap between captures -- near-zero CPU and the guest never
# rebooted, so resume is instant. `stop` when you actually want the memory back, because it
# is the only one that guarantees it, and it is cheap: cold start reached /health in 12 s,
# 12 s and 15 s across three runs (`up` returns a few seconds later once it has the IP), and
# a capture immediately after a cold start was verified working, disclosure state change
# included. Do not read 12-15 s as a guarantee, though: a later run took 81 s, on a busier
# host with Windows doing its own post-boot work. `up` waits for /health rather than a fixed
# delay for exactly that reason. It comes back unattended because auto-logon plus the
# at-logon trigger restart the worker -- see docs/local-worker-vm.md.
set -euo pipefail

VM_NAME="${A11Y_VM_NAME:-a11y-worker}"
PORT="${A11Y_PORT:-8765}"

# Accept `--vm=<name>` as well as A11Y_VM_NAME, and accept it in ANY position.
#
# `worker:deploy` has always taken `--vm=`, so anyone who has used that reaches for it here too — and this
# script silently ignored it, then reported a DIFFERENT VM's state under the name you asked for. Silently,
# because a stray argument was simply never read. Two tools in one fleet disagreeing about how to name a
# machine is the kind of paper cut that gets diagnosed as "the guest is broken".
#
# Stripped from the positional arguments before CMD/ARG are taken, so `up --vm=x` and `--vm=x up` both work.
ARGS=()
for a in "$@"; do
  case "$a" in
    --vm=*) VM_NAME="${a#--vm=}" ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

CMD="${1:-status}"
SHUTDOWN_GRACE_S=120   # how long to let Windows shut down cleanly before forcing
RECLAIM_SETTLE_S=45    # give the host a chance to reclaim pages before reporting usage
HEALTH_TIMEOUT_S=5     # per probe
HEALTH_TRIES=3         # before calling a worker unreachable
HEALTH_GAP_S=2         # between probes
ARG="${2:-}"

die() { echo "error: $*" >&2; exit 1; }
command -v utmctl >/dev/null || die "utmctl not found (brew install --cask utm)"

# utmctl is a client for the UTM APP, not a standalone daemon. With UTM not running it cannot
# answer, and the symptoms are misleading: a VM reports its state as `unknown` (or the command
# fails outright) even though the bundle is present and intact. Seen for real -- quitting UTM
# to edit its preferences made every utmctl call useless until the app was relaunched.
#
# So launch it and wait, rather than reporting a healthy VM as unknown.
ensure_utm_running() {
  pgrep -x UTM >/dev/null && return
  echo "UTM is not running (utmctl needs the app); launching it ..."
  open -a UTM || die "could not launch UTM"
  for _ in $(seq 1 15); do
    sleep 2
    utmctl list >/dev/null 2>&1 && { echo "  UTM is up"; return; }
  done
  die "UTM did not become responsive. Open it once by hand and check it starts cleanly."
}
ensure_utm_running

# Resolve by UUID, never by name. Two registrations can share a name, and then `utmctl
# start <name>` silently picks the wrong one -- worse, `utmctl delete <name>` removes the
# shared bundle and takes the other VM's disk with it.
resolve_uuid() {
  [ -n "${A11Y_VM_UUID:-}" ] && { echo "$A11Y_VM_UUID"; return; }
  local matches
  matches="$(utmctl list | awk -v n="$VM_NAME" '$3 == n { print $1 }')"
  [ -n "$matches" ] || die "no VM named '$VM_NAME' (create one: packages/worker-fleet/src/local-worker/create-utm-vm.sh)"
  if [ "$(echo "$matches" | wc -l | tr -d ' ')" -gt 1 ]; then
    # Do NOT guess, and do NOT suggest deleting one. Duplicate registrations under the same
    # name point at the SAME <name>.utm bundle, so `utmctl delete` on either removes that
    # directory and destroys the other VM's disk and UEFI vars. That has already happened
    # here once; the aftermath is a start that fails with
    # 'The file "edk2-arm-vars.fd" doesn't exist'.
    die "several VMs are registered as '$VM_NAME':
$matches
Pick one explicitly:  A11Y_VM_UUID=<uuid> $0 $CMD

WARNING: do not 'utmctl delete' either of them. They share one bundle directory, so
deleting either destroys the other's disk. Resolve it by renaming one VM in the UTM UI
(which moves its bundle) before deleting anything."
  fi
  echo "$matches"
}

vm_state() { utmctl status "$1" 2>/dev/null || echo unknown; }

# `unknown` means utmctl could not answer, not that the VM is broken. Almost always UTM was
# not running (handled above) or the UUID is stale -- so say which, instead of leaving a
# caller to conclude the guest is dead.
explain_unknown() {
  echo "  state 'unknown' means utmctl could not answer for this VM, NOT that the guest is broken." >&2
  echo "  UTM app running: $(pgrep -x UTM >/dev/null && echo yes || echo NO)" >&2
  echo "  guest process:   $(pgrep -f QEMULauncher >/dev/null && echo running || echo none)" >&2
  echo "  registered VMs:" >&2; utmctl list 2>&1 | sed 's/^/    /' >&2
}

guest_ip() {
  utmctl ip-address "$1" 2>/dev/null \
    | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | grep -v '^127' | head -1
}

# One probe. Needs the guest agent to report an IP first, which only happens once the guest
# tools are installed.
health_once() {
  local ip; ip="$(guest_ip "$1")"
  [ -n "$ip" ] || return 1
  curl -s -m "$HEALTH_TIMEOUT_S" "http://$ip:$PORT/health" 2>/dev/null
}

# A verdict, not a probe: retry before declaring a worker unreachable.
#
# One timed-out curl is not evidence of a dead worker, and treating it as such is how a
# healthy VM gets diagnosed as broken. The guest is busiest exactly when you most want to know
# it is alive -- Edge launching, and NVDA cold-starting every 25 captures -- and a worker
# restart takes /health down for 5-10s entirely legitimately.
#
# Measured during a live capture: 30/30 direct probes succeeded, none over a second, so this
# is not papering over a known flake. It is refusing to report a one-off as a fact.
health() {
  local body
  for attempt in $(seq 1 "$HEALTH_TRIES"); do
    body="$(health_once "$1")" && [ -n "$body" ] && { echo "$body"; return 0; }
    [ "$attempt" -lt "$HEALTH_TRIES" ] && sleep "$HEALTH_GAP_S"
  done
  return 1
}

# Waits for READY, not merely for an answer.
#
# This used to return the moment /health responded, which is precisely when the first capture
# failed: the port answers well before NVDA can start, so `up` reported success and the run
# immediately lost its first case to `nvda.start failed: Timed out waiting for NVDA to be
# running`. The worker now warms NVDA at boot and reports `ready:false` until it is answering,
# so waiting for that makes `up` mean what it says.
#
# A worker predating the field returns no `ready`, and is accepted as before.
wait_healthy() {
  local uuid="$1" limit="${2:-180}" waited=0 body
  while [ "$waited" -lt "$limit" ]; do
    body="$(health_once "$uuid" || true)"
    if [ -n "$body" ]; then
      if ! echo "$body" | grep -q '"ready":false'; then
        echo "  ready after ${waited}s: $body"
        return 0
      fi
      # Answering but still warming up. Say so, because silence here looks like a hang.
      [ $((waited % 15)) -eq 0 ] && echo "  answering, NVDA still warming up (${waited}s)"
    fi
    sleep 3; waited=$((waited + 3))
  done
  echo "  NOT ready after ${limit}s" >&2
  return 1
}

# This VM's own process, matched on its UUID in the qemu command line. Reporting whichever
# qemu process came first described a different worker as soon as there was a pool.
qemu_usage() {
  local pid; pid="$(pgrep -f "uuid $UUID" | head -1 || true)"
  if [ -z "$pid" ]; then echo "not running (RAM released)"; return; fi
  ps -o pcpu=,rss= -p "$pid" | awk '{printf "cpu=%s%% rss=%.1fGB", $1, $2/1048576}'
}

UUID="$(resolve_uuid)"

case "$CMD" in
  up)
    state="$(vm_state "$UUID")"
    case "$state" in
      started) echo "already started";;
      paused)  echo "resuming from pause"; utmctl start "$UUID" >/dev/null;;
      *)       echo "cold starting (boot + auto-logon + worker task; waiting for /health)"; utmctl start "$UUID" >/dev/null;;
    esac
    if ! wait_healthy "$UUID"; then
      [ "$state" = started ] && echo "  it was already 'started', so it is either mid-shutdown or the worker task died: try '$0 stop && $0 up'" >&2
      exit 1
    fi
    ip="$(guest_ip "$UUID")"
    echo
    echo "  A11Y_WORKER=http://$ip:$PORT"
    ;;

  pause)
    [ "$(vm_state "$UUID")" = "started" ] || { echo "not running (state: $(vm_state "$UUID"))"; exit 0; }
    utmctl suspend "$UUID" >/dev/null
    # Give the host a chance to reclaim the suspended guest's pages before reporting, but
    # do not promise it will: observed both ~0.8 GB and ~4.5 GB while paused. Say which one
    # happened, so a still-large footprint is visible rather than assumed away.
    sleep "$RECLAIM_SETTLE_S"
    echo "paused ($(qemu_usage)) -- resume with: $0 up (under a second; the guest never rebooted)"
    echo "note: CPU is back either way; memory may or may not be. Use '$0 stop' to be sure of it."
    ;;

  stop)
    state="$(vm_state "$UUID")"
    [ "$state" = "stopped" ] && { echo "already stopped"; exit 0; }
    # A paused VM cannot be shut down gracefully -- resume it first so Windows can flush
    # and exit cleanly, rather than yanking the power from a frozen guest.
    if [ "$state" = "paused" ]; then
      echo "resuming briefly so the guest can shut down cleanly"
      utmctl start "$UUID" >/dev/null; sleep 5
    fi
    # Ask Windows directly through the guest agent, rather than relying on ACPI.
    #
    # `utmctl stop --request` sends an ACPI power-button event, and this guest ignores it: every
    # stop sat out the full 120s grace and then force-stopped, so every "clean" shutdown was
    # actually a power cut. Setting AutoEndTasks and the kill timeouts did not help, which
    # points at the guest's power-button action rather than at apps refusing to close.
    #
    # `shutdown /s /t 0` over the guest agent needs no network and no ACPI, and Windows flushes
    # properly. ACPI stays as the fallback, and force as the last resort.
    if utmctl exec "$UUID" --cmd shutdown.exe /s /t 0 >/dev/null 2>&1; then
      echo "  asked Windows to shut down (guest agent)"
    else
      echo "  guest agent unavailable; falling back to ACPI"
      utmctl stop "$UUID" --request >/dev/null 2>&1 || true
    fi
    # Wait on THIS VM's state, not on the absence of qemu processes.
    #
    # The old loop broke only when no QEMULauncher process existed anywhere, which is true with
    # one VM and false with a pool: the other workers' processes kept it spinning for the full
    # grace period, so every stop reported "guest ignored ACPI shutdown" and force-stopped a VM
    # that had already shut down cleanly -- the giveaway being the force-stop then failing with
    # "The virtual machine is not running". Two and a half minutes per stop, and every "clean"
    # shutdown recorded as a power cut, all from a check that could not tell our VM from anyone
    # else's.
    # Poll THIS VM's own qemu process, by UUID. Two wrong turns got here:
    #
    #   `pgrep -f QEMULauncher`  breaks only when NO vm is running anywhere, so with a pool the
    #                            other workers kept it spinning the full grace period and every
    #                            clean shutdown was recorded as ignored, then force-stopped.
    #   `utmctl status`          per-VM and correct, but slow enough that forty iterations took
    #                            464s of wall clock while `waited` only counted the sleeps.
    #
    # pgrep on the UUID is both: specific to this VM, and cheap enough to poll.
    waited=0
    while [ "$waited" -lt "$SHUTDOWN_GRACE_S" ]; do
      pgrep -f "uuid $UUID" >/dev/null || break
      sleep 3; waited=$((waited + 3))
    done
    if pgrep -f "uuid $UUID" >/dev/null; then
      echo "  guest ignored ACPI shutdown after ${waited}s -- forcing"
      utmctl stop "$UUID" >/dev/null
      for _ in $(seq 1 10); do pgrep -f "uuid $UUID" >/dev/null || break; sleep 3; done
    fi
    echo "stopped after ${waited}s ($(qemu_usage))"
    ;;

  status)
    echo "vm:      $VM_NAME ($UUID)"
    state="$(vm_state "$UUID")"
    echo "state:   $state"
    [ "$state" = unknown ] && explain_unknown
    echo "host:    $(qemu_usage)"
    ip="$(guest_ip "$UUID" || true)"
    echo "guest:   ${ip:-no ip (agent not reporting)}"
    body="$(health "$UUID" || true)"
    if [ -n "$body" ]; then
      echo "health:  $body"
      echo "$body" | grep -q '"busy":true' && echo "         (busy is NORMAL: one capture at a time by design)"
    else
      echo "health:  unreachable after $HEALTH_TRIES probes"
      if [ -n "${ip:-}" ]; then
        echo "         the guest is up and has an IP, so this is the WORKER, not the VM." >&2
        echo "         it is down for 5-10s during a restart; if it persists:" >&2
        echo "         utmctl exec <uuid> --cmd powershell.exe -NoProfile -Command 'Start-ScheduledTask -TaskName a11ysrv'" >&2
      else
        # `$0` is this file's path, which after M6 is `packages/worker-fleet/src/local-worker/worker-ctl.sh` — true,
        # and not what anyone wants to type. The npm alias is the stable way to say it, and it is what the docs use.
        echo "         no guest IP either, so the VM itself is not ready. Try 'npm run worker:ctl -- up'." >&2
      fi
    fi
    ;;

  json)
    # One line of JSON for the control plane (src/capture/local-vm.ts). Keeping every UTM
    # detail behind this command means the TS side never parses human-readable output and
    # never learns about utmctl, bundles or bookmarks.
    ip="$(guest_ip "$UUID" || true)"
    body="$(health "$UUID" || true)"
    healthy=false; [ -n "$body" ] && healthy=true
    busy=false; if echo "$body" | grep -q '"busy":true'; then busy=true; fi
    # A worker can answer /health while NVDA cannot start. `ready:false` says so explicitly;
    # a worker predating the field reports nothing, and is treated as ready.
    # `ready` is only meaningful when something ANSWERED. This defaulted to true and was lowered only if
    # the body said `"ready":false` — so a stopped or unreachable VM, whose body is empty, reported
    # `ready: true`. That is "we could not ask" rendered as "yes", on the one field CLAUDE.md says to
    # dispatch on: a run reading this JSON could pick a stopped guest.
    ready=false
    if [ "$healthy" = true ] && ! echo "$body" | grep -q '"ready":false'; then ready=true; fi
    state="$(vm_state "$UUID")"

    # `means` carries no information the other fields lack; it exists because they were being
    # read wrong. `healthy:false` says "not answering right now", but three of those in a row
    # looks like a broken pool -- and since a run starts its own workers, stopped is the normal
    # resting state. An agent read exactly this output, concluded the environment was down, and
    # went hunting for a worker that had been decommissioned. So the JSON now says what it means.
    if [ "$healthy" = true ] && [ "$ready" = false ]; then
      means="answering but NOT ready -- NVDA still warming up, or it failed to start"
    elif [ "$healthy" = true ]; then
      means="ready"; [ "$busy" = true ] && means="ready, busy with a capture"
    elif [ "$state" = "started" ]; then
      means="running but not answering /health -- this one IS a fault"
    else
      means="$state -- normal at rest; a run starts it and stops it again"
    fi
    printf '{"uuid":"%s","name":"%s","state":"%s","ip":"%s","port":%s,"healthy":%s,"ready":%s,"busy":%s,"means":"%s"}\n' \
      "$UUID" "$VM_NAME" "$state" "${ip:-}" "$PORT" "$healthy" "$ready" "$busy" "$means"
    ;;

  pool-stop|pool-pause)
    # Stop or pause every worker in one go, for when a run has finished and you want the
    # resources back. `idle-stop`/`idle-pause` do this automatically for a single VM; this is
    # the manual, whole-pool version.
    action="${CMD#pool-}"
    for n in $(utmctl list | awk -v n="$VM_NAME" '$3 ~ "^"n { print $3 }' | sort -u); do
      echo "--- $n ---"
      A11Y_VM_NAME="$n" "$0" "$action" || echo "  '$n' did not $action"
    done
    ;;

  pool|pool-up)
    # Every VM whose name starts with the base name: a11y-worker, a11y-worker-2, ...
    # Emitted as one JSON array so a dispatcher can consume it without parsing prose.
    names="$(utmctl list | awk -v n="$VM_NAME" '$3 ~ "^"n { print $3 }' | sort -u)"
    [ -n "$names" ] || die "no VM whose name starts with '$VM_NAME'"
    if [ "$CMD" = "pool-up" ]; then
      # Sequentially, not in parallel: two Windows guests booting at once contend badly for
      # disk, and one that is already up costs nothing to skip.
      for n in $names; do
        echo "--- $n ---" >&2
        A11Y_VM_NAME="$n" "$0" up >&2 || echo "  '$n' did not come up" >&2
      done
    fi
    printf '['
    first=1
    for n in $names; do
      entry="$(A11Y_VM_NAME="$n" "$0" json 2>/dev/null || true)"
      [ -n "$entry" ] || continue
      [ "$first" -eq 1 ] || printf ','
      printf '%s' "$entry"
      first=0
    done
    printf ']\n'
    ;;

  idle-pause|idle-stop)
    mins="${ARG:-15}"
    action=pause; [ "$CMD" = "idle-stop" ] && action=stop
    echo "watching $VM_NAME; will $action after $mins idle minutes (Ctrl-C to stop watching)"
    idle=0
    while :; do
      body="$(health "$UUID" || true)"
      if [ -z "$body" ]; then
        echo "worker unreachable (state: $(vm_state "$UUID")) -- nothing to do"
        exit 0
      fi
      # `busy` is true only while a capture is in flight, so it is the honest activity
      # signal. Any capture resets the clock.
      if echo "$body" | grep -q '"busy":true'; then
        [ "$idle" -gt 0 ] && echo "  capture in flight, resetting idle clock"
        idle=0
      else
        idle=$((idle + 1))
      fi
      if [ "$idle" -ge "$mins" ]; then
        echo "idle $mins min -> $action"
        exec "$0" "$action"
      fi
      sleep 60
    done
    ;;

  *) die "unknown command '$CMD' (up | pause | stop | status | json | pool | pool-up | pool-stop | pool-pause | idle-pause [min] | idle-stop [min])";;
esac
