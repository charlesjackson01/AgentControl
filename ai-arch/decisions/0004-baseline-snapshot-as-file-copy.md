# 0004: Baseline snapshot as a cold file copy

Date: 2026-08-24

## Context

A durable, portable "known-good" state of the lab VM is needed that survives
host changes and is trivial to reason about.

## Decision

Baseline = a cold, byte-identical copy of the qcow2 (SHA256-verified) taken
BEFORE Tailscale + the access bootstrap: `vms/ai-arch-clean-arch-baseline.qcow2`
+ state note (`vms/SNAPSHOT-ai-arch-clean-arch-baseline.md`). Roll back = stop
the VM, replace `ai-arch-dev.qcow2` with the copy, start. Libvirt internal
snapshots exist but are not the durable artifact.

## Consequences

- Rollback is simple and independent of libvirt snapshot state.
- The baseline predates Tailscale + bootstrap — re-apply access after a
  rollback via `scripts/bootstrap-access.sh`.
- Multi-GB copies stay out of git (gitignored).
