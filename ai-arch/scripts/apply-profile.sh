#!/usr/bin/env bash
#
# apply-profile.sh — apply profile/layers to a RUNNING AI-Arch VM over SSH.
#
# The fast iteration loop: edit a layer in the repo, re-apply, test. A fresh
# build-ai-arch-vm.sh run applies the exact same layers (its profile phase),
# so what you test here is what a clean build reproduces.
#
# Usage:
#   scripts/apply-profile.sh <vm-ip> [layer-name ...]
#
#   <vm-ip>            target VM (e.g. 192.168.122.50)
#   [layer-name ...]   apply only these layers (e.g. 20-ai-cpu); default = all,
#                      always applied in lexicographic (numeric prefix) order
#
# Requires: owner key, VM reachable, archdev with passwordless sudo.
# Exit: 0 = every selected layer installed + verified; non-zero on first failure.

set -Eeuo pipefail

ROOT="/home/charlesjackson/ai-arch"
OWNER_KEY="$HOME/.ssh/ai-arch-dev_ed25519"
PROFILE_DIR="$ROOT/profile/layers"

[ $# -ge 1 ] || { echo "usage: apply-profile.sh <vm-ip> [layer-name ...]" >&2; exit 1; }
IP="$1"; shift || true

command -v ssh >/dev/null || { echo "FATAL: ssh missing" >&2; exit 1; }
[ -f "$OWNER_KEY" ] || { echo "FATAL: owner key missing: $OWNER_KEY" >&2; exit 1; }
[ -d "$PROFILE_DIR" ] || { echo "FATAL: profile dir missing: $PROFILE_DIR" >&2; exit 1; }

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "FATAL: $*"; exit 1; }

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -i "$OWNER_KEY")
scp_opts=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts" -i "$OWNER_KEY")

ssh "${ssh_opts[@]}" "archdev@$IP" "sudo -n true" 2>/dev/null \
  || die "cannot sudo on archdev@$IP (key auth / passwordless sudo?)"

# Sync the package db first. Arch is rolling: a stale db references package
# versions whose files mirrors have already deleted -> 404s and pacman
# stalling in the download phase (seen 2026-08-26 with a 2-day-old db).
log "syncing package db on $IP"
ssh "${ssh_opts[@]}" "archdev@$IP" "sudo pacman -Sy" >/dev/null \
  || die "pacman -Sy failed on $IP"

wanted=("$@")
layers=()
for d in "$PROFILE_DIR"/*/; do
  [ -f "${d}install.sh" ] || continue
  name="$(basename "$d")"
  if [ ${#wanted[@]} -eq 0 ]; then
    layers+=("$d")
  else
    for w in "${wanted[@]}"; do
      [ "$w" = "$name" ] && layers+=("$d")
    done
  fi
done
[ ${#layers[@]} -gt 0 ] || die "no layers selected (wanted: ${wanted[*]:-all})"

rc=0
for d in "${layers[@]}"; do
  name="$(basename "$d")"
  log "layer $name: scp -> install -> verify"
  scp "${scp_opts[@]}" -r "$d" "archdev@$IP:/tmp/layer-$name" \
    || die "scp layer $name failed"

  if ssh "${ssh_opts[@]}" "archdev@$IP" \
      "sudo bash /tmp/layer-$name/install.sh > /tmp/layer-$name-install.log 2>&1"; then
    ssh "${ssh_opts[@]}" "archdev@$IP" "tail -15 /tmp/layer-$name-install.log" | sed 's/^/    /' || true
    if out="$(ssh "${ssh_opts[@]}" "archdev@$IP" "sudo bash /tmp/layer-$name/verify.sh" 2>&1)"; then
      log "layer $name: PASS"
    else
      log "layer $name: VERIFY FAIL:"
      echo "$out"
      rc=1
    fi
  else
    log "layer $name: INSTALL FAIL (tail):"
    ssh "${ssh_opts[@]}" "archdev@$IP" "sudo tail -40 /tmp/layer-$name-install.log" || true
    rc=1
  fi

  ssh "${ssh_opts[@]}" "archdev@$IP" "rm -rf /tmp/layer-$name" || true
  [ "$rc" -eq 0 ] || break
done

[ "$rc" -eq 0 ] || die "profile apply FAILED (see above)"
log "profile apply: all layers OK on $IP"
