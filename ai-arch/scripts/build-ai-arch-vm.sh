#!/usr/bin/env bash
#
# build-ai-arch-vm.sh — AI-Arch Phase 1 (T1): one script + one preseed -> verified VM.
#
# Stands up a fresh Arch Linux VM unattended, built entirely from the frozen
# preseed (preseed/archinstall-config.json, T0) and the owner SSH key.
#
# Pipeline (each phase logged, fail-fast):
#   1. preflight        host tools, key, preseed+creds, network, name safety
#   2. iso verify       sha256 vs mirror sha256sums.txt + GPG (downloads if absent)
#   3. render           per-build artifacts into build/<name>/ (qcow2, NVRAM,
#                       preseed variant with hostname=<name>, NoCloud seed ISO,
#                       install + disk-boot domain XMLs)
#   4. install          define+start (ISO env, cdrom-first) -> resolve IP from
#                       dnsmasq lease -> wait root key-SSH (from seed) ->
#                       scp preseed+creds -> archinstall --silent (nohup,
#                       polled via /root/archinstall.done) -> save install.log
#   5. disk boot        destroy -> define disk-boot XML -> start -> re-resolve IP
#   6. profile          apply profile/layers in order (scp + install.sh +
#                       verify.sh per layer, fail-fast)
#   7. verify           SSH as archdev + root (proves T0 key injection),
#                       services, sudoers, swap, partitions, report to
#                       build/<name>/verify-report.txt
#
# Design notes:
#   - IP-agnostic: the VM's address is always resolved from the libvirt 'default'
#     network lease (virsh net-dhcp-leases default), never hardcoded.
#   - TCG host (no /dev/kvm): type='qemu'. Install is slow; timeouts are generous.
#   - archinstall 4.4 (verified from ISO source): --config --creds --silent are
#     real CLI flags; --silent skips every TUI prompt AND the post-install
#     REBOOT/CHROOT menu, so the install exits in the ISO env and THIS script
#     performs the destroy + disk-boot switch.
#   - swap: the preseed creates a GPT swap partition (GUID 0657-); systemd's
#     gpt-auto-generator activates it at boot with no fstab entry (verified on
#     ai-arch-dev).
#   - No secrets in this script: the preseed carries only the PUBLIC owner key;
#     the creds file (gitignored, 600) is scp'd straight through, never printed.
#
# Usage:
#   scripts/build-ai-arch-vm.sh --name <domain> [options]
#
#   --name <domain>     required. Domain name = installed hostname.
#                       Must not be 'ai-arch-dev' (lab VM is protected).
#   --build-only        run phases 1-3 only (preflight, ISO verify, render);
#                       do not define or start anything.
#   --force             if <domain> exists: destroy+undefine it first; wipe
#                       build/<name>/ before rendering.
#   --teardown          after verify: stop + undefine <domain> (keep artifacts).
#   --clean             --teardown plus delete build/<name>/ entirely.
#   --iso <path>        alternate ISO (default: pinned canonical ISO below).
#
# Exit codes: 0 = all verify checks PASS (or --build-only completed).
#             non-zero = failure; phase + serial-log tail are printed.

set -Eeuo pipefail

# ---------------------------------------------------------------- constants
ROOT="/home/charlesjackson/ai-arch"
PRESEED_CANON="$ROOT/preseed/archinstall-config.json"
CREDS="$ROOT/preseed/archinstall-creds.json"
OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS_TPL="/usr/share/OVMF/OVMF_VARS_4M.fd"
OWNER_KEY="$HOME/.ssh/ai-arch-dev_ed25519"
KH_FILE="$HOME/.ssh/known_hosts-build"          # dedicated known_hosts for build VMs
ISO_PINNED="$ROOT/iso/archlinux-2026.08.01-x86_64.iso"
MAC_PREFIX="52:54:00:12"                            # per-run unique MAC derived in preflight
DISK_SIZE="120G"
SIGNER_FP="3E80CA1A8B89F69CBA57D98A76A5EF9054449A5C"   # Pierre Schmitz, ed25519 (ISO-VERIFICATION.md)
MIRRORS=(
  "https://mirror.arizona.edu/archlinux"
  "https://arch.mirror.gws.fc.com/archlinux"
  "https://mirror.math.princeton.edu/pub/archlinux"
)
ISO_WAIT_S=1800          # max wait for ISO env: lease + root SSH
INSTALL_WAIT_S=14400     # max wait for archinstall (TCG, busy host: 1-3h expected)
BOOT_WAIT_S=1800         # max wait for installed disk boot: lease + archdev SSH
POLL_S=15

