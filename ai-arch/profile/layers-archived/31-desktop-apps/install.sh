#!/usr/bin/env bash
# Layer 31-desktop-apps — standard everyday-OS app suite (phase 2a2).
#   docs/AI-ARCH-DESKTOP.md "Standard desktop suite (2a2)": the distro is a
#   complete everyday OS before any AI feature. Established official-repo
#   apps only (KDE-native first) — no AUR, no reinvention.
#
#   Everyday apps: kate (text editor), ark (archives), gwenview (images),
#     vlc (media), elisa (music), okular (PDF/docs), kcalc (calculator),
#     spectacle (screenshot/record), klevernotes (notes), khelpcenter (help)
#   Core: discover (software center AND update manager; pamac is gone from
#     the repos), flatpak (optional app source)
#   System utilities: partitionmanager (storage), font-manager (fonts),
#     keepassxc (passwords; kwallet already ships in plasma-workspace),
#     simple-scan (scanner)
#   Platform services: networkmanager (+ Plasma network applet) replaces
#     systemd-networkd as the product's networking; bluez + bluedevil
#     (Bluetooth); cups + bluez-cups (printing)
#
#   Notes (2026-08-27): KDE's own fontmanager and knotes are no longer
#   packaged — font-manager and klevernotes fill the roles. IDE (VS Code /
#   VSCodium) is AUR-only; decision D6 pending (pinned tarball or defer).
# Runs as root inside the installed VM. Idempotent; no secrets.
set -euo pipefail

pacman --noconfirm -S --needed \
  kate ark gwenview vlc elisa okular kcalc spectacle klevernotes khelpcenter \
  discover flatpak \
  partitionmanager font-manager keepassxc simple-scan \
  networkmanager bluez bluedevil cups bluez-cups

# Product networking: NetworkManager (Plasma network applet + settings KCM)
# replaces systemd-networkd. NM auto-connects the wired link; the preseed's
# install-time networkd config stays on disk but is no longer active.
# Mask networkd service + sockets so nothing can re-trigger it and steal the
# link from NM (unmask to switch back).
for u in systemd-networkd.service systemd-networkd.socket \
         systemd-networkd-varlink.socket \
         systemd-networkd-varlink-metrics.socket \
         systemd-networkd-resolve-hook.socket; do
  systemctl mask "$u" 2>/dev/null || true
done
systemctl disable --now systemd-networkd 2>/dev/null || true
systemctl enable --now NetworkManager

systemctl enable --now cups
systemctl enable bluetooth

echo "31-desktop-apps: standard app suite installed (KDE-native, official repos)"
