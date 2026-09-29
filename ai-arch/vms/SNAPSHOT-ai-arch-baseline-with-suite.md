# Snapshot: ai-arch-baseline-with-suite

- **File:** `ai-arch-baseline-with-suite.qcow2`
- **Source:** `ai-arch-dev.qcow2` copied while VM `shut off` (cold copy,
  byte-identical — verified by SHA256 match)
- **SHA256:** `bc0a497f605d0db7316444cd38d34e370640e5809e1548da4cd1a347369551ba`
  (both files)
- **Taken:** 2026-08-27 ~01:55 UTC (after Phase 2a2, standard desktop suite)
- **State of this image:**
  - Everything in `SNAPSHOT-ai-arch-baseline-with-desktop.md` (Phase 2a:
    KDE Plasma 6.7.4, SDDM autologin, Wayland)
  - Phase 2a2 profile layer `31-desktop-apps` applied:
    - Everyday: kate, ark, gwenview, vlc, elisa, okular, kcalc, spectacle,
      klevernotes, khelpcenter
    - Core: discover (software center + update manager; binary
      `plasma-discover`), flatpak
    - System utilities: partitionmanager, font-manager, keepassxc,
      simple-scan
    - Platform services: networkmanager, bluez, bluedevil, cups,
      bluez-cups
  - Product networking = **NetworkManager** (auto-connects the wired link);
    systemd-networkd (preseed install-time stack) masked (service +
    sockets). Cold-boot verified: NM active, `ens3:connected`, SSH up,
    desktop up.
  - 818 packages; `/` used 9.8 GiB of 113 GiB; 167 desktop entries
  - pacman mirrorlist: `mirror.rackspace.com` primary,
    `mirror.arizona.edu` fallback (unchanged from 2a)
- **Relation to other baselines:** supersedes
  `ai-arch-baseline-with-desktop.qcow2` as the current known-good restore
  point; that image (and `ai-arch-baseline-with-tailscale.qcow2`,
  `ai-arch-clean-arch-baseline.qcow2`) retained for rollback.
- **Restore:**
  ```
  virsh destroy ai-arch-dev || true
  cp ai-arch-baseline-with-suite.qcow2 ai-arch-dev.qcow2
  virsh start ai-arch-dev
  ```
- **Next deltas on the working disk** (not in this image): Phase 2b
  (`40-ai-apps` — awaits D3/D4/D5); D6 decided 2026-08-27 (code
  editor/IDE omitted entirely — none bundled), see
  `docs/AI-ARCH-DESKTOP.md`.
