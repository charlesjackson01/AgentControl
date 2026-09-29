# VM — ai-arch-dev

## Spec (as deployed, 2026-08-23/24)

| Item | Value |
|---|---|
| Hypervisor | QEMU via libvirt 8.0, `domain type="qemu"` (TCG — **no KVM** on this host) |
| CPU model | `EPYC` (custom, match=exact, fallback=forbid), 4 vCPU (static) |
| Memory | 8 GiB |
| Machine | `pc-i440fx-6.2` |
| Firmware | OVMF UEFI, 4 MB pflash (`OVMF_CODE_4M.fd` + per-domain `OVMF_VARS-ai-arch-dev.fd`) |
| Boot | `<boot dev='hd'/>`; `systemd-boot` on ESP |
| Disk | `vms/ai-arch-dev.qcow2`, 120 GiB, virtio, SATA controller |
| Partitions | `vda1` 512 MiB vfat `/boot` (ESP) · `vda2` 4 GiB swap · `vda3` ext4 `/` (113 GiB used 2.1 GiB at baseline) |
| Network | `virtio-net` → libvirt `default` NAT bridge; DHCP (systemd-networkd); static-assigned lease `192.168.122.50` (host dnsmasq) |
| Serial | isa-serial port 0 → `vms/ai-arch-dev-serial.log` (console fallback; needs a controlling TTY: `virsh console` from a pty) |
| Time | systemd-timesyncd (active) |
| OS | Arch Linux (2026.08.01 ISO), kernel `7.1.9-arch1-2` |

## Lifecycle

**Install (done, reproducible):** Arch netboot ISO + cloud-seed ISO attached as
`hda`/`hdb`; `archinstall --config preseed/archinstall-config.json` run inside
the ISO environment as root (key-auth). The frozen preseed's `custom_commands`
(arch-chroot) inject: owner pubkey for `root`, owner pubkey for `archdev`
(700/600, chowned), and a passwordless-sudo drop-in
(`/etc/sudoers.d/archdev`); Tailscale is the official repo package with
`tailscaled` enabled (join is a post-boot owner action, `docs/NETWORKING.md`).
Install log: "Installation completed without
any errors." (monitored via background ssh poll, 2026-08-23 ~20:49 UTC).

**Post-install maintenance — ISO-chroot pattern:**
`libguestfs` is broken on this host (`virt-filesystems`/`guestfish` fail;
`virt-customize` is additionally consent-gated), so maintenance is done by:
1. stop VM; temporarily define with CDROMs + `<boot dev='cdrom'/>`
   (keep a clean `vms/ai-arch-dev.xml` as the canonical definition);
2. boot the ISO env (root key-auth there works because the install-time key
   injection persists in the ISO's root `.ssh`);
3. `mount /dev/vda3 /mnt; mount /dev/vda1 /mnt/boot` + bind `dev/proc/sys`;
4. work under `/mnt` (note: chroot has **no DNS** — write a static
   `nameserver 192.168.122.1` into `/mnt/etc/resolv.conf` before any
   `pacman`/`curl` inside the chroot, then restore the
   `-> /run/systemd/resolve/stub-resolv.conf` symlink);
5. unmount, `virsh destroy`, `virsh define vms/ai-arch-dev.xml`, `virsh start`.

This is how Tailscale + the access bootstrap were installed 2026-08-24.

**Detach ISOs (persistent):** edit domain XML to drop the two `<disk type='file'
device='cdrom'>` blocks and set boot order (live `detach-device` refuses CDROMs).

## Snapshot

- **Current known-good (2026-08-26):** `vms/ai-arch-baseline-with-tailscale.qcow2`
  — cold byte-identical copy (SHA256 `9b100512…f16a160`) of the lab VM **after**
  the access bootstrap + Tailscale join. State note:
  `vms/SNAPSHOT-ai-arch-baseline-with-tailscale.md`. Prefer this for rollback.
- **Baseline:** `vms/ai-arch-clean-arch-baseline.qcow2` — cold byte-identical
  copy (SHA256-verified) taken **before** Tailscale was added. State note:
  `vms/SNAPSHOT-ai-arch-clean-arch-baseline.md`. Retained as the
  pre-access/pre-Tailscale state.
- Roll back = replace `ai-arch-dev.qcow2` with the baseline copy (VM stopped)
  and start. (libvirt internal snapshots exist but were not used; the file
  copy is the durable, portable artifact.)

## Gotchas (all hit and resolved during Phase 0)

- TCG boot is slow: ~30–90 s to network; don't conclude "down" before 2 min.
- Stale `known_hosts` after each reinstall: `ssh-keygen -R 192.168.122.50`.
- In the live ISO the `archdev` user doesn't exist yet → use numeric uid (1000)
  for `chown` inside `/mnt`.
- libvirt 8.0: `<target type='isa-serial'>` breaks `start` (use `<target port='0'/>`);
  4 MB OVF needs `type='pflash'`; umask 077 makes serial logs root:root 600.
- `hostname` binary isn't in the minimal install (use `cat /etc/hostname`).
- Host `runuser` unusable by our uid; `/opt` not writable; `paramiko` absent —
  use `ssh`/`sshpass`-free key auth (owner key) for everything.
