# Runbook

Day-to-day operations for `ai-arch-dev`. Owner key: `~/.ssh/ai-arch-dev_ed25519`.

## Start / stop

```bash
virsh start ai-arch-dev      # ~30-90s to network (TCG)
virsh shutdown ai-arch-dev   # or: virsh destroy (hard)
virsh domstate ai-arch-dev
```

## SSH in

```bash
ssh -i ~/.ssh/ai-arch-dev_ed25519 archdev@192.168.122.50
ssh -i ~/.ssh/ai-arch-dev_ed25519 root@192.168.122.50      # key-only root
```

## Tailnet join (one-time, owner)

```bash
# 1) get a one-off auth key (admin console or: tailscale setAuthKey --expiration 24h)
# 2) on the VM:
sudo tailscale up --auth-key=<TSKEY> --hostname=ai-arch-dev
# 3) verify:
sudo tailscale status
ssh -i ~/.ssh/ai-arch-dev_ed25519 archdev@<tailnet-ip>
```

## Health check

```bash
ssh -i ~/.ssh/ai-arch-dev_ed25519 archdev@192.168.122.50 '
  uptime; free -h; df -h /;
  systemctl is-active sshd timesyncd tailscaled;
  sudo -n true && echo SUDO_OK'
```

## Console (serial, when SSH is down)

`virsh console ai-arch-dev` — needs a controlling TTY. Serial log:
`vms/ai-arch-dev-serial.log` (root:root 600 by design).

## Maintenance on the installed disk (ISO-chroot pattern)

When you must change the installed system while it's down (and libguestfs is
unavailable on this host):

```bash
# 1) stop VM, attach ISOs with cdrom-first boot (see docs/VM.md for the XML steps)
virsh shutdown ai-arch-dev
# (attach detach-sda.xml + detach-sdb.xml, set <boot dev='cdrom'/>, define, start)
# 2) wait for ISO env (root key-auth), then:
ssh -i ~/.ssh/ai-arch-dev_ed25519 root@192.168.122.50 '
  mount /dev/vda3 /mnt; mount /dev/vda1 /mnt/boot
  for d in dev dev/pts proc sys; do mount --bind /$d /mnt/$d; done
  # NOTE: for pacman/curl inside chroot first do:
  #   printf "nameserver 192.168.122.1\n" > /mnt/etc/resolv.conf
  ... work under /mnt ...
  umount -R /mnt'
# 3) restore clean definition:
virsh destroy ai-arch-dev
virsh define ai-arch-dev.xml && virsh start ai-arch-dev
```

## Roll back to baseline

```bash
virsh destroy ai-arch-dev || true
cp vms/ai-arch-baseline-with-theme.qcow2 vms/ai-arch-dev.qcow2   # current known-good (2a3: visual identity)
# earlier states:
#   cp vms/ai-arch-baseline-with-suite.qcow2 vms/ai-arch-dev.qcow2   # 2a2
#   cp vms/ai-arch-baseline-with-desktop.qcow2 vms/ai-arch-dev.qcow2 # 2a
#   cp vms/ai-arch-baseline-with-tailscale.qcow2 vms/ai-arch-dev.qcow2
#   cp vms/ai-arch-clean-arch-baseline.qcow2 vms/ai-arch-dev.qcow2
virsh start ai-arch-dev
```

(See `vms/SNAPSHOT-*.md` for the exact state of each baseline. The
clean-arch baseline predates Tailscale + the in-VM access bootstrap;
re-apply access via `scripts/bootstrap-access.sh` if you rolled back to it.)

## Headless lab VM: idle lock + keepalive

The desktop locks after ~5 min of **input-based** idle (characterized
2026-08-27); a locked screen renders ~100% black and blocks screenshot
verification. A new SSH/TTY session on the seat can also trigger a lock.
Recovery: `sudo systemctl restart sddm` from SSH (or `virsh destroy`).

For long visual-verification windows, run a uinput keepalive that taps
`KEY_LEFTALT` every 30 s (resets the idle timer, disturbs nothing):

```bash
# build + run (lab VM), as a transient unit:
scp tools/keepalive.c archdev@192.168.122.50:/tmp/
ssh -i ~/.ssh/ai-arch-dev_ed25519 archdev@192.168.122.50 '
  gcc -O2 -o /tmp/keepalive /tmp/keepalive.c &&
  sudo systemd-run --unit=aiarch-keepalive /tmp/keepalive'
# stop when done:
ssh ... 'sudo systemctl stop aiarch-keepalive'
```

Note: `virsh screenshot` from the host works without the VM's cooperation;
take screenshots from the host, not over SSH, during verification windows.

## Rebuild from scratch

Preferred: `scripts/build-ai-arch-vm.sh --name <domain>` — unattended end-to-end
(ISO verify → install → disk boot → 15-check verify). Manual path:

1. Fetch/verify ISO per `iso/ISO-VERIFICATION.md`
2. Attach ISOs (cdrom boot), boot ISO env
3. `archinstall --config preseed/archinstall-config.json`
4. Detach ISOs per `docs/VM.md`, boot from disk, verify per health check above
