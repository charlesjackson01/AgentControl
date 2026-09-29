# 0003: ISO-chroot pattern for offline maintenance

Date: 2026-08-24

## Context

libguestfs is broken on this host (`virt-filesystems`/`guestfish` fail;
`virt-customize` additionally consent-gated). The installed system still needs
offline modification while the VM is down (e.g., Tailscale install, access
bootstrap).

## Decision

Maintain via the ISO environment: stop the VM; temporarily define it with the
CDROMs attached and `<boot dev='cdrom'/>`; boot the ISO env (root key-auth works
there because the install-time key injection persists in the ISO's root `.ssh`);
`mount /dev/vda3 /mnt; mount /dev/vda1 /mnt/boot` + bind `dev/proc/sys`; work
under `/mnt` (write a static `nameserver 192.168.122.1` into
`/mnt/etc/resolv.conf` before any pacman/curl — the chroot has no DNS, then
restore the stub-resolv.conf symlink); unmount, destroy, and redefine the clean
XML from `vms/`.

## Consequences

- Works with no new host dependencies.
- Slightly ceremonial, but fully documented (`docs/VM.md`, `docs/RUNBOOK.md`).
- The canonical domain XML is always the clean (no-CDROM) file in `vms/`.