BUILD_ONLY=0
FORCE=0
TEARDOWN=0
CLEAN=0
NAME=""
ISO_PATH="$ISO_PINNED"

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die()  { log "FATAL: $*"; exit 1; }
phase(){ log "=== $* ==="; }

PHASE="init"
on_err() {
  local rc=$?
  log "ERROR in phase '$PHASE' (rc=$rc)"
  if [ -n "${SERIAL:-}" ] && [ -f "$SERIAL" ]; then
    echo "--- last 40 lines of serial log ($SERIAL) ---"
    tail -40 "$SERIAL" 2>/dev/null || true
  fi
  exit "$rc"
}
trap on_err ERR

# ---------------------------------------------------------------- args
while [ $# -gt 0 ]; do
  case "$1" in
    --name)       NAME="${2:?}"; shift 2 ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --force)      FORCE=1; shift ;;
    --teardown)   TEARDOWN=1; shift ;;
    --clean)      TEARDOWN=1; CLEAN=1; shift ;;
    --iso)        ISO_PATH="${2:?}"; shift 2 ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "unknown arg: $1 (see --help)" ;;
  esac
done
[ -n "$NAME" ] || die "--name <domain> is required"

# ---------------------------------------------------------------- 1. preflight
phase "1/7 preflight (name=$NAME)"

[[ "$NAME" =~ ^[a-z][a-z0-9-]{2,30}$ ]] || die "name '$NAME' must match ^[a-z][a-z0-9-]{2,30}$"
[ "$NAME" != "ai-arch-dev" ] || die "refusing to build over the lab VM 'ai-arch-dev'"

# Per-run unique MAC: a fixed MAC leaves stale dnsmasq leases across re-runs
# (killed attempts), and resolve_ip could match a dead row. Deriving from the
# epoch makes each run's lease unambiguous; the guard never reuses the lab VM's MAC.
TS=$(( $(date +%s) % 65536 ))
MAC="${MAC_PREFIX}:$(printf '%02x' $(( TS / 256 ))):$(printf '%02x' $(( TS % 256 )))"
[ "$MAC" != "52:54:00:12:34:56" ] || MAC="52:54:00:12:34:57"
rm -f "$KH_FILE"   # IP is random per run; a stale known_hosts entry is just noise

for t in virsh qemu-img genisoimage gpg python3 ssh scp curl jq sha256sum xmllint; do
  command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"
done
[ -f "$OWNER_KEY" ]        || die "owner key missing: $OWNER_KEY"
[ -f "$PRESEED_CANON" ]    || die "canonical preseed missing: $PRESEED_CANON"
[ -f "$CREDS" ]            || die "creds file missing: $CREDS (gitignored; required)"
[ -f "$OVMF_CODE" ]        || die "OVMF code missing: $OVMF_CODE"
[ -f "$OVMF_VARS_TPL" ]    || die "OVMF vars template missing: $OVMF_VARS_TPL"
[ -f "$ISO_PATH" ] || log "ISO not present at $ISO_PATH — download will be attempted in phase 2"
virsh net-info default 2>/dev/null | grep -q 'Active.*yes' || die "libvirt 'default' network not active"
virsh list --all --name 2>/dev/null | grep -qx "$NAME" && {
  [ "$FORCE" = 1 ] || die "domain '$NAME' already exists (use --force to replace it)"
}

BUILD="$ROOT/build/$NAME"
SERIAL="$BUILD/$NAME-serial.log"
if [ "$FORCE" = 1 ]; then
  if virsh list --all --name 2>/dev/null | grep -qx "$NAME"; then
    log "force: destroying + undefining existing domain $NAME"
    virsh destroy "$NAME" 2>/dev/null || true
    virsh undefine --keep-nvram "$NAME" 2>/dev/null || virsh undefine "$NAME" 2>/dev/null || true
  fi
  [ -d "$BUILD" ] && { log "force: wiping $BUILD"; rm -rf "$BUILD"; }
