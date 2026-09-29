#!/usr/bin/env bash
# Verify 31-desktop-apps — config-level checks (no GUI session required).
# Runs as root inside the VM. Exit 0 = PASS.
set -uo pipefail

fail=0
err() { echo "31-desktop-apps: FAIL — $*" >&2; fail=1; }

# Packages (all official repos; no AUR)
for p in kate ark gwenview vlc elisa okular kcalc spectacle klevernotes \
         khelpcenter discover flatpak \
         partitionmanager font-manager keepassxc simple-scan \
         networkmanager bluez bluedevil cups bluez-cups; do
  pacman -Q "$p" >/dev/null 2>&1 || err "package missing: $p"
done

# App entries (exact .desktop names verified on the 2026-08-01 stack)
for d in \
  org.kde.kate.desktop org.kde.ark.desktop org.kde.gwenview.desktop \
  vlc.desktop org.kde.elisa.desktop org.kde.okular.desktop \
  org.kde.kcalc.desktop org.kde.spectacle.desktop \
  org.kde.klevernotes.desktop org.kde.khelpcenter.desktop \
  org.kde.discover.desktop org.kde.partitionmanager.desktop \
  com.github.FontManager.FontManager.desktop \
  org.keepassxc.KeePassXC.desktop org.gnome.SimpleScan.desktop; do
  [ -f "/usr/share/applications/$d" ] || err "desktop entry missing: $d"
done

# Services
systemctl is-enabled NetworkManager >/dev/null 2>&1 || err "NetworkManager not enabled"
systemctl is-active NetworkManager >/dev/null 2>&1 || err "NetworkManager not active"
systemctl is-enabled cups >/dev/null 2>&1 || err "cups not enabled"
systemctl is-enabled bluetooth >/dev/null 2>&1 || err "bluetooth not enabled"
nd_state="$(systemctl is-enabled systemd-networkd 2>/dev/null || true)"
[ "$nd_state" = "masked" ] || err "systemd-networkd not masked (is: ${nd_state:-unknown})"

# NM actually owns the wired link
nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -q "^ens3:connected" \
  || err "ens3 not connected via NetworkManager"

[ "$fail" -eq 0 ] \
  && echo "31-desktop-apps: standard app suite installed (KDE-native, official repos)" \
  && echo "31-desktop-apps: PASS (everyday apps + system utilities + NM networking)"
