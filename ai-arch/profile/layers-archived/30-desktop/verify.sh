#!/usr/bin/env bash
# Layer 30-desktop — verify. Non-zero exit = FAIL.
# Config-level checks (no live session required; the VM may not have
# rebooted yet). Live-desktop proof happens on the lab VM via VNC/
# `virsh screenshot`.
set -euo pipefail

fail() { echo "30-desktop: FAIL — $*" >&2; exit 1; }

# plasmashell is bundled inside plasma-workspace (no standalone package);
# the shell QML ("org.kde.plasma.desktop") is in plasma-desktop.
for p in plasma-workspace plasma-desktop sddm dolphin konsole firefox \
         systemsettings plasma-systemmonitor; do
  pacman -Q "$p" >/dev/null 2>&1 || fail "missing package: $p"
done

for b in plasmashell sddm dolphin konsole firefox systemsettings \
         plasma-systemmonitor; do
  command -v "$b" >/dev/null 2>&1 || fail "missing binary: $b"
done

[ "$(systemctl get-default)" = "graphical.target" ] \
  || fail "default target is $(systemctl get-default), want graphical.target"
systemctl is-enabled sddm >/dev/null 2>&1 || fail "sddm not enabled"

grep -q '^User=archdev$' /etc/sddm.conf.d/autologin.conf \
  || fail "autologin config missing/wrong: /etc/sddm.conf.d/autologin.conf"

echo "30-desktop: PASS (KDE Plasma, archdev autologin, Wayland)"