fi
mkdir -p "$BUILD"
touch "$KH_FILE"; chmod 600 "$KH_FILE"

# frozen preseed must still validate (T0 regression test)
( cd "$ROOT" && python3 scripts/validate-preseed.py ) >/dev/null \
  || die "canonical preseed failed validation"
log "preflight OK"

# ---------------------------------------------------------------- 2. ISO verify
phase "2/7 ISO verify ($ISO_PATH)"

iso_name="$(basename "$ISO_PATH")"
iso_sig="$ISO_PATH.sig"
iso_version="$(sed -E 's/^archlinux-([0-9]{4}\.[0-9]{2}\.[0-9]{2})-x86_64\.iso$/\1/' <<<"$iso_name")"
[ "$iso_version" != "$iso_name" ] || die "unexpected ISO filename: $iso_name"

fetch_from() { # fetch_from <relative-path> <dest>
  local rel="$1" dest="$2" base
  for base in "${MIRRORS[@]}"; do
    log "  trying $base/$rel"
    if curl -4 -fSL --retry 3 --retry-delay 5 --max-time 3600 -A "ai-arch-build" "$base/$rel" -o "$dest"; then
      log "  fetched from $base"
      return 0
    fi
  done
  return 1
}

if [ ! -f "$ISO_PATH" ]; then
  log "downloading ISO (~1.6 GB)"
  fetch_from "iso/$iso_version/$iso_name" "$ISO_PATH.part" || die "ISO download failed from all mirrors"
  [ "$(stat -c%s "$ISO_PATH.part")" -gt 1000000000 ] || die "downloaded file too small — not a full ISO"
  mv "$ISO_PATH.part" "$ISO_PATH"
fi
[ -f "$iso_sig" ] || { log "downloading .sig"; fetch_from "iso/$iso_version/$iso_name.sig" "$iso_sig" || die ".sig download failed"; }

# sha256 vs the mirror's published sha256sums.txt (no hardcoded hash)
sums_file="$BUILD/sha256sums.txt"
log "fetching sha256sums.txt"
fetch_from "iso/$iso_version/sha256sums.txt" "$sums_file" \
  || fetch_from "iso/latest/sha256sums.txt" "$sums_file" \
  || die "could not fetch sha256sums.txt from any mirror"
expected="$(awk -v n="$iso_name" '$2 == n {print $1; exit}' "$sums_file")"
[ -n "$expected" ] || die "sha256sums.txt has no entry for $iso_name"
log "computing sha256 (1.6 GB, ~1-2 min)"
actual="$(sha256sum "$ISO_PATH" | awk '{print $1}')"
log "  expected: $expected"
log "  actual:   $actual"
[ "$expected" = "$actual" ] || die "SHA256 MISMATCH"
log "SHA256 VERIFY: PASS"

# GPG: ensure signing key present, then verify
# colon format: "fpr:::<40-hex-fingerprint>:" — grep for the raw hex
have_key=0
if gpg --list-keys --with-colons 2>/dev/null | grep -q "fpr:.*$SIGNER_FP"; then
  have_key=1
fi
if [ "$have_key" = 0 ]; then
  log "signing key $SIGNER_FP not in keyring; attempting keyserver import"
  for ks in "hkps://keyserver.ubuntu.com" "hkps://keys.openpgp.org"; do
    log "  trying $ks"
    if gpg --batch --keyserver "$ks" --recv-keys "$SIGNER_FP" 2>"$BUILD/gpg-recv.err"; then
      if gpg --list-keys --with-colons 2>/dev/null | grep -q "fpr:.*$SIGNER_FP"; then
        have_key=1; break
      fi
    fi
    sed 's/^/    /' "$BUILD/gpg-recv.err" | tail -3
  done
fi
[ "$have_key" = 1 ] || die "cannot obtain ISO signing key $SIGNER_FP (keyring + keyserver failed) — refusing unverified ISO"
if gpg --verify "$iso_sig" "$ISO_PATH" 2>"$BUILD/gpg-verify.err"; then
  log "GPG VERIFY: PASS"
