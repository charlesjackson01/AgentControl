# Snapshot: ai-arch-baseline-with-desktop

- **File:** `ai-arch-baseline-with-desktop.qcow2`
- **Source:** `ai-arch-dev.qcow2` copied while VM `shut off` (cold copy,
  byte-identical — verified by SHA256 match)
- **SHA256:** `33f281ef436ded7716169bfe887c034b68a712b4d3a71bbbf772dd88c5d8fabc`
  (both files)
- **Taken:** 2026-08-26 ~24:10 UTC (after Phase 2a)
- **State of this image:**
  - Everything in `SNAPSHOT-ai-arch-baseline-with-tailscale.md` (Arch
    2026.08.01 preseed install, tailscale joined, key access, timesyncd)
  - Phase 2 profile layers applied: `10-devtools`, `20-ai-client`
    (endpoint `/etc/ai-arch/llama-server.json` + stdlib `ai-gen`),
    `30-desktop` (KDE Plasma 6.7.4: plasma-workspace + plasma-desktop,
    firefox/dolphin/konsole/systemsettings/plasma-systemmonitor)
  - Desktop: SDDM autologin for `archdev`, `graphical.target` default,
    Wayland session (`Session=plasma`; `plasmax11` remains available);
    verified live post-boot: session on tty1/seat0, `plasmashell` running
    (kwin runs as a user service on Plasma 6)
  - 636 packages; `/` used 8.0 GiB of 113 GiB
  - pacman mirrorlist: `mirror.rackspace.com` primary,
    `mirror.arizona.edu` fallback (2a mirror-resilience fix)
- **Relation to other baselines:** supersedes
  `ai-arch-baseline-with-tailscale.qcow2` as the current known-good restore
  point; that image (and `ai-arch-clean-arch-baseline.qcow2`) is retained
  for pre-2a rollback.
- **Restore:**
  ```
  virsh destroy ai-arch-dev || true
  cp ai-arch-baseline-with-desktop.qcow2 ai-arch-dev.qcow2
  virsh start ai-arch-dev
  ```
- **Next deltas on the working disk** (not in this image): Phase 2b
  (`40-ai-apps` — awaits D3/D4/D5), see `docs/AI-ARCH-DESKTOP.md`.
