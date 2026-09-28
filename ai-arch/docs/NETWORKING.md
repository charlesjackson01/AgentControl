# Networking

## Management network (current, works today)

- libvirt `default` NAT bridge (`virbr0`, `192.168.122.1/24`), DHCP by dnsmasq.
- VM lease: **`192.168.122.50`** (stable; dnsmasq hands out the same lease).
- Client: systemd-networkd DHCP on `enp1s0` (virtio).
- Reachable from the host only (NAT). No inbound from the LAN.
- Time: systemd-timesyncd via the host.

## Tailnet (Tailscale — JOINED ✅)

Goal: owner access to the VM from anywhere on the tailnet, **without any host
firewall change** (Tailscale is user-space; libvirt NAT is untouched).

**State (2026-08-24): JOINED ✅**
- `tailscale` 1.102.3 installed on the VM; `tailscaled` enabled + active.
- Node **`ai-arch-dev`** is on the tailnet: **`100.120.185.70`**
  (IPv6 `fd7a:115c:a1e0::cf3a:b947`), user `cjackson0520@`.
- Verified from the host over the tailnet: ping 0% loss (~30 ms) and key-only
  SSH `archdev@100.120.185.70` both work.
- Join used a regular `tskey-auth-...` key (passed via the SSH session only;
  never written to disk, the VM, or git).

### Join procedure (for rebuilds / future nodes)

```bash
# on the VM (or in chroot after starting tailscaled)
sudo tailscale up --auth-key=<tskey-auth-...> --hostname=ai-arch-dev
# verify:
sudo tailscale status | head -1      # -> 100.120.185.70  ai-arch-dev ...
```

> Key-type gotcha (hit on 2026-08-24): a `tskey-client-...` **OAuth /
> client-managed** key will NOT join a node — the server requires
> `--tags`/`--advertise-tags` with a tag on that key's permitted list, and it
> rejects any tag not on the list with `400 "invalid or not permitted"`.
> Use a **regular** auth key (console → Security → Keys → *Create auth key*)
> for plain node joins.

After the join, the VM is reachable from the tailnet at its 100.x.y.z address;
management via `192.168.122.50` remains available from the host as a fallback.

## Design notes

- No host firewall rules added/removed for this — satisfies the
  "no host firewall change" constraint.
- `--hostname=ai-arch-dev` keeps the tailnet identity stable across reinstalls.
- If/when the VM becomes the *product* image, Tailscale join should move into
  the preseed `custom_commands` (it is already staged there as a script; only
  the key is external by design — keys are never committed).