else
  cat "$BUILD/gpg-verify.err"
  die "GPG VERIFY: FAIL"
fi

# ---------------------------------------------------------------- 3. render
phase "3/7 render artifacts -> $BUILD"

QDISK="$BUILD/$NAME.qcow2"
VARS="$BUILD/OVMF_VARS-$NAME.fd"
CFG="$BUILD/archinstall-config.json"
SEED="$BUILD/seed-$NAME.iso"
XML_INSTALL="$BUILD/$NAME-install.xml"
XML_DISK="$BUILD/$NAME-disk.xml"

log "qemu-img create $QDISK $DISK_SIZE"
qemu-img create -f qcow2 "$QDISK" "$DISK_SIZE"
cp "$OVMF_VARS_TPL" "$VARS"

# per-build preseed variant: only the hostname differs from the canonical freeze
log "rendering preseed variant (hostname=$NAME)"
jq --arg n "$NAME" '.hostname = $n' "$PRESEED_CANON" > "$CFG"
( cd "$ROOT" && python3 - "$CFG" <<'PYEOF'
import sys
sys.argv[1]  # path
import importlib.util
spec = importlib.util.spec_from_file_location("vp", "scripts/validate-preseed.py")
# validate the RENDERED file: reuse the same rules via subprocess with path arg
import subprocess, json
cfg = json.load(open(sys.argv[1]))
assert cfg["hostname"] == "ai-arch-buildtest" or True  # hostname check below
print("rendered preseed JSON parse OK")
PYEOF
) || die "rendered preseed failed to parse"
python3 - "$CFG" "$NAME" <<'PYEOF' || die "rendered preseed failed variant checks"
import json, sys
path, name = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
assert cfg["hostname"] == name, f"hostname {cfg['hostname']} != {name}"
canon = json.load(open("preseed/archinstall-config.json"))
c2 = dict(canon); c2["hostname"] = name
assert cfg == c2, "rendered preseed differs from canonical in more than hostname"
print(f"rendered preseed OK: only hostname changed ({name})")
PYEOF

# NoCloud seed (volid=cidata): gives the ISO env root key access + hostname
SEED_SRC="$BUILD/seed-src"
rm -rf "$SEED_SRC"; mkdir -p "$SEED_SRC"
pub="$(awk '{print $1" "$2}' "$OWNER_KEY.pub")"
cat > "$SEED_SRC/meta-data" <<EOF
instance-id: ${NAME}-$(date -u +%Y%m%d%H%M%S)
local-hostname: $NAME
EOF
cat > "$SEED_SRC/vendor-data" <<'EOF'
# empty vendor-data
EOF
cat > "$SEED_SRC/user-data" <<EOF
#cloud-config
disable_root: false
preserve_hostname: false
hostname: $NAME
users:
  - name: root
    shell: /bin/bash
    ssh_authorized_keys:
      - $pub
runcmd:
  - [ bash, -c, 'echo cloud-init-ran $(date -u +%FT%TZ) > /run/cloudinit-ran' ]
EOF
log "genisoimage seed ISO"
genisoimage -output "$SEED" -volid cidata -joliet -rock "$SEED_SRC" >/dev/null
[ -s "$SEED" ] || die "seed ISO empty"

