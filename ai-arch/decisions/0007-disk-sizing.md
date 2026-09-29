# 0007: Disk sizing — keep 120 GiB single disk for now

Date: 2026-08-26

## Context

The Phase 1 build pins a 120 GiB qcow2 (512 MiB ESP + 4 GiB swap + ~115 GiB
ext4 root). The Phase 1 roadmap left sizing open ("a minimal AI-dev image may
want 60–80 GiB + data disk"). AI workloads add big, variable loads: torch
installs, model files (0.5–20+ GiB each), datasets — while the base system
uses ~2–6 GiB.

## Decision

Keep the 120 GiB single disk for Phase 2. Revisit once the profile's real
usage is measured (baseline note records 2.2 GiB used pre-layers). When
variable AI data (models/datasets) approaches ~80 GiB, add a separate virtio
data disk (e.g. 200 GiB) mounted at `/data` and point model/dataset paths
there, keeping the base image small and reproducible.

## Consequences

- No preseed/build changes now: single device, simple GPT layout, gpt-auto
  swap, existing `partitions-3` verify check stays valid.
- Reversible: a data disk can be attached to an existing VM without a
  reinstall (`virsh attach` + mkfs + fstab entry).
- A two-disk variant would add a preseed partition block + a new verify
  check when introduced; deferred until actually needed.
