# 0005: Build pipeline design (`build-ai-arch-vm.sh`)

Date: 2026-08-25 (T1)

## Context

Phase 1 requires a reproducible VM from a clean host: one script + one frozen
preseed. The host is TCG (slow), IP assignment is dynamic (dnsmasq), and the
lab VM must never be touched by a build run.

## Decision

- Six fail-fast, fully-logged phases: preflight → ISO verify (sha256 vs mirror
  + GPG; downloads if absent) → render per-build artifacts → install
  (`archinstall --silent` in the ISO env, polled via a done-file) → disk-boot
  switch → 15-check verify battery with a written report. On error: phase name +
  serial-log tail.
- IP-agnostic: the VM's address is always resolved from the libvirt `default`
  network lease (`virsh net-dhcp-leases`), never hardcoded.
- Per-run unique MAC (epoch-derived under the `52:54:00:12` prefix) so stale
  dnsmasq leases can never create ambiguity across re-runs.
- All rendered artifacts land in gitignored `build/<name>/`; the repo holds only
  the recipe.
- Name protection: the lab VM name (`ai-arch-dev`) is refused as a build target.
- The preseed is frozen (T0); the build only renders a hostname variant.

## Consequences

- Proven end-to-end by the T2 throwaway build (15/15 verify PASS).
- Each build creates a fresh domain; `--teardown`/`--clean` reclaim it.
- Generous timeouts by design (install up to 4 h on TCG).
- `--keep-nvram` undefine is required for pflash domains (libvirt 8.0).
