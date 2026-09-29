# 0001: Run everything on TCG (no KVM)

Date: 2026-08-23

## Context

The host exposes no usable `/dev/kvm` (probed extensively; see `recon/probe*.txt`).
QEMU can only run with TCG software emulation on a 10-core EPYC.

## Decision

Accept TCG as the build/run engine: `domain type="qemu"`, CPU model EPYC
(match=exact, fallback=forbid). Size timeouts for it (ISO env up to 30 min,
install 1–3 h, disk boot up to 30 min). Do not block the project on a host change.

## Consequences

- Builds are slow but fully unattended and reproducible (proven by the T2 build).
- A future KVM-capable host works with one knob changed (`type='kvm'`); the
  pipeline is otherwise hardware-agnostic.
- Never conclude a VM is "down" before 2 minutes of TCG boot time.
