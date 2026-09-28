# Snapshot: ai-arch-clean-arch-baseline

- **File:** `ai-arch-clean-arch-baseline.qcow2` (3.3 GB)
- **Source:** `ai-arch-dev.qcow2` copied while VM `shut off` (cold copy, byte-identical — verified by SHA256 match)
- **Taken:** 2026-08-23 ~21:48 (host local time)
- **State of this image:**
  - Clean Arch Linux 2026.08.01 install from preseed `preseed/archinstall-config.json` (install run 3, "Installation completed without any errors")
  - Bootloader: systemd-boot on ESP (`/boot/efi`), boots via `boot dev='hd'`
  - ISOs detached from VM definition; VM boots from local disk
  - Users: `archdev` (uid 1000, wheel, password via preseed creds) — NO key auth yet
  - SSH: password auth only (root + archdev); no authorized_keys installed
  - Network: static `192.168.122.50/24` (libvirt default network, DHCP host reservation for MAC `52:54:00:12:34:56`)
  - Tailscale: NOT installed (added after this snapshot)
  - Packages: openssh, git, curl (per preseed)
- **Restore:**
  ```
  virsh destroy ai-arch-dev || true
  cp ai-arch-clean-arch-baseline.qcow2 ai-arch-dev.qcow2
  virsh start ai-arch-dev
  ```
- **Next deltas on the working disk** (not in this image):
  1. root key auth (owner ed25519) + archdev passwordless sudo
  2. Tailscale install + tailnet join
