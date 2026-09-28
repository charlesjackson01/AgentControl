#!/usr/bin/env bash
# Layer 30-desktop — KDE Plasma desktop (AI-Arch Desktop, phase 2a).
#   Lean Plasma set (deliberately NOT kde-plasma-meta), mapped to the
#   AI-ARCH DESKTOP vision diagram (docs/AI-ARCH-DESKTOP.md):
#     Browser  -> firefox
#     Files    -> dolphin
#     Terminal -> konsole
#     Settings -> systemsettings
#     Monitor  -> plasma-systemmonitor
#   Package names verified against the pinned mirror 2026-08-26 (Plasma
#   6.7.4): plasmashell binary ships in plasma-workspace, but the desktop
#   shell QML ("org.kde.plasma.desktop" corona) ships in the separate
#   plasma-desktop package — without it plasmashell exits with
#   'starting invalid corona'. No standalone plasmashell /
#   plasma-wayland-session packages; no font-awesome package in the repos.
#   Desktop user = archdev (preseed user): SDDM autologin, no login prompt.
#   Session=plasma maps to the Wayland session (wayland-sessions/plasma.
#   desktop); X11 remains available as plasmax11. Networking stays on
#   systemd-networkd (preseed); the Plasma network applet
#   (NetworkManager) is out of scope.
# Runs as root inside the installed VM. Idempotent; no secrets.
set -euo pipefail

pacman --noconfirm -S --needed \
  plasma-workspace plasma-desktop plasma-pa plasma-workspace-wallpapers \
  plasma-systemmonitor systemsettings \
  sddm sddm-kcm \
  plasma-x11-session xorg-server mesa \
  dolphin konsole firefox

# SDDM autologin for the desktop user (archdev, created by the preseed).
install -d /etc/sddm.conf.d
cat > /etc/sddm.conf.d/autologin.conf <<'CONF'
[Autologin]
User=archdev
Session=plasma
CONF

systemctl set-default graphical.target
systemctl enable sddm.service

echo "30-desktop: KDE Plasma + apps installed; archdev autologin (Wayland)"