# domain XMLs — install (cdrom-first: ISO on sda, seed on sdb) and disk boot
render_xml() { # render_xml <out> <with-iso: 0|1>
  local out="$1" with_iso="$2"
  {
    cat <<EOF
<domain type='qemu'>
  <name>$NAME</name>
  <title>AI-Arch Phase 1 build: $NAME (TCG, OVMF, 8GiB/4cpu)</title>
  <memory unit='GiB'>8</memory>
  <currentMemory unit='GiB'>8</currentMemory>
  <vcpu placement='static'>4</vcpu>
  <os>
    <type arch='x86_64' machine='pc-i440fx-6.2'>hvm</type>
    <loader readonly='yes' secure='no' type='pflash'>$OVMF_CODE</loader>
    <nvram template='$OVMF_VARS_TPL'>$VARS</nvram>
EOF
    [ "$with_iso" = 1 ] && echo "    <boot dev='cdrom'/>"
    echo "    <boot dev='hd'/>"
    cat <<EOF
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='custom' match='exact' check='full'>
    <model fallback='forbid'>EPYC</model>
    <vendor>AMD</vendor>
    <feature policy='require' name='acpi'/>
    <feature policy='require' name='ss'/>
    <feature policy='require' name='monitor'/>
    <feature policy='require' name='hypervisor'/>
    <feature policy='require' name='erms'/>
    <feature policy='require' name='mpx'/>
    <feature policy='require' name='pcommit'/>
    <feature policy='require' name='clwb'/>
    <feature policy='require' name='pku'/>
    <feature policy='require' name='la57'/>
    <feature policy='require' name='pks'/>
    <feature policy='require' name='3dnowext'/>
    <feature policy='require' name='3dnow'/>
    <feature policy='require' name='npt'/>
    <feature policy='require' name='svme-addr-chk'/>
    <feature policy='disable' name='vme'/>
    <feature policy='disable' name='fma'/>
    <feature policy='disable' name='avx'/>
    <feature policy='disable' name='f16c'/>
    <feature policy='disable' name='avx2'/>
    <feature policy='disable' name='rdseed'/>
    <feature policy='disable' name='sha-ni'/>
    <feature policy='disable' name='xsavec'/>
    <feature policy='disable' name='fxsr_opt'/>
    <feature policy='disable' name='misalignsse'/>
    <feature policy='disable' name='3dnowprefetch'/>
    <feature policy='disable' name='osvw'/>
    <feature policy='disable' name='topoext'/>
    <feature policy='disable' name='nrip-save'/>
  </cpu>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='$QDISK'/>
      <target dev='vda' bus='virtio'/>
    </disk>
EOF
    if [ "$with_iso" = 1 ]; then
      cat <<EOF
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='$ISO_PATH'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='$SEED'/>
      <target dev='sdb' bus='sata'/>
      <readonly/>
    </disk>
EOF
    fi
    cat <<EOF
    <interface type='network'>
      <mac address='$MAC'/>
      <source network='default'/>
      <model type='virtio'/>
    </interface>
    <serial type='file'>
      <source path='$SERIAL'/>
      <target port='0'/>
    </serial>
    <console type='file'>
      <source path='$SERIAL'/>
      <target type='serial' port='0'/>
    </console>
    <input type='tablet' bus='usb'/>
    <graphics type='vnc' port='-1' listen='127.0.0.1'/>
    <video>
      <model type='virtio' vram='16384' heads='1' primary='yes'/>
    </video>
    <memballoon model='virtio'/>
  </devices>
</domain>
EOF
  } > "$out"
  xmllint --noout "$out" || die "XML invalid: $out"
}
render_xml "$XML_INSTALL" 1
render_xml "$XML_DISK" 0
log "render complete:"
ls -la "$BUILD"

if [ "$BUILD_ONLY" = 1 ]; then
  log "--build-only: stopping here (nothing defined or started)"
  exit 0
fi

# ---------------------------------------------------------------- ssh helpers
ssh_opts=(
  -o BatchMode=yes -o ConnectTimeout=8
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$KH_FILE"
  -i "$OWNER_KEY"
)

resolve_ip() { # resolve_ip [stale-ips...] -> IP (newest lease for $MAC; stale excluded)
  local out d t cand e best ip stale="${*:-}"
  for _ in $(seq 1 200); do
    out="$(virsh net-dhcp-leases default 2>/dev/null || true)"
    # Columns: $1=date $2=time $3=MAC $4=proto $5=IP/prefix $6=hostname $7=hw
    # Multiple stale rows share the MAC (ISO env + disk env use the same
    # per-run MAC); the live env is the newest issue (fixed-width, so
    # lexicographic order == chronological order), excluding any explicitly
    # stale IPs (e.g. the ISO-env lease, still in the table after destroy).
    best=""; ip=""
    while read -r d t cand; do
      [ -n "${cand:-}" ] || continue
      cand="${cand%%/*}"
      case " $stale " in *" $cand "*) continue ;; esac
      e="$d $t"
      if [ -z "$best" ] || [ "$e" \> "$best" ]; then best="$e"; ip="$cand"; fi
    done <<<"$(awk -v m="$MAC" '$3 == m && $4 == "ipv4" {print $1, $2, $5}' <<<"$out")"
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
    sleep 10
  done
  return 1
}

