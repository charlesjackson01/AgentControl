# Snapshot: ai-arch-baseline-with-tailscale

- **File:** `ai-arch-baseline-with-tailscale.qcow2` (3.7 GB)
- **Source:** `ai-arch-dev.qcow2` copied while VM `shut off` (cold copy, byte-identical — verified by SHA256 match)
- **SHA256:** `9b100512d8ef5c8e25864525dc260f6aa8af2f8b5436d9d8244819d65f16a160` (both files)
- **Taken:** 2026-08-26 ~13:17 UTC
- **State of this image:**
  - Arch Linux (2026.08.01 ISO, Phase 0 preseed install), kernel `7.1.9-arch1-2`
  - Boot: systemd-boot on ESP, disk boot (no CDROMs in definition)
  - 332 packages; `/` used 2.2 GiB of 113 GiB
  - Access: owner ed25519 key authorized for `archdev` + `root`;
    passwordless sudo via `/etc/sudoers.d/ai-arch` (plus legacy `00_archdev`)
  - Tailscale `1.102.3-1`, `tailscaled` enabled + active; joined as
    `ai-arch-dev` @ `100.120.185.70`
  - Time: `systemd-timesyncd` active + enabled (verified post-boot)
  - Network: `192.168.122.50/24` (libvirt default NAT)
- **Relation to other baselines:** superseded by
  `ai-arch-baseline-with-desktop.qcow2` (Phase 2a) as the current known-good
  restore point; this image and `ai-arch-clean-arch-baseline.qcow2` are
  retained for pre-2a / pre-access rollback.
- **Restore:**
  ```
  virsh destroy ai-arch-dev || true
  cp ai-arch-baseline-with-tailscale.qcow2 ai-arch-dev.qcow2
  virsh start ai-arch-dev
  ```
- **Next deltas on the working disk** (not in this image): Phase 2 profile
  layers (see `docs/LAYERS.md`).
