# Snapshot: ai-arch-baseline-with-theme

- **File:** `ai-arch-baseline-with-theme.qcow2`
- **Source:** `ai-arch-dev.qcow2` copied while VM `shut off` (cold copy,
  byte-identical — verified by SHA256 match)
- **SHA256:** `66d0efd2c43365f583407531c42a94432372bc409b2ca0f84dbda13a4052d1e8`
  (both files)
- **Taken:** 2026-08-27 ~09:21 UTC (after Phase 2a3, AI-Arch visual identity)
- **State of this image:**
  - Everything in `SNAPSHOT-ai-arch-baseline-with-suite.md` (Phase 2a + 2a2)
  - Phase 2a3 profile layer `32-desktop-theme` applied (file drops only,
    no new packages — still 818):
    - AIArch color scheme (dark; charcoal + muted cyan; window background
      18,22,27; accent `#40bedc`) at
      `/usr/share/color-schemes/AIArch.colors`; made the live default by
      `[General] ColorScheme=AIArch` in `/etc/xdg/kdeglobals` (system-wide —
      the existing user's `kdeglobals` has no such key, so this is what the
      session resolves) plus a per-user `kdedefaults` entry (covers users
      created after the layer)
    - `ai-arch` KWin aurorae QML decoration (dark titlebar, thin border,
      cyan accent) at `/usr/share/kwin/decorations/ai-arch`; `kwinrc`
      selects `library=org.kde.kwin.aurorae`, `theme=ai-arch`
    - SHA256-pinned wallpaper
      (`12cc0e7a3051febdbb64b78b6fe349e5461034106001774ff9e1bab39e7b37ac`)
      at `/usr/share/wallpapers/ai-arch`; set on the Plasma desktop via
      `[Containments][1][Wallpaper][org.kde.image][General]
      Image=file://…` (the Plasma 6.7 key location — a Plasma-5-style key in
      the containment is silently ignored); SDDM login background via the
      `ai-arch` SDDM theme (breeze copy with `theme.conf` pointing at the
      wallpaper) + `/etc/sddm.conf.d/theme.conf`
  - Verified on the lab VM: wallpaper (desktop screenshot vs pinned image,
    center-region Pearson correlation 1.00000), KWin decoration (titlebar
    [26 31 38], cyan accent row), color scheme (in-app palette exactly
    matches the AIArch `.colors` values: 14,17,20 / 18,22,27 / 20,24,30 /
    64,190,220). Note: a Qt app only picks up the KDE color scheme when
    launched with `QT_QPA_PLATFORMTHEME=kde6` (normal session launches have
    it; ad-hoc `sudo -u` launches must set it or render with the light
    default palette)
- **Lab caveat (TCG-only host):** the desktop locks after ~5 min of
  input-based idle (a locked screen renders black; a new SSH/TTY session on
  the seat can also trigger a lock). Recovery: `sudo systemctl restart sddm`
  from SSH. For long visual-verification windows, run the uinput keepalive —
  see `docs/RUNBOOK.md` ("Headless lab VM: idle lock + keepalive",
  `tools/keepalive.c`).
- **Relation to other baselines:** supersedes
  `ai-arch-baseline-with-suite.qcow2` as the current known-good restore
  point; that image (and `ai-arch-baseline-with-desktop.qcow2`,
  `ai-arch-baseline-with-tailscale.qcow2`,
  `ai-arch-clean-arch-baseline.qcow2`) retained for rollback.
- **Restore:**
  ```
  virsh destroy ai-arch-dev || true
  cp ai-arch-baseline-with-theme.qcow2 ai-arch-dev.qcow2
  virsh start ai-arch-dev
  ```
  Boot is ~3–4 min on TCG; wait for the desktop, then confirm via SSH
  `pgrep -x plasmashell`.
- **Next deltas on the working disk** (not in this image): none yet;
  Phase 2b (`40-ai-apps` — awaits D3/D4/D5) is next.