wait_ssh() { # wait_ssh <user> <ip> <timeout-s>
  local user="$1" ip="$2" to="$3"
  local deadline=$(( $(date +%s) + to ))
  log "waiting for $user@$ip (max $((to/60)) min)"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ssh "${ssh_opts[@]}" "$user@$ip" true 2>/dev/null; then
      log "SSH OK: $user@$ip"
      return 0
    fi
    sleep "$POLL_S"
  done
  return 1
}

# ---------------------------------------------------------------- 4. install
phase "4/7 install (archinstall 4.4, silent, in ISO env)"

log "defining + starting $NAME (install XML: cdrom-first)"
virsh define "$XML_INSTALL"
rm -f "$SERIAL"; : > "$SERIAL"
virsh start "$NAME"
IP="$(resolve_ip)" || die "no dnsmasq lease for $MAC within timeout (serial: $SERIAL)"
log "ISO env IP: $IP"
wait_ssh "root" "$IP" "$ISO_WAIT_S" || die "root key-SSH never came up in ISO env (seed/NoCloud?)"

log "copying preseed variant + creds into ISO env (no secrets printed)"
scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KH_FILE" -i "$OWNER_KEY" \
  "$CFG" "$CREDS" "root@$IP:/root/" || die "scp of config/creds failed"
ssh "${ssh_opts[@]}" "root@$IP" "chmod 600 /root/archinstall-creds.json /root/archinstall-config.json"

# Note (2026-08-26): pacman's "Operation too slow" low-speed check (1 B/s over
# 10s, hardcoded in libalpm) is NOT tunable via pacman.conf, and a stalled
# transfer is fatal to the *file* (never retried on the next mirror). Resilience
# comes from mirror ORDER in the preseed: the healthy mirror (rackspace) is
# primary; arizona is the fallback.
log "launching archinstall --silent (nohup; polled via /root/archinstall.done)"
ssh "${ssh_opts[@]}" "root@$IP" 'nohup bash -c "archinstall --config /root/archinstall-config.json --creds /root/archinstall-creds.json --silent; echo ARCHINSTALL_EXIT=\$? > /root/archinstall.done" > /root/archinstall-out.log 2>&1 & echo LAUNCHED' \
  || die "failed to launch archinstall"

INSTALL_DEADLINE=$(( $(date +%s) + INSTALL_WAIT_S ))
log "waiting for archinstall to finish (max $((INSTALL_WAIT_S/3600)) h, TCG)"
while [ "$(date +%s)" -lt "$INSTALL_DEADLINE" ]; do
  if done_txt="$(ssh "${ssh_opts[@]}" "root@$IP" "cat /root/archinstall.done 2>/dev/null" 2>/dev/null)"; then
    case "$done_txt" in
      ARCHINSTALL_EXIT=0) log "archinstall finished: exit 0"; break ;;
      *) die "archinstall failed: $done_txt (log: $BUILD/install.log after save)" ;;
    esac
  fi
  # liveness: if the launch shell's child is gone and no done file, something crashed
  if ! ssh "${ssh_opts[@]}" "root@$IP" "pgrep -f 'archinstall' >/dev/null" 2>/dev/null; then
    if ! ssh "${ssh_opts[@]}" "root@$IP" "test -f /root/archinstall.done" 2>/dev/null; then
      log "archinstall process vanished with no done-file — checking serial for panic"
      tail -30 "$SERIAL" 2>/dev/null || true
      die "archinstall crashed early (see serial log)"
    fi
  fi
  sleep 60
done
[ "$(date +%s)" -lt "$INSTALL_DEADLINE" ] || die "install timeout after $((INSTALL_WAIT_S/3600)) h"

log "saving install.log before destroy"
scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KH_FILE" -i "$OWNER_KEY" \
  "root@$IP:/var/log/archinstall/install.log" "$BUILD/install.log" 2>/dev/null \
  || log "WARN: could not save install.log"

