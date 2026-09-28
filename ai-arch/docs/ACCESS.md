# Access

## TL;DR (today)

```bash
ssh -i ~/.ssh/ai-arch-dev_ed25519 archdev@192.168.122.50   # daily access
sudo -n true   # passwordless sudo inside — OK
```

- **User:** `archdev` (uid 1000, groups `archdev, users, wheel`), password set at
  install (in `preseed/archinstall-creds.json` — not documented here, never in
  this repo's docs), but **key auth is the norm**.
- **Owner key:** `~/.ssh/ai-arch-dev_ed25519` (comment `ai-arch-dev-owner`);
  authorized on both `archdev` and `root`.
- **Root:** `PermitRootLogin prohibit-password` → key-only for root.
- **sudo:** passwordless for `archdev` via a drop-in in `/etc/sudoers.d/`
  (lab VM: historical `ai-arch`; preseed/bootstrap builds: `archdev`).

## How access was provisioned (reproducible)

1. **Install time (preseed):** `custom_commands` in
   `preseed/archinstall-config.json` (run via `arch-chroot` by archinstall):
  - owner pubkey → `/home/archdev/.ssh/authorized_keys` (700/600, owned 1000)
  - owner pubkey → `/root/.ssh/authorized_keys`
  - `/etc/sudoers.d/archdev` → `archdev ALL=(ALL:ALL) NOPASSWD: ALL`
  - Tailscale: official repo package + `tailscaled` enabled (join: owner one-off)
2. **This VM (already installed):** same three items applied via the ISO-chroot
   pattern (see `docs/VM.md`), 2026-08-24. Verified: `ssh archdev@…` BatchMode
   key-only OK; `sudo -n true` OK; root key-only OK.

## One-time bootstrap script

`scripts/bootstrap-access.sh` — idempotent, takes the owner-pubkey path as $1,
run as root **inside** the VM. Used for any VM that wasn't built with the
preseed custom_commands (or to re-assert access after a fresh install):

```bash
scp -i ~/.ssh/ai-arch-dev_ed25519 ~/.ssh/ai-arch-dev_ed25519.pub archdev@VM:/tmp/
scp -i ~/.ssh/ai-arch-dev_ed25519 ai-arch/scripts/bootstrap-access.sh archdev@VM:/tmp/
ssh -i ~/.ssh/ai-arch-dev_ed25519 archdev@VM 'sudo bash /tmp/bootstrap-access.sh /tmp/ai-arch-dev_ed25519.pub'
```

## Tailscale

See `docs/NETWORKING.md` — daemon installed and enabled; **node joined the
tailnet as `100.120.185.70`** (auth key used once via SSH session, never stored
in this repo).

## Security posture

- No password auth from the network in practice (owner uses keys; password
  exists as fallback for first-boot/console recovery).
- Host approval gate blocks piping sudo passwords into commands — access is
  intentionally key-based so no secret ever flows through the agent.
- Secrets live only in `preseed/archinstall-creds.json` (gitignored) and the
  owner's keypair (outside the repo).
