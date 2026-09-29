# AI-Arch

A dedicated, reproducible private **Hermes Agent** VM on Arch Linux — the
agent's home base: gateway, sessions, memory, skills, cron, and headless browser
all live in the VM, while model inference stays on the host's `llama-server`
(reached over LAN/Tailscale).

**Phase 0 (done):** a clean, disposable, remotely-accessible Arch Linux VM
(`ai-arch-dev`) as the development lab. **Phase 2
(dedicated Hermes VM):** the same pipeline now builds a headless VM that is a
self-contained Hermes Agent home base — the agent runtime, its gateway service,
and headless browser, with client access to the host's `llama-server` (inference
stays on the host's 3090). The desktop direction (KDE Plasma) is shelved and
recoverable in `profile/layers-archived/`. The VMs
are *disposable* — the durable product is everything else in this repo: preseed,
scripts, configs, docs, snapshot, and the build system.

## Layout

| Path | Purpose |
|---|---|
| `preseed/archinstall-config.json` | Frozen unattended archinstall config (the install recipe, T0). Reproducible VM = `scripts/build-ai-arch-vm.sh` + this file. |
| `preseed/archinstall-creds.json` | Install-time credentials (`!`-prefixed fields = secrets; **never commit secrets**). |
| `scripts/` | `build-ai-arch-vm.sh` (end-to-end unattended build), `apply-profile.sh` (apply profile layers to a running VM), `validate-preseed.py` (preseed schema/geometry check), `bootstrap-access.sh` (one-time access for VMs not built from the preseed); superseded recon scripts under `scripts/legacy/`. |
| `vms/` | libvirt XML, OVF images, seed-ISO sources, snapshot backup + state note, serial logs. |
| `profile/layers/` | Ordered `install.sh` + `verify.sh` layers. **Active set: 10-devtools, 20-ai-client, 30-hermes** (the Hermes home base). Desktop layers (30-desktop, 31-desktop-apps, 32-desktop-theme) shelved in `profile/layers-archived/` — see `docs/LAYERS.md`. |
| `benchmarks/` | Logged benchmarks (first: 2026-08-26, client-side vs the host's llama.cpp server). |
| `iso/` | Downloaded Arch ISO + GPG/SHA256 verification evidence. |
| `recon/` | Host probing + archinstall source notes from build-out. |
| `state/` | Host state captures (system, storage, services, toolchain) taken at build-out. |
| `decisions/` | Architecture decision records (ADRs). |
| `build/` | (gitignored) per-build rendered artifacts, logs, verify reports: `build/<name>/`. |
| `weblog/` | (Deprioritized) live-install web dashboard experiment — not part of Phase 0. |
| `docs/` | VM, networking, access, runbook docs. |

## The VM in one paragraph

`ai-arch-dev`: QEMU+libvirt 8.0, **TCG (no KVM)** on a 32-core EPYC host,
4 vCPU, 8 GiB RAM, 120 GiB qcow2, OVMF (4 MB pflash) UEFI, `systemd-boot` on a
512 MiB ESP, ext4 root + 4 GiB swap, `virtio-net` on libvirt `default` NAT
(`192.168.122.50/24`), DHCP via NetworkManager, systemd-timesyncd.
**Phase 2** layers the VM into a dedicated Hermes home base: `10-devtools`
(core toolchain), `20-ai-client` (client access to the host `llama-server`), and
`30-hermes` (Hermes Agent runtime + gateway systemd service + headless Chromium
browser, installed as `archdev` and pointed at the host endpoint). The KDE Plasma
desktop direction is shelved in `profile/layers-archived/` (recoverable).
SSH: key-only in practice (owner ed25519 key); `archdev` (uid 1000, wheel) with
**passwordless sudo**; root login `prohibit-password` with owner key.
Tailscale 1.102.3 installed + `tailscaled` enabled — **joined the tailnet as
`100.120.185.70`** (owner SSH over tailnet verified).

## Quick start

```bash
# bring the VM up
virsh start ai-arch-dev            # ~30-60s to network (TCG)
# access (owner key, no password)
ssh -i ~/.ssh/ai-arch-dev_ed25519 archdev@192.168.122.50
```

Rebuild a fresh VM from scratch (unattended, end-to-end proven):

```bash
scripts/build-ai-arch-vm.sh --name <domain>
# 7 phases: preflight → ISO verify (sha256+GPG) → render → archinstall --silent
# → disk boot → profile layers → 15-check verify; artifacts in gitignored build/<domain>/
```

(Manual path: fetch+verify ISO per `iso/ISO-VERIFICATION.md`, attach, run
archinstall with `preseed/archinstall-config.json` — see `docs/VM.md` for the
full lifecycle, incl. the ISO-chroot pattern used for offline-ish maintenance.)

## Status

- [x] Phase 0: clean Arch VM built unattended, verified, documented, baselined, committed
- [x] Tailnet join: `ai-arch-dev` on the tailnet at `100.120.185.70` (`docs/NETWORKING.md`)
- [x] Phase 1: frozen preseed (T0) + `build-ai-arch-vm.sh` (T1); throwaway build
      `ai-arch-buildtest` 15/15 verify PASS (T2)
- [ ] Phase 2 (in progress) — **dedicated Hermes Agent VM**
      (`decisions/0008-hermes-vm-pivot.md`): the VM is the agent's home base
      (gateway, sessions, memory, skills, cron, headless browser); inference stays
      on the host's `llama-server` (3090). Active layers: `10-devtools` +
      `20-ai-client` (host-endpoint client, proven 15/15 on the full build path,
      incl. live `ai-gen` against the host llama.cpp server) + new `30-hermes`
      (Hermes runtime @ tag v2026.9.24 + gateway service + headless Chromium,
      installed as `archdev`, pointed at the host endpoint). Desktop direction
      shelved (layers archived in `profile/layers-archived/`, recoverable).

See `ROADMAP.md` and `CHANGELOG.md`.