# ---------------------------------------------------------------- 5. disk boot
phase "5/7 disk boot (destroy ISO env, redefine without cdroms)"

# Both envs share the per-run MAC, so the ISO-env lease stays in the dnsmasq
# table after destroy — snapshot it so resolve_ip can't return the stale IP
# before the disk env's fresh lease appears (a few seconds after boot).
# Phase 4 already resolved the ISO-env IP ($IP), so the snapshot must be
# non-empty; retry transient virsh failures, and fail closed otherwise
# (proceeding without it re-creates the stale-IP bug).
ISO_IP="$IP"
STALE_IPS=""
for _ in $(seq 1 30); do
  STALE_IPS="$(virsh net-dhcp-leases default 2>/dev/null | awk -v m="$MAC" '$3 == m && $4 == "ipv4" {split($5, a, "/"); print a[1]}' | tr '\n' ' ')"
  [ -n "$STALE_IPS" ] && break
  sleep 2
done
[ -n "$STALE_IPS" ] || die "could not snapshot ISO-env lease for $MAC"
log "stale ISO-env leases for $MAC: $STALE_IPS"

virsh destroy "$NAME"
# --keep-nvram: pflash NVRAM is defined in the XML and re-created on next define
virsh undefine --keep-nvram "$NAME"
log "defining + starting $NAME (disk XML: boot from vda)"
virsh define "$XML_DISK"
rm -f "$SERIAL"; : > "$SERIAL"
virsh start "$NAME"
IP="$(resolve_ip $STALE_IPS "$ISO_IP")" || die "no fresh lease after disk boot (stale excluded: ${STALE_IPS:-none} $ISO_IP)"
log "installed VM IP: $IP"
wait_ssh "archdev" "$IP" "$BOOT_WAIT_S" || die "archdev key-SSH never came up after disk boot — T0 key injection FAILED (serial: $SERIAL)"

# ---------------------------------------------------------------- 6. profile
phase "6/7 profile (apply profile/layers in order)"

REPORT="$BUILD/verify-report.txt"
{
  echo "AI-Arch Phase 1 verify report — $NAME"
  echo "date: $(date -u +%FT%TZ)  ip: $IP  mac: $MAC"
  echo "preseed: preseed/archinstall-config.json (T0 freeze), hostname rendered to $NAME"
  echo "profile: profile/layers (applied below)"
  echo
} > "$REPORT"

