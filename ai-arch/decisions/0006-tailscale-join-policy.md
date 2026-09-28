# 0006: Tailscale join = owner one-off action

Date: 2026-08-24 (ratified at T0/T1, 2026-08-25)

## Context

Owner access from anywhere is required with NO host firewall change (Tailscale
is user-space; libvirt NAT untouched). Auth keys are secrets, and
client-managed (OAuth) `tskey-client-...` keys were found to be rejected for a
plain node join (tag-permission policy) — a regular `tskey-auth-...` key is
required.

## Decision

- The preseed installs Tailscale (official repo package) and enables
  `tailscaled`, but does NOT join. Joining takes a one-off `tskey-auth` key
  that the owner passes via an SSH session; the key is never written to disk,
  the VM, or git, and is never baked into the preseed.
- `--hostname=ai-arch-dev` keeps the tailnet identity stable across reinstalls.
- The lab VM is joined (`100.120.185.70`, verified). Build VMs are joined only
  if the owner wants (T3); otherwise they are torn down.

## Consequences

- The repo stays publishable; no secret enters the pipeline.
- Each new node costs the owner one ~2-minute manual step (`docs/NETWORKING.md`).
- Revisit if the image becomes a product: key injection via a secure channel at
  build time.
