# Roadmap

## Phase 0 — Clean lab VM ✅ (2026-08-23/24)

Goal: a clean, disposable, remotely-accessible Arch VM as the dev lab.
**Done:** unattended archinstall build from preseed; reboot-from-disk verified;
key-only SSH + passwordless sudo; Tailscale installed and **joined the tailnet
(`ai-arch-dev` @ `100.120.185.70`, owner SSH over tailnet verified)**;
baseline qcow2 snapshot; docs; this git repo.

Exit criteria (met):
- [x] VM boots from installed disk, no ISOs attached
- [x] `ssh archdev@192.168.122.50` with key only (no password)
- [x] health: systemd-boot, timesyncd, sshd, wheel/sudo, correct IP/hostname
- [x] tailnet access live (node `ai-arch-dev` on tailnet, `100.120.185.70`;
  owner ping + key-only SSH from host verified)
- [x] reproducible: preseed `custom_commands` carry the same access + Tailscale setup
- [x] baseline snapshot + state note
- [x] documented + committed

## Phase 1 — Reproducible build system 🟡 (2026-08-25)

- [x] T0: freeze self-sufficient preseed — verified against the ISO's actual
      archinstall 4.4 source (loop-mounted airootfs.sfs), not the TUI; owner key
      injected for root + archdev; Tailscale via official repo package
      (`scripts/validate-preseed.py` checks schema/geometry)
- [x] T1: `scripts/build-ai-arch-vm.sh` — end-to-end (preflight → ISO sha256+GPG
      verify → render per-build artifacts → archinstall --silent → disk-boot
      switch → 15-check verify); IP-agnostic (dnsmasq lease), per-run unique MAC,
      fail-fast + fully logged, lab-VM name protected
- [x] T2: throwaway domain `ai-arch-buildtest` proves the preseed is
      self-sufficient: unattended install without errors, disk boot, **15/15
      verify PASS**, owner key authenticates as archdev AND root
- [x] Tailnet join policy: post-boot owner action with a one-off `tskey-auth`
      key, never stored (decisions/0006); not baked into the preseed
- [ ] T3: tailnet-join a build VM when needed (owner one-off key;
      `docs/NETWORKING.md`)
- [ ] qcow2 sizing/optimization (currently 120 GiB; a minimal AI-dev image may
      want 60–80 GiB + data disk)

## Phase 2 — Dedicated Hermes Agent VM (the pivot)

Pivot decision: `decisions/0008-hermes-vm-pivot.md` (2026-09-26). The VM is no
longer a general AI-focused desktop distro — it becomes a **dedicated private
Hermes Agent home base**: the agent runtime, gateway service, sessions, memory,
skills, cron, and headless browser all live in the VM. Model inference stays on
the host's existing `llama-server` (3090, OpenAI-compatible), reached over
LAN/Tailscale via `20-ai-client`. The KDE Plasma desktop direction is **shelved**
— its layers move to `profile/layers-archived/` (recoverable, not deleted).

- [x] Layered profile mechanism: `profile/layers/` (ordered install.sh +
      verify.sh), applied by `build-ai-arch-vm.sh` phase 6/7 (fail-fast,
      per-layer PASS/FAIL in the verify report) and `scripts/apply-profile.sh`
      (lab-VM iteration loop) — `docs/LAYERS.md`
- [x] `10-devtools`: rust 1.98, python 3.14 (+ venv conventions), gcc/cmake/make
- [x] `20-ai-client`: client access to the host's existing `llama-server`
      (endpoint config `/etc/ai-arch/llama-server.json` + stdlib `ai-gen`
      helper) — the distro does not host its own AI (owner decision
      2026-08-26); a same-day local-hosting experiment (ollama + torch venv)
      was built, benchmarked, and then removed
- [x] First benchmark: client-side timed completion, VM → host
      llama-server — `benchmarks/2026-08-26-llama-server-client-ai-arch-dev.md`
      (Qwen3.8-27B Q4_K_XL on host GPU; warm ≈44 tok/s at 64-token requests)
- [x] Build pipeline proven end-to-end with profile: throwaway
      `ai-arch-buildtest` (2026-08-26) — preseed install → disk boot →
      profile layers → 15/15 verify PASS, including a live `ai-gen`
      completion against the host llama-server
### Hermes home base

The pivot layer `30-hermes` turns the headless VM into the agent's home base.
Design and proven install path captured in `decisions/0008-hermes-vm-pivot.md`;
layer scripts in `profile/layers/30-hermes/`.

- [x] Design + proven install recipe (2026-09-26): Hermes Agent from git tag
      `v2026.9.24` (→ v0.21.5), managed Python 3.11 via `uv` (Arch ships
      3.14.7, out of `>=3.11,<3.14`), Node + headless Chromium via the repo
      monolith installer `scripts/install.sh` (self-contained: uv, Python, Node,
      `base-devel`, Arch Chromium deps via `pacman`, Playwright) — run as
      `archdev`, landing in `~/.hermes/hermes-agent` + `~/.local/bin/hermes`.
      `hermes pm` is **not** a command (corrected 0.21.4); browser is
      Node-based `agent-browser` over CDP/websockets, not Playwright Python.
- [x] Endpoint wiring: `30-hermes` reads `/etc/ai-arch/llama-server.json`
      (written by `20-ai-client`, runs first — lexicographic order) for the
      host `llama-server` `base_url`; model name is cosmetic (server serves
      whatever is loaded; do not hardcode). `context_length: 131072` (≥64K).
- [ ] Build proof: `build-ai-arch-vm.sh --name hermes-vm` → active layer set
      `10-devtools` + `20-ai-client` + `30-hermes`, target 15/15 verify PASS.
- [ ] Live verify: SSH in, real `hermes chat --oneshot -q "..."` against the
      host endpoint, and a headless-browser check — proves the VM is a working
      Hermes home base end-to-end.
- [ ] Gateway persistence: `hermes gateway install` (systemd service) +
      `loginctl enable-linger` for `archdev`, so the gateway survives with no
      login session (headless).

**Shelved (desktop direction, recoverable in `profile/layers-archived/`):**
`30-desktop` (KDE Plasma foundation), `31-desktop-apps` (everyday suite),
`32-desktop-theme` (AI-Arch visual identity). These were proven on the full
build path (15/15, all layers PASS, 2026-08-26/27); the design brief remains
`docs/AI-ARCH-DESKTOP.md`. Re-enabling any is a `git mv` back into
`profile/layers/` — no code change needed. The prior Phase 2b/2c items (AI-apps
layer `40-ai-apps`, GPU path `50-ai-gpu`) stay deferred: the agent home base
does not host its own inference or a GUI app stack.

## Phase 3 — Distribution hardening (2c)

- [ ] Release process: signed qcow2 per release tag (sha256 + GPG + build
      provenance); publish target TBD (repo has no remote yet) — D4
- [ ] Packaging: split "distribution profile" (reproducible config) from
      "lab state" (disposable VM)
- [ ] Multi-arch if/when needed (aarch64)
- [ ] Docs as the product: install guide, layer reference, threat model
- [ ] Known-to-work hardware matrix

**Not started by design** — Phase 2/3 work only begins on top of a proven
Phase 1 build.