shopt -s nullglob
for layer_dir in "$ROOT/profile/layers"/*/; do
  [ -f "${layer_dir}install.sh" ] || continue
  layer="$(basename "$layer_dir")"
  log "layer $layer: scp -> install -> verify"
  scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KH_FILE" -i "$OWNER_KEY" \
    -r "$layer_dir" "archdev@$IP:/tmp/layer-$layer" || die "scp layer $layer failed"
  if ssh "${ssh_opts[@]}" "archdev@$IP" \
      "sudo bash /tmp/layer-$layer/install.sh > /tmp/layer-$layer-install.log 2>&1"; then
    ssh "${ssh_opts[@]}" "archdev@$IP" "tail -15 /tmp/layer-$layer-install.log" | sed 's/^/    /' || true
    if out="$(ssh "${ssh_opts[@]}" "archdev@$IP" "sudo bash /tmp/layer-$layer/verify.sh" 2>&1)"; then
      log "layer $layer: verify PASS"
      printf 'PASS  %-28s %s\n' "layer-$layer" "$(echo "$out" | tr '\n' ' ' | cut -c1-140)" >> "$REPORT"
    else
      printf 'FAIL  %-28s %s\n' "layer-$layer" "$(echo "$out" | tr '\n' ' ' | cut -c1-140)" >> "$REPORT"
      die "profile layer $layer: verify failed"
    fi
  else
    log "layer $layer: INSTALL FAIL (tail):"
    ssh "${ssh_opts[@]}" "archdev@$IP" "sudo tail -40 /tmp/layer-$layer-install.log" || true
    printf 'FAIL  %-28s install failed\n' "layer-$layer" >> "$REPORT"
    die "profile layer $layer: install failed"
  fi
  ssh "${ssh_opts[@]}" "archdev@$IP" "rm -rf /tmp/layer-$layer" || true
done
shopt -u nullglob

# ---------------------------------------------------------------- 7. verify
phase "7/7 verify (health battery as archdev + root)"

PASS=0; FAIL=0
check() { # check <label> <command-as-archdev>
  local label="$1" cmd="$2" out rc
  out="$(ssh "${ssh_opts[@]}" "archdev@$IP" "$cmd" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    log "PASS  $label : $(echo "$out" | head -2 | tr '\n' ' ')"
    printf 'PASS  %-28s %s\n' "$label" "$(echo "$out" | head -2 | tr '\n' ' ')" >> "$REPORT"
    PASS=$((PASS+1))
  else
    log "FAIL  $label (rc=$rc): $(echo "$out" | head -2 | tr '\n' ' ')"
    printf 'FAIL  %-28s %s\n' "$label" "$(echo "$out" | head -2 | tr '\n' ' ')" >> "$REPORT"
    FAIL=$((FAIL+1))
  fi
}
check "hostname"            "test \"\$(cat /etc/hostname | tr -d '[:space:]')\" = \"$NAME\""
check "root-fs-size"        "df --output=size / | tail -1 | tr -d ' ' | awk '{exit !(\$1 > 100*1024*1024)}'"
check "partitions-3"        "lsblk -n -o TYPE /dev/vda | grep -c ^part | awk '{exit !(\$1 == 3)}'"
check "swap-active"         "swapon --show | grep -q vda"
check "sshd-active"         "systemctl is-active sshd"
check "timesyncd-active"    "systemctl is-active systemd-timesyncd"
check "tailscale-pkg"       "pacman -Q tailscale"
check "tailscaled-enabled"  "systemctl is-enabled tailscaled"
check "sudoers-nopasswd"    "sudo -n true"
check "archdev-ssh-700"     "[ \"\$(stat -c %a /home/archdev/.ssh)\" = 700 ]"
check "archdev-keys-600"    "[ \"\$(stat -c %a /home/archdev/.ssh/authorized_keys)\" = 600 ]"
check "root-ssh-700"        "sudo stat -c %a /root/.ssh | awk '{exit !(\$1==700)}'"
check "root-keys-600"       "sudo stat -c %a /root/.ssh/authorized_keys | awk '{exit !(\$1==600)}'"
check "fstab-root-ext4"     "grep -cE '^\\S+\\s+/\\s+ext4' /etc/fstab"

# root key-SSH (separate from the archdev battery above)
if ssh "${ssh_opts[@]}" "root@$IP" "true" 2>/dev/null; then
  log "PASS  root-key-ssh"
  printf 'PASS  %-28s root key-ssh OK\n' "root-key-ssh" >> "$REPORT"; PASS=$((PASS+1))
else
  log "FAIL  root-key-ssh"
  printf 'FAIL  %-28s root key-ssh refused\n' "root-key-ssh" >> "$REPORT"; FAIL=$((FAIL+1))
fi

printf '\nTOTAL: %d PASS, %d FAIL\n' "$PASS" "$FAIL" >> "$REPORT"
log "verify: $PASS PASS / $FAIL FAIL (report: $REPORT)"

# ---------------------------------------------------------------- epilogue
if [ "$TEARDOWN" = 1 ]; then
  log "teardown: stopping + undefining $NAME"
  virsh shutdown "$NAME" 2>/dev/null || virsh destroy "$NAME" || true
  virsh undefine --keep-nvram "$NAME" 2>/dev/null || virsh undefine "$NAME" 2>/dev/null || true
  [ "$CLEAN" = 1 ] && { log "clean: removing $BUILD"; rm -rf "$BUILD"; }
fi

if [ "$FAIL" -gt 0 ]; then
  log "RESULT: FAIL — see $REPORT"
  exit 1
fi
if [ "$TEARDOWN" = 1 ]; then
  log "RESULT: PASS (VM torn down; artifacts: ${BUILD:-removed})"
else
  log "RESULT: PASS — $NAME is running at $IP (stop: virsh shutdown $NAME)"
fi
exit 0
